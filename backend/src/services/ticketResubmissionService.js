import prisma from './prisma.js';
import logger from '../utils/logger.js';
import ticketService from './ticketService.js';
import customFieldService, { normalizeFieldKey } from './customFieldService.js';
import statusService from './statusService.js';
import ticketTypeService from './ticketTypeService.js';
import requesterRepository from './requesterRepository.js';
import { normalizeSubject } from './duplicateBurstService.js';
import { resolveCategoryNames } from './categoryNameResolver.js';
import { TICKET_ORIGIN, TICKET_SOURCE, ticketDisplayRef } from '../utils/ticketOrigin.js';
import { ValidationError } from '../utils/errors.js';
import {
  appendRevision, bodyToHtml, descriptionAlreadyContains, formatRevisionDate, htmlToText,
} from '../utils/descriptionRevisions.js';
// Diff-note renderers moved to the shared ticketChangeRenderer (TU-5); kept
// re-exported here for existing importers/tests.
import { renderDiffNoteHtml, renderDiffNoteText } from './ticketChangeRenderer.js';

export { renderDiffNoteHtml, renderDiffNoteText };

/**
 * API resubmission upsert (Mega 08-31 Phase PA, QA #4).
 *
 * A Power Apps / Power Automate form that is re-submitted must UPDATE the
 * existing ticket instead of creating a duplicate. Three ways to find "the
 * existing ticket", tried in order by deriveExternalRef:
 *
 *   1. `externalRef` in the body — first-class, explicit, per-RECORD key.
 *   2. Workspace bridge (`externalRefCustomFieldKey`): the ref is derived from
 *      a custom-field value the sender already posts (ws5: powerAppRecordId
 *      → key 'power_app_record_id'), stored as `pa-<value>`. Zero sender
 *      changes.
 *   3. DEPRECATED transition heuristic (`apiResubmissionMatchEnabled`, default
 *      OFF): same workspace + requester + normalized subject + Open/Pending +
 *      API-born + same API key within N days. >1 candidate ⇒ NO match (a
 *      silent wrong-ticket update is worse than a duplicate).
 *
 * applyResubmission then updates in place: description APPENDS a revision
 * block (never replaces — there is no description history), scalar fields
 * replace-if-changed through updateTicketFields, customFields MERGE with
 * auto-provision (a resubmission IS intake), a PRIVATE note carries the
 * before/after table, an audit row is written, lastRealActivityAt is bumped.
 * Status and assignedTechId are NEVER touched here; Resolved tickets are
 * reopened (unless reopenOnResubmit:false) and Closed ones are left alone —
 * the caller creates a new ticket linked related_to the old one.
 */

export const EXTERNAL_REF_MAX = 200;
export const DERIVED_REF_PREFIX = 'pa-';
const HEURISTIC_MIN_SUBJECT = 6; // mirrors duplicateBurstService's generic-subject guard
const HEURISTIC_MAX_CANDIDATES = 25;

/** Trim + length-check a caller-supplied ref. null/undefined/'' → null. */
export function normalizeExternalRef(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new ValidationError('externalRef must be a string');
  }
  const value = String(raw).trim();
  if (!value) return null;
  if (value.length > EXTERNAL_REF_MAX) {
    throw new ValidationError(`externalRef must be ${EXTERNAL_REF_MAX} characters or fewer`);
  }
  return value;
}

/** Find the custom-field value behind the configured bridge key (camelCase or snake_case spelling). */
export function customFieldValueForKey(customFields, key) {
  if (!key || !customFields || typeof customFields !== 'object' || Array.isArray(customFields)) return null;
  const want = normalizeFieldKey(key);
  if (!want) return null;
  for (const [k, v] of Object.entries(customFields)) {
    if (normalizeFieldKey(k) !== want) continue;
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s || null;
  }
  return null;
}

/** Derived (bridge) refs live in their own namespace so they never collide with explicit ones. */
export function derivedRef(value) {
  return normalizeExternalRef(`${DERIVED_REF_PREFIX}${String(value).trim()}`);
}

