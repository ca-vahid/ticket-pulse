import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import { fillGreetingPlaceholders } from './replyGreetingService.js';
import { refPositionFor, replyMailSubject } from './mailSubjectService.js';

/**
 * Macros — agent quick-action bundles (QA 11-05 #2: their own Settings tab and
 * a FreshService-style ordered action list).
 *
 * Storage: the existing `ticket_macros.actions` JSON column, now
 * `{ version: 2, steps: [{ type, ... }] }`. The pre-11-05 shape
 * (`{ setStatus, setPriority, assignToTechnicianId, addNote, replyBody }`) is
 * read through `macroSteps()` so an old macro keeps working unchanged; it is
 * rewritten in the new shape the next time an admin saves it.
 *
 * Applying reuses the SAME origin-aware service paths as manual edits, so
 * audits, events, the mirror, SSE, the reply signature, threading and the
 * unattended-requester guard all behave exactly as if the agent did each step
 * by hand:
 *  - Ticket Pulse-born: every action, fully editable.
 *  - FreshService-born: only what the ticket page already writes back
 *    (status, priority, category, assignee, due through the FS-first
 *    `updateFsTicket` seam; Ticket Pulse tags; notes; replies). Group, type and
 *    custom fields are FreshService's — those steps are skipped and the
 *    preview says so.
 * Field changes run first, then the assignee, tags, note and reply; a status
 * change always runs LAST so a resolve/close never races the other writes.
 */

export const MACRO_STEP_TYPES = ['status', 'priority', 'category', 'group', 'assign', 'type', 'tags', 'due', 'custom_field', 'note', 'reply'];
const MAX_STEPS = 20;
// A picture pasted into a macro's note or reply is stored inline (data: URI)
// and becomes a real attachment when the macro runs (ticketService lifts it).
const MAX_BODY_CHARS = 3_000_000;
const MAX_SUBJECT_CHARS = 500;
const PRIORITY_LABELS = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };
const DUE_UNITS = { hours: 60 * 60 * 1000, days: 24 * 60 * 60 * 1000 };
const FS_OWNS = 'FreshService owns this field on FreshService tickets';
export const UNATTENDED_REPLY_REASON = 'The requester is an unattended mailbox (an alert or integration sender) — replies to it are not e-mailed';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => v !== undefined && v !== null && v !== '';

// An early editor build offered this as the reply subject. It ignores the
// workspace's ticket-number position (mailSubjectService, 4.3.45) and would
// split threads where the number goes after the subject, so it reads as
// "no subject typed" = the workspace's usual reply subject.
const OLD_DEFAULT_SUBJECT_RE = /^\s*\[\s*\{\{\s*ticket\.ref\s*\}\}\s*\]\s*\{\{\s*ticket\.subject\s*\}\}\s*$/;
const tidyStep = (s) => {
  if (s.type === 'reply' && typeof s.subject === 'string' && OLD_DEFAULT_SUBJECT_RE.test(s.subject)) {
    const rest = { ...s };
    delete rest.subject;
    return rest;
  }
  return s;
};

/** The ordered step list behind any stored shape (array, v2 object, or the legacy keys). */
export function macroSteps(actions) {
  if (Array.isArray(actions)) return actions.filter(isObj).map(tidyStep);
  if (!isObj(actions)) return [];
  if (Array.isArray(actions.steps)) return actions.steps.filter(isObj).map(tidyStep);
  const steps = [];
  if (nonEmpty(actions.assignToTechnicianId)) steps.push({ type: 'assign', to: 'technician', technicianId: Number(actions.assignToTechnicianId) });
  if (nonEmpty(actions.setPriority)) steps.push({ type: 'priority', priority: Number(actions.setPriority) });
  if (nonEmpty(actions.addNote)) steps.push({ type: 'note', text: String(actions.addNote) });
  if (nonEmpty(actions.replyBody)) steps.push({ type: 'reply', text: String(actions.replyBody) });
  if (nonEmpty(actions.setStatus)) steps.push({ type: 'status', status: String(actions.setStatus) });
  return steps;
}