const MATCH_INCLUDE = {
  requester: { select: { id: true, name: true, email: true } },
  assignedTech: { select: { id: true, name: true } },
  internalCategory: { select: { id: true, name: true } },
  internalSubcategory: { select: { id: true, name: true } },
  internalGroup: { select: { id: true, name: true } },
};

class TicketResubmissionService {
  async findByExternalRef(workspaceId, ref) {
    const externalRef = normalizeExternalRef(ref);
    if (!externalRef) return null;
    return prisma.ticket.findFirst({ where: { workspaceId, externalRef }, include: MATCH_INCLUDE });
  }

  /**
   * Resolve what a create payload is really about.
   * @returns {Promise<{ref: string|null, matchedBy: string|null, ticket: object|null, ambiguous: boolean, candidates: string[]}>}
   *   ref       — the externalRef to persist on a NEW ticket (explicit or derived); null for heuristic/no-ref.
   *   matchedBy — 'external_ref' | 'custom_field_key' | 'subject_heuristic' when `ticket` is set.
   */
  async deriveExternalRef(workspaceId, body, workspace, ctx = {}) {
    const none = { ref: null, matchedBy: null, ticket: null, ambiguous: false, candidates: [] };

    // 1. Explicit key.
    const explicit = normalizeExternalRef(body?.externalRef);
    if (explicit) {
      const ticket = await this.findByExternalRef(workspaceId, explicit);
      return { ...none, ref: explicit, matchedBy: ticket ? 'external_ref' : null, ticket };
    }

    // 2. Workspace bridge: derive from a configured custom-field value.
    const bridgeKey = workspace?.externalRefCustomFieldKey || null;
    if (bridgeKey) {
      const value = customFieldValueForKey(body?.customFields, bridgeKey);
      if (value) {
        let ref = null;
        try { ref = derivedRef(value); } catch { ref = null; }
        if (ref) {
          const ticket = await this.findByExternalRef(workspaceId, ref);
          return { ...none, ref, matchedBy: ticket ? 'custom_field_key' : null, ticket };
        }
      }
    }

    // 3. Deprecated heuristic — flag-gated.
    if (workspace?.apiResubmissionMatchEnabled === true) {
      const found = await this._heuristicMatch(workspaceId, body, workspace, ctx);
      if (found.ambiguous) return { ...none, ambiguous: true, candidates: found.candidates };
      if (found.ticket) return { ...none, matchedBy: 'subject_heuristic', ticket: found.ticket };
    }
    return none;
  }

  async _heuristicMatch(workspaceId, body, workspace, ctx) {
    const miss = { ticket: null, ambiguous: false, candidates: [] };
    const needle = normalizeSubject(body?.subject);
    if (needle.length < HEURISTIC_MIN_SUBJECT) return miss;
    const email = body?.requesterEmail ? String(body.requesterEmail).trim() : null;
    if (!email) return miss;
    // Lookup only — never create a requester from a match probe.
    const requester = await requesterRepository.findByEmail(email);
    if (!requester?.id) return miss;

    const days = Math.max(1, Math.min(90, Number(workspace?.apiResubmissionMatchWindowDays) || 7));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const openLike = await statusService.statusNamesForBase(workspaceId, ['Open', 'Pending']);
    const candidates = await prisma.ticket.findMany({
      where: {
        workspaceId,
        requesterId: requester.id,
        origin: TICKET_ORIGIN.TICKETPULSE,
        source: TICKET_SOURCE.API,
        createdAt: { gte: since },
        ...(openLike.length ? { status: { in: openLike } } : {}),
        isNoise: false,
      },
      include: MATCH_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: HEURISTIC_MAX_CANDIDATES,
    });
    let matches = candidates.filter((c) => normalizeSubject(c.subject) === needle);
    if (!matches.length) return miss;

    // Same API key principal: the create audit records actorEmail
    // 'apikey:<prefix>' — a different key's tickets are never ours to update.
    const principal = ctx?.actor?.email || null;
    if (principal) {
      const created = await prisma.ticketActivity.findMany({
        where: { ticketId: { in: matches.map((m) => m.id) }, activityType: 'created' },
        select: { ticketId: true, details: true },
      });
      const owned = new Set(created.filter((a) => a?.details?.actorEmail === principal).map((a) => a.ticketId));
      matches = matches.filter((m) => owned.has(m.id));
    }
    if (!matches.length) return miss;
    if (matches.length > 1) {
      return { ticket: null, ambiguous: true, candidates: matches.map((m) => ticketDisplayRef(m)) };
    }
    return { ticket: matches[0], ambiguous: false, candidates: [ticketDisplayRef(matches[0])] };
  }