/** A macro row as the API hands it out: always the v2 shape. */
export function presentMacro(macro) {
  if (!macro) return macro;
  return { ...macro, actions: { version: 2, steps: macroSteps(macro.actions) } };
}

const textToHtml = (text) => String(text || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .split(/\r?\n/).map((line) => `<p>${line || '<br>'}</p>`).join('');

class TicketMacroService {
  async list(workspaceId, { includeInactive = false } = {}) {
    const rows = await prisma.ticketMacro.findMany({
      where: { workspaceId, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return (rows || []).map(presentMacro);
  }

  async create(workspaceId, { name, description, actions }, actor) {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new ValidationError('Macro needs a name');
    const cleanActions = await this._validateActions(workspaceId, actions);
    const row = await prisma.ticketMacro.create({
      data: { workspaceId, name: cleanName.slice(0, 120), description: description || null, actions: cleanActions, createdBy: actor?.email || null },
    });
    return presentMacro(row);
  }

  async update(workspaceId, id, { name, description, actions, isActive }, _actor) {
    const macro = await prisma.ticketMacro.findFirst({ where: { id: Number(id), workspaceId } });
    if (!macro) throw new NotFoundError('Macro not found');
    const cleanActions = actions !== undefined ? await this._validateActions(workspaceId, actions) : undefined;
    if (name !== undefined && !String(name).trim()) throw new ValidationError('Macro needs a name');
    const row = await prisma.ticketMacro.update({
      where: { id: macro.id },
      data: {
        ...(name !== undefined ? { name: String(name).trim().slice(0, 120) } : {}),
        ...(description !== undefined ? { description: description || null } : {}),
        ...(cleanActions !== undefined ? { actions: cleanActions } : {}),
        ...(isActive !== undefined ? { isActive: isActive !== false } : {}),
      },
    });
    return presentMacro(row);
  }

  async remove(workspaceId, id) {
    const macro = await prisma.ticketMacro.findFirst({ where: { id: Number(id), workspaceId } });
    if (!macro) throw new NotFoundError('Macro not found');
    await prisma.ticketMacro.delete({ where: { id: macro.id } });
    return { deleted: true };
  }

  // ------------------------------------------------------------------ apply

  async _loadMacro(workspaceId, macroId) {
    const macro = await prisma.ticketMacro.findFirst({ where: { id: Number(macroId), workspaceId, isActive: true } });
    if (!macro) throw new NotFoundError('Macro not found');
    return macro;
  }

  async _loadTicket(ticketId, workspaceId) {
    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId },
      select: {
        id: true, workspaceId: true, origin: true, status: true, subject: true, priority: true,
        nativeNumber: true, freshserviceTicketId: true, assignedTechId: true, ccEmails: true,
        requester: { select: { name: true, email: true, unattended: true } },
        assignedTech: { select: { id: true, name: true } },
        tagLinks: { select: { tagId: true } },
      },
    });
    if (!ticket) throw new NotFoundError(`Ticket ${ticketId} not found in this workspace`);
    return ticket;
  }

  /**
   * What the macro would do on this ticket, step by step, with the note and
   * reply rendered for this requester. Shared by the preview and apply, so the
   * confirm shows exactly what runs.
   */
  async _plan(ticket, macro, actor) {
    const workspaceId = ticket.workspaceId;
    const isNative = ticket.origin === 'ticketpulse';
    const steps = macroSteps(macro.actions);
    const fsReplyViaTp = isNative ? true : await import('./fsBornReplyLaneService.js')
      .then(({ isFsBornRepliesViaTicketPulseEnabled }) => isFsBornRepliesViaTicketPulseEnabled(workspaceId))
      .catch(() => false);

    const ids = (type, key) => steps.filter((s) => s.type === type && nonEmpty(s[key])).map((s) => Number(s[key]));
    const techIds = ids('assign', 'technicianId');
    const catIds = [...ids('category', 'categoryId'), ...ids('category', 'subcategoryId')];
    const groupIds = ids('group', 'groupId');
    const tagIds = steps.filter((s) => s.type === 'tags').flatMap((s) => (Array.isArray(s.tagIds) ? s.tagIds : [])).map(Number);
    const safe = (p) => Promise.resolve().then(p).catch(() => []);
    const [techs, cats, groups, tags, workspace] = await Promise.all([
      techIds.length ? safe(() => prisma.technician.findMany({ where: { id: { in: techIds }, workspaceId }, select: { id: true, name: true } })) : [],
      catIds.length ? safe(() => prisma.competencyCategory.findMany({ where: { id: { in: catIds }, workspaceId }, select: { id: true, name: true } })) : [],
      groupIds.length ? safe(() => prisma.group.findMany({ where: { id: { in: groupIds }, workspaceId }, select: { id: true, name: true, origin: true, freshserviceId: true } })) : [],
      tagIds.length ? safe(() => prisma.ticketTag.findMany({ where: { id: { in: tagIds }, workspaceId }, select: { id: true, name: true } })) : [],
      Promise.resolve().then(() => prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } })).catch(() => null),
    ]);
    const nameOf = (rows, id) => (rows || []).find((r) => Number(r.id) === Number(id))?.name || null;

    // The assignee the note/reply should name: this macro's pick, else the current one.
    let assignee = ticket.assignedTech ? { name: ticket.assignedTech.name } : null;
    for (const s of steps) {
      if (s.type !== 'assign') continue;
      const picked = s.to === 'applier' ? (actor?.name || null) : nameOf(techs, s.technicianId);
      if (picked) assignee = { name: picked };
    }
    const vars = {
      requester: ticket.requester || null,
      agent: actor ? { name: actor.name || '' } : null,
      ticket: { displayRef: ticketDisplayRef(ticket), subject: ticket.subject },
      assignee,
      workspace,
    };
    const render = (template, html) => fillGreetingPlaceholders(template, vars, { escape: html });
    const ccCount = Array.isArray(ticket.ccEmails) ? ticket.ccEmails.length : 0;
    const unattended = ticket.requester?.unattended === true;
    // Where this workspace puts the ticket number in mail subjects (4.3.45).
    const refPosition = isNative && steps.some((s) => s.type === 'reply')
      ? await refPositionFor(workspaceId).catch(() => 'after')
      : 'after';
    // Where Resolved is retired (QA 10-30 #2) a "Set status Resolved" lands as
    // Closed — the same swap the workflow engine and changeStatus make.
    const statusTargets = new Map();
    for (const s of steps.filter((x) => x.type === 'status' && nonEmpty(x.status))) {
      if (statusTargets.has(s.status)) continue;
      statusTargets.set(s.status, await import('./autoCloseResolvedService.js')
        .then(({ default: svc }) => svc.closedInsteadOfResolved(workspaceId, s.status))
        .catch(() => s.status));
    }

    const planned = steps.map((s, index) => {
      const base = { index, type: s.type, run: true, reason: null };
      const fsSkip = (summary) => ({ ...base, summary, run: false, reason: FS_OWNS });
      switch (s.type) {
      case 'status': {
        const target = statusTargets.get(s.status) || s.status;
        const swapped = target !== s.status;
        return {
          ...base,
          summary: `Set status to ${target}`,
          ...(swapped ? { notice: `${s.status} is retired in this workspace, so the ticket is set to ${target}` } : {}),
          field: { status: target },
        };
      }
      case 'priority':
        return { ...base, summary: `Set priority to ${PRIORITY_LABELS[Number(s.priority)] || s.priority}`, field: { priority: Number(s.priority) } };
      case 'category': {
        const label = [nameOf(cats, s.categoryId), nameOf(cats, s.subcategoryId)].filter(Boolean).join(' / ') || `category ${s.categoryId}`;
        return {
          ...base,
          summary: `Set category to ${label}`,
          field: { internalCategoryId: Number(s.categoryId), internalSubcategoryId: nonEmpty(s.subcategoryId) ? Number(s.subcategoryId) : null },
        };
      }
      case 'group': {
        const g = (groups || []).find((r) => Number(r.id) === Number(s.groupId));
        const summary = `Set group to ${g?.name || `group ${s.groupId}`}`;
        if (!isNative) return fsSkip(summary);
        if (!g) return { ...base, summary, run: false, reason: 'That group no longer exists in this workspace' };
        const field = g.origin === 'local'
          ? { internalGroupId: g.id, groupId: null }
          : { groupId: g.freshserviceId === null || g.freshserviceId === undefined ? null : Number(g.freshserviceId), internalGroupId: null };
        return { ...base, summary, field };
      }
      case 'type':
        return isNative ? { ...base, summary: `Set type to ${s.ticketType}`, field: { ticketType: s.ticketType } } : fsSkip(`Set type to ${s.ticketType}`);
      case 'custom_field':
        return isNative
          ? { ...base, summary: `Set ${s.label || s.key} to ${s.value === '' ? '(blank)' : s.value}`, field: { customFields: { [s.key]: s.value } } }
          : fsSkip(`Set ${s.label || s.key}`);
      case 'due': {
        const ms = (DUE_UNITS[s.unit] || DUE_UNITS.hours) * Number(s.amount);
        const dueAt = new Date(Date.now() + ms).toISOString();
        return { ...base, summary: `Set the resolution due date ${s.amount} ${s.unit === 'days' ? 'day' : 'hour'}${Number(s.amount) === 1 ? '' : 's'} from now`, dueAt, field: { dueBy: dueAt } };
      }
      case 'assign': {
        if (s.to === 'applier') {
          if (!actor?.technicianId) return { ...base, summary: 'Assign to the person applying it', run: false, reason: 'You are not a technician in this workspace' };
          return { ...base, summary: `Assign to the person applying it (${actor.name || 'you'})`, technicianId: Number(actor.technicianId) };
        }
        return { ...base, summary: `Assign to ${nameOf(techs, s.technicianId) || `technician ${s.technicianId}`}`, technicianId: Number(s.technicianId) };
      }
      case 'tags': {
        const names = (s.tagIds || []).map((id) => nameOf(tags, id)).filter(Boolean);
        return { ...base, summary: `Add tag${names.length === 1 ? '' : 's'} ${names.join(', ') || '(none)'}`, tagIds: (s.tagIds || []).map(Number) };
      }
      case 'note': {
        const html = s.html ? render(s.html, true) : textToHtml(render(s.text, false));
        return { ...base, summary: 'Add an internal note', html };
      }
      case 'reply': {
        const html = s.html ? render(s.html, true) : textToHtml(render(s.text, false));
        // Empty = the workspace's usual reply subject (number placed per the
        // workspace setting). A typed subject overrides it, and still gets the
        // ticket number the same way (replyMailSubject), so threads hold.
        const typed = s.subject ? render(s.subject, false).trim().slice(0, MAX_SUBJECT_CHARS) || null : null;
        const out = {
          ...base,
          summary: 'Reply to the requester',
          html,
          subjectOverride: isNative ? typed : null,
          subject: isNative ? replyMailSubject(ticket.subject, ticketDisplayRef(ticket), refPosition, typed) : null,
          subjectIsDefault: isNative && !typed,
        };
        if (!isNative && typed) out.notice = 'FreshService composes the subject on FreshService tickets — the subject line is not used';
        if (unattended && !fsReplyViaTp) {
          // FreshService itself would e-mail the unattended mailbox: send nothing.
          return { ...out, run: false, reason: UNATTENDED_REPLY_REASON };
        }
        if (unattended && ccCount === 0) {
          // Same path as an agent reply: kept on the ticket, the guard in
          // ticketService._emailRequesterReply sends nothing.
          out.notice = `${UNATTENDED_REPLY_REASON}. It is saved on the ticket and nothing is sent.`;
        } else if (unattended) {
          out.notice = `${UNATTENDED_REPLY_REASON}; it goes to the ${ccCount} Cc'd ${ccCount === 1 ? 'person' : 'people'} only, as an agent reply would.`;
        }
        return out;
      }
      default:
        return { ...base, summary: `Unknown action "${s.type}"`, run: false, reason: 'This action is not supported' };
      }
    });
    return { isNative, steps: planned, fsReplyViaTp };
  }

  /** Preview for the confirm dialog: what each step will do on this ticket. */
  async preview(ticketId, workspaceId, macroId, actor) {
    const macro = await this._loadMacro(workspaceId, macroId);
    const ticket = await this._loadTicket(ticketId, workspaceId);
    const plan = await this._plan(ticket, macro, actor);
    return {
      macro: { id: macro.id, name: macro.name, description: macro.description || null },
      ticket: { id: ticket.id, ref: ticketDisplayRef(ticket), origin: ticket.origin },
      steps: plan.steps.map(({ field: _field, ...rest }) => rest),
    };
  }

  /** Apply a macro to one ticket. Returns per-step results (partial success is visible, never silent). */
  async apply(ticketId, workspaceId, macroId, actor) {
    const macro = await this._loadMacro(workspaceId, macroId);
    const ticket = await this._loadTicket(ticketId, workspaceId);
    const { default: ticketService } = await import('./ticketService.js');
    const plan = await this._plan(ticket, macro, actor);

    const results = [];
    const record = (planned, outcome) => results.push({
      index: planned.index, type: planned.type, label: planned.type, summary: planned.summary, ...outcome,
    });
    const run = async (planned, fn) => {
      try {
        const detail = await fn();
        record(planned, { ok: true, ...(detail ? { detail } : {}) });
      } catch (error) {
        record(planned, { ok: false, error: error.message });
      }
    };

    for (const p of plan.steps.filter((x) => !x.run)) record(p, { ok: true, skipped: true, reason: p.reason });
    const runnable = plan.steps.filter((x) => x.run);
    const fieldSteps = runnable.filter((x) => x.field && x.type !== 'status');
    const statusSteps = runnable.filter((x) => x.type === 'status');
    const assignSteps = runnable.filter((x) => x.type === 'assign');

    // 1) Fields — one write, one fields_updated event (TP) / one FS-first PUT (FS).
    if (fieldSteps.length) {
      const patch = Object.assign({}, ...fieldSteps.map((x) => x.field));
      if (patch.customFields) patch.customFields = Object.assign({}, ...fieldSteps.filter((x) => x.field.customFields).map((x) => x.field.customFields));
      try {
        if (plan.isNative) await ticketService.updateTicketFields(ticketId, workspaceId, patch, actor);
        else await ticketService.updateFsTicket(ticketId, workspaceId, patch, actor, { allowAssignableOnly: true });
        fieldSteps.forEach((x) => record(x, { ok: true }));
      } catch (error) {
        fieldSteps.forEach((x) => record(x, { ok: false, error: error.message }));
      }
    }
    // 2) Assignee — the last assign step wins.
    if (assignSteps.length) {
      const last = assignSteps[assignSteps.length - 1];
      assignSteps.slice(0, -1).forEach((x) => record(x, { ok: true, skipped: true, reason: 'A later assign step in this macro wins' }));
      await run(last, () => (plan.isNative
        ? ticketService.assignTicket(ticketId, workspaceId, last.technicianId, actor, { allowAssignableOnly: true })
        : ticketService.updateFsTicket(ticketId, workspaceId, { assignedTechId: last.technicianId }, actor, { allowAssignableOnly: true })).then(() => null));
    }
    // 3) Tags — added to what the ticket already carries (never removes).
    for (const p of runnable.filter((x) => x.type === 'tags')) {
      await run(p, async () => {
        const current = (ticket.tagLinks || []).map((l) => Number(l.tagId));
        const next = [...new Set([...current, ...p.tagIds])];
        ticket.tagLinks = next.map((tagId) => ({ tagId }));
        await ticketService.setTags(ticketId, workspaceId, next, actor);
        return null;
      });
    }
    // 4) Note and reply, in the macro's order, through the normal thread paths.
    for (const p of runnable.filter((x) => x.type === 'note' || x.type === 'reply')) {
      if (p.type === 'note') {
        await run(p, () => ticketService.addPrivateNote(ticketId, workspaceId, { bodyHtml: p.html }, actor).then(() => null));
      } else {
        await run(p, async () => {
          const res = await ticketService.addReply(ticketId, workspaceId, { bodyHtml: p.html, ...(p.subjectOverride ? { subject: p.subjectOverride } : {}) }, actor);
          const email = res?.email || null;
          if (email && email.sent === false && email.skipped === 'unattended_requester') return 'Saved on the ticket — not e-mailed (unattended requester)';
          return null;
        });
      }
    }
    // 5) Status LAST so a resolve/close doesn't race the other writes.
    if (statusSteps.length) {
      const last = statusSteps[statusSteps.length - 1];
      statusSteps.slice(0, -1).forEach((x) => record(x, { ok: true, skipped: true, reason: 'A later status step in this macro wins' }));
      await run(last, () => (plan.isNative
        ? ticketService.changeStatus(ticketId, workspaceId, String(last.field.status), actor)
        : ticketService.updateFsTicket(ticketId, workspaceId, { status: String(last.field.status) }, actor, { allowAssignableOnly: true })).then(() => null));
    }

    results.sort((a, b) => a.index - b.index);
    const failed = results.filter((s) => !s.ok);
    const ran = results.filter((s) => s.ok && !s.skipped);
    // ONE history row for the whole macro; each step also leaves its own normal trail.
    const note = `Applied macro “${macro.name}”: ${ran.map((s) => s.summary.charAt(0).toLowerCase() + s.summary.slice(1)).join('; ') || 'nothing to change'}`
      + (failed.length ? ` (${failed.length} step${failed.length === 1 ? '' : 's'} failed)` : '');
    if (typeof ticketService._audit === 'function') {
      await ticketService._audit(ticketId, 'macro_applied', actor, {
        macroId: macro.id,
        macroName: macro.name,
        note,
        steps: results.map(({ type, summary, ok, skipped, reason, error }) => ({ type, summary, ok, ...(skipped ? { skipped, reason } : {}), ...(error ? { error } : {}) })),
      });
    }
    logger.info(`Macro "${macro.name}" applied to ticket ${ticketId}: ${ran.length} ran, ${results.length - ran.length - failed.length} skipped, ${failed.length} failed`);
    return { macro: { id: macro.id, name: macro.name }, steps: results, ok: failed.length === 0 };
  }

  // ------------------------------------------------------------- validation

  async _validateActions(workspaceId, actions) {
    if (!actions || typeof actions !== 'object') {
      throw new ValidationError('Macro actions must be a list of steps');
    }
    const raw = macroSteps(actions);
    if (raw.length === 0) throw new ValidationError('Macro needs at least one action');
    if (raw.length > MAX_STEPS) throw new ValidationError(`A macro can hold up to ${MAX_STEPS} actions`);
    const clean = [];
    for (const step of raw) clean.push(await this._validateStep(workspaceId, step));
    return { version: 2, steps: clean };
  }

  async _validateStep(workspaceId, step) {
    const type = String(step.type || '');
    if (!MACRO_STEP_TYPES.includes(type)) throw new ValidationError(`Unknown macro action "${type}"`);
    const id = typeof step.id === 'string' ? step.id.slice(0, 40) : undefined;
    const out = { type, ...(id ? { id } : {}) };
    const body = (s) => {
      const html = typeof s.html === 'string' ? s.html : '';
      const text = typeof s.text === 'string' ? s.text : '';
      if (html.length > MAX_BODY_CHARS || text.length > MAX_BODY_CHARS) throw new ValidationError('This macro text is too long — use smaller pictures or attach files on the ticket instead');
      const plain = (html.replace(/<img\b[^>]*>/gi, 'x').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()) || text.trim();
      if (!plain) throw new ValidationError(type === 'reply' ? 'The reply to the requester is empty' : 'The internal note is empty');
      return { ...(html ? { html } : {}), ...(!html && text ? { text } : {}) };
    };
    switch (type) {
    case 'status': {
      if (!nonEmpty(step.status)) throw new ValidationError('Pick a status for the "Set status" action');
      const { default: statusService } = await import('./statusService.js');
      const normalized = await statusService.normalizeStatusName(workspaceId, String(step.status));
      if (!normalized) {
        const valid = (await statusService.listStatuses(workspaceId)).map((s) => s.name).join(', ');
        throw new ValidationError(`Macro status must be one of this workspace's statuses: ${valid}`);
      }
      // Resolved retired here (QA 10-30 #2): the macro stores what will really happen.
      const live = await import('./autoCloseResolvedService.js')
        .then(({ default: svc }) => svc.closedInsteadOfResolved(workspaceId, normalized))
        .catch(() => normalized);
      return { ...out, status: live || normalized };
    }
    case 'priority': {
      const p = Number(step.priority);
      if (!(p >= 1 && p <= 4)) throw new ValidationError('Macro priority must be 1–4');
      return { ...out, priority: p };
    }
    case 'category': {
      const categoryId = Number(step.categoryId);
      if (!Number.isInteger(categoryId) || categoryId <= 0) throw new ValidationError('Pick a category for the "Set category" action');
      const subcategoryId = nonEmpty(step.subcategoryId) ? Number(step.subcategoryId) : null;
      const { default: ticketService } = await import('./ticketService.js');
      if (typeof ticketService._validateTaxonomy === 'function') await ticketService._validateTaxonomy(workspaceId, categoryId, subcategoryId);
      return { ...out, categoryId, subcategoryId };
    }
    case 'group': {
      const groupId = Number(step.groupId);
      const group = Number.isInteger(groupId) && groupId > 0
        ? await prisma.group.findFirst({ where: { id: groupId, workspaceId }, select: { id: true } })
        : null;
      if (!group) throw new ValidationError('Pick a group of this workspace for the "Set group" action');
      return { ...out, groupId };
    }
    case 'assign': {
      if (step.to === 'applier') return { ...out, to: 'applier' };
      const technicianId = Number(step.technicianId);
      if (!Number.isInteger(technicianId) || technicianId <= 0) throw new ValidationError('Pick who the macro assigns the ticket to');
      const { default: ticketService } = await import('./ticketService.js');
      if (typeof ticketService._validateTechnician === 'function') await ticketService._validateTechnician(workspaceId, technicianId, { allowAssignableOnly: true });
      return { ...out, to: 'technician', technicianId };
    }
    case 'type': {
      if (!nonEmpty(step.ticketType)) throw new ValidationError('Pick a type for the "Set type" action');
      const { default: ticketTypeService } = await import('./ticketTypeService.js');
      return { ...out, ticketType: await ticketTypeService.normalizeTypeName(workspaceId, String(step.ticketType)) };
    }
    case 'tags': {
      const tagIds = [...new Set((Array.isArray(step.tagIds) ? step.tagIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
      if (!tagIds.length) throw new ValidationError('Pick at least one tag for the "Add tags" action');
      const found = await prisma.ticketTag.findMany({ where: { id: { in: tagIds }, workspaceId, isActive: true }, select: { id: true } });
      if ((found || []).length !== tagIds.length) throw new ValidationError('One or more tags do not exist in this workspace');
      return { ...out, tagIds };
    }
    case 'due': {
      const amount = Number(step.amount);
      const unit = step.unit === 'days' ? 'days' : 'hours';
      if (!(amount > 0 && amount <= (unit === 'days' ? 365 : 24 * 365))) throw new ValidationError('The due date needs a number of hours or days from now');
      return { ...out, amount, unit };
    }
    case 'custom_field': {
      const key = String(step.key || '').trim();
      if (!key) throw new ValidationError('Pick a custom field for the "Set custom field" action');
      // Typed values (a yes/no or number field) stay typed; everything else is text.
      const typed = typeof step.value === 'boolean' || (typeof step.value === 'number' && Number.isFinite(step.value));
      const value = typed ? step.value : (step.value === undefined || step.value === null ? '' : String(step.value).slice(0, 2000));
      return { ...out, key: key.slice(0, 120), ...(step.label ? { label: String(step.label).slice(0, 120) } : {}), value };
    }
    case 'note':
      return { ...out, ...body(step) };
    case 'reply': {
      const subject = typeof step.subject === 'string' ? step.subject.trim().slice(0, MAX_SUBJECT_CHARS) : '';
      return { ...out, ...(subject ? { subject } : {}), ...body(step) };
    }
    default:
      throw new ValidationError(`Unknown macro action "${type}"`);
    }
  }
}

const ticketMacroService = new TicketMacroService();
export default ticketMacroService;