  /**
   * Apply a resubmitted payload to an existing ticket.
   * @param ticket   row from findByExternalRef / deriveExternalRef (MATCH_INCLUDE shape)
   * @param body     the raw API create body
   * @param ctx      { workspaceId, actor, apiKeyName, matchedBy, externalRef }
   * @returns {Promise<object>} { createNew:true, priorTicket, reason } for Closed / reopen-declined,
   *   otherwise { ticket, changedFields, reopened, aiRetriage, noteId, rejectedCustomFields, provisionedCustomFields }
   */
  async applyResubmission(ticket, body, ctx) {
    const { workspaceId, actor } = ctx;
    if (!ticket || ticket.workspaceId !== workspaceId) throw new ValidationError('Resubmission target is not in this workspace');
    if (ticket.origin !== TICKET_ORIGIN.TICKETPULSE) {
      // FS-born rows can't be edited through updateTicketFields — treat as "no match".
      return { createNew: true, priorTicket: ticket, reason: 'freshservice_owned' };
    }
    const base = await statusService.baseStatusOf(workspaceId, ticket.status);
    const reopenAllowed = body?.reopenOnResubmit !== false;
    if (base === 'Closed') return { createNew: true, priorTicket: ticket, reason: 'closed' };
    if (base === 'Resolved' && !reopenAllowed) return { createNew: true, priorTicket: ticket, reason: 'reopen_declined' };

    const changedFields = [];
    const diff = {}; // field → { from, to } for the note
    const fields = {};

    // ---- scalar fields: replace-if-changed
    if (typeof body?.subject === 'string' && body.subject.trim() && body.subject.trim() !== ticket.subject) {
      fields.subject = body.subject.trim();
      diff.subject = { from: ticket.subject, to: fields.subject };
    }
    if (body?.priority !== undefined && body.priority !== null) {
      const p = Number(body.priority);
      if (Number.isInteger(p) && p >= 1 && p <= 4 && p !== ticket.priority) {
        fields.priority = p;
        diff.priority = { from: ticket.priority, to: p };
      }
    }
    const rawType = body?.ticketType ?? body?.type;
    if (rawType) {
      const normalizedType = await ticketTypeService.normalizeTypeName(workspaceId, rawType);
      if (normalizedType !== ticket.ticketType) {
        fields.ticketType = normalizedType;
        diff.ticketType = { from: ticket.ticketType, to: normalizedType };
      }
    }
    if (body?.category !== undefined || body?.subcategory !== undefined) {
      const resolved = await resolveCategoryNames(workspaceId, body.category, body.subcategory);
      const catChanged = (resolved.categoryId ?? null) !== (ticket.internalCategoryId ?? null);
      const subChanged = (resolved.subcategoryId ?? null) !== (ticket.internalSubcategoryId ?? null);
      if (catChanged || subChanged) {
        fields.internalCategoryId = resolved.categoryId ?? null;
        fields.internalSubcategoryId = resolved.subcategoryId ?? null;
        diff.category = {
          from: [ticket.internalCategory?.name, ticket.internalSubcategory?.name].filter(Boolean).join(' › ') || null,
          to: [resolved.categoryName, resolved.subcategoryName].filter(Boolean).join(' › ') || null,
        };
      }
    }
    if (body?.groupId !== undefined) {
      const next = body.groupId === null ? null : String(body.groupId);
      const cur = ticket.groupId === null || ticket.groupId === undefined ? null : String(ticket.groupId);
      if (next !== cur) {
        fields.groupId = body.groupId === null ? null : Number(body.groupId);
        diff.group = { from: ticket.group?.name || cur, to: next };
      }
    }
    if (body?.internalGroupId !== undefined) {
      const next = body.internalGroupId === null ? null : Number(body.internalGroupId);
      if (next !== (ticket.internalGroupId ?? null)) {
        fields.internalGroupId = next;
        diff.internalGroup = { from: ticket.internalGroup?.name || ticket.internalGroupId || null, to: next };
      }
    }
    if (Array.isArray(body?.ccEmails)) {
      const next = [...new Set(body.ccEmails.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];
      const prev = (Array.isArray(ticket.ccEmails) ? ticket.ccEmails : []).map((e) => String(e).toLowerCase());
      const same = prev.length === next.length && prev.every((e) => next.includes(e));
      if (!same) {
        fields.ccEmails = next;
        diff.ccEmails = { from: prev.join(', ') || null, to: next.join(', ') || null };
      }
    }

    // ---- description: APPEND a revision block (never replace) unless resubmitStrategy:'replace'
    let descriptionChanged = false;
    if (typeof body?.description === 'string' && body.description.trim()) {
      const newText = htmlToText(bodyToHtml(body.description)) || body.description.trim();
      const currentText = ticket.descriptionText || htmlToText(ticket.description || '');
      if (!descriptionAlreadyContains(currentText, newText)) {
        descriptionChanged = true;
        const replace = body.resubmitStrategy === 'replace';
        const label = `Resubmitted ${formatRevisionDate(new Date())} UTC via API key "${ctx.apiKeyName || actor?.name || 'api'}"`;
        fields.description = replace ? body.description : appendRevision(ticket.description, { label, body: body.description });
        diff.description = { from: replace ? '(replaced)' : '(previous text kept)', to: replace ? '(new text)' : '(new revision appended)' };
      }
    }

    // ---- terminal handling: Resolved → reopen to the workspace's default Open status
    let reopened = false;
    if (base === 'Resolved') {
      const openNames = await statusService.statusNamesForBase(workspaceId, 'Open');
      const target = openNames[0] || 'Open';
      await ticketService.changeStatus(ticket.id, workspaceId, target, actor);
      reopened = true;
      changedFields.push('status');
      diff.status = { from: ticket.status, to: target };
    }

    // ---- apply scalar/description changes (emitEvent:false — ONE aggregated
    // ticket.fields_updated fires below for the whole resubmission, TU-5)
    if (Object.keys(fields).length) {
      await ticketService.updateTicketFields(ticket.id, workspaceId, fields, actor, { emitEvent: false });
      for (const k of Object.keys(fields)) {
        if (k === 'internalSubcategoryId') continue;
        changedFields.push(k === 'internalCategoryId' ? 'category' : k);
      }
    }

    // ---- customFields: MERGE with auto-provision (a resubmission IS intake)
    let rejectedCustomFields = [];
    let provisionedCustomFields = [];
    if (body?.customFields && typeof body.customFields === 'object' && Object.keys(body.customFields).length) {
      const intake = await customFieldService.setValuesAtCreate(workspaceId, body.customFields, { autoProvision: true, actor });
      rejectedCustomFields = intake.rejected || [];
      provisionedCustomFields = intake.provisioned || [];
      const existing = ticket.customFields || {};
      const changedValues = {};
      for (const [k, v] of Object.entries(intake.values || {})) {
        if (JSON.stringify(existing[k] ?? null) !== JSON.stringify(v ?? null)) changedValues[k] = v;
      }
      if (Object.keys(changedValues).length) {
        try {
          await customFieldService.setValues(ticket.id, workspaceId, changedValues, actor, { emitEvent: false });
        } catch (err) {
          // A retired definition still owns its key (setValuesAtCreate accepted
          // it) but setValues only knows active ones — merge directly.
          logger.info(`Resubmission customFields merged directly for ticket ${ticket.id}: ${err.message}`);
          await prisma.ticket.update({ where: { id: ticket.id }, data: { customFields: { ...existing, ...changedValues } } });
        }
        changedFields.push('customFields');
        for (const [k, v] of Object.entries(changedValues)) {
          diff[`customFields.${k}`] = { from: existing[k] ?? null, to: v };
        }
      }
    }

    // ---- nothing changed and nothing reopened → no note, no audit (don't spam the timeline)
    if (!changedFields.length) {
      logger.info(`API resubmission for ${ticketDisplayRef(ticket)} carried no changes (matchedBy=${ctx.matchedBy})`);
      const fresh = await ticketService.getTicket(ticket.id, workspaceId, { reconcile: false });
      return { ticket: fresh, changedFields: [], reopened: false, aiRetriage: { queued: false }, noteId: null, rejectedCustomFields, provisionedCustomFields };
    }

    // ---- private note with the before/after table (NEVER addReply — that emails requester + cc)
    let noteId = null;
    try {
      // systemNote (TU-3g): the diff note is machine-written — stored with
      // authorType 'system' and flagged on the note_added event so the
      // default "Internal note added" workflow skips it visibly.
      const note = await ticketService.addPrivateNote(ticket.id, workspaceId, {
        bodyHtml: renderDiffNoteHtml({ ctx, changedFields, diff, reopened }),
        bodyText: renderDiffNoteText({ ctx, changedFields, diff, reopened }),
      }, actor, [], { systemNote: true });
      noteId = note?.id ?? null;
    } catch (err) {
      logger.warn(`Resubmission note failed for ticket ${ticket.id} (non-fatal): ${err.message}`);
    }

    const auditRow = await ticketService._audit(ticket.id, 'resubmitted', actor, {
      via: 'api_v1',
      matchedBy: ctx.matchedBy || null,
      externalRef: ctx.externalRef || ticket.externalRef || null,
      changedFields,
      reopened,
    });
    // updateTicketFields doesn't touch lastRealActivityAt (only _audit does,
    // best-effort) — bump it explicitly so the ticket surfaces in queue sorts.
    await prisma.ticket.update({ where: { id: ticket.id }, data: { lastRealActivityAt: new Date() } }).catch(() => {});

    // ONE aggregated ticket.fields_updated (TU-5) with the full diff — status
    // is excluded (changeStatus above already fired ticket.status_changed).
    // Emitted AFTER the note/audit so a coalesced email reads the final row.
    const eventDiff = Object.fromEntries(Object.entries(diff).filter(([field]) => field !== 'status'));
    if (Object.keys(eventDiff).length) {
      await ticketService._emitFieldsUpdated?.({
        ticket, changes: eventDiff, actor, source: 'api:resubmission', reopened, auditRowId: auditRow?.id ?? null,
      });
    }

    // ---- AI re-triage: classification only, and only when it can't bounce an agent
    let aiRetriage = { queued: false };
    const contentChanged = descriptionChanged || Boolean(fields.subject);
    const categoryWasAiSet = !ticket.internalCategoryId || Boolean(ticket.internalCategoryFit);
    if (body?.runAiTriage !== false && contentChanged && (!ticket.assignedTechId || categoryWasAiSet)) {
      aiRetriage = await ticketService._startAiTriage(ticket.id, workspaceId, 'classification_only');
    }

    const fresh = await ticketService.getTicket(ticket.id, workspaceId, { reconcile: false });
    logger.info(`API resubmission applied to ${ticketDisplayRef(ticket)} (matchedBy=${ctx.matchedBy}, changed=${changedFields.join(',')}, reopened=${reopened})`);
    return { ticket: fresh, changedFields, reopened, aiRetriage, noteId, rejectedCustomFields, provisionedCustomFields };
  }

  /** Closed / reopen-declined: link the NEW ticket related_to the prior one (pattern: duplicateBurstService). */
  async linkSuccessor(newTicketId, workspaceId, priorTicketId, actor) {
    try {
      const { default: ticketLinkService } = await import('./ticketLinkService.js');
      await ticketLinkService.link(newTicketId, workspaceId, { relatedTicketId: priorTicketId, kind: 'related_to' }, actor);
      return true;
    } catch (err) {
      logger.info('Resubmission successor link not created', { newTicketId, priorTicketId, error: err.message });
      return false;
    }
  }
}

export default new TicketResubmissionService();
