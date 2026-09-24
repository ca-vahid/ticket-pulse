/**
 * One call per monitoring alert (Sentinel integration, 24 Sep 2026).
 *
 * The caller sends every alert it wants tracked, keyed by a FINGERPRINT (its
 * detection + the affected server/host/certificate…). Ticket Pulse decides,
 * in one step and under a per-fingerprint lock:
 *
 *   alert id already recorded      -> "duplicate": nothing written (safe retry)
 *   no ticket with this fingerprint -> "created": new ticket, count 1
 *   open ticket                    -> "occurrence": count + 1, last seen, note,
 *                                     priority raised if the alert is more severe
 *   resolved/closed within window  -> "reopened": back to the default open
 *                                     status, count + 1, note
 *   resolved/closed before window  -> "created": a NEW ticket takes over the
 *                                     fingerprint, linked "related" to the old one
 *
 * The fingerprint is stored as the ticket's externalRef (unique per
 * workspace), so two concurrent first calls still make ONE ticket: the loser
 * of the unique index is replayed as an occurrence.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import statusService from './statusService.js';
import ticketService from './ticketService.js';
import ticketExternalReferenceService from './ticketExternalReferenceService.js';
import { TICKET_ORIGIN, TICKET_SOURCE } from '../utils/ticketOrigin.js';

export const SEVERITY_PRIORITY = Object.freeze({ low: 1, medium: 2, high: 3, critical: 4 });
const TERMINAL = ['Resolved', 'Closed'];
const DEFAULT_REOPEN_DAYS = 7;

const locks = new Map();
async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const chained = prev.then(() => mine);
  locks.set(key, chained);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

const bad = (field, message, code = 'invalid_request') => Object.assign(new Error(message), { validation: true, field, code });

/** Validate the body. Returns the normalised input. */
export function normalizeAlertBody(body = {}) {
  const fingerprint = String(body.fingerprint ?? '').trim();
  if (fingerprint.length < 8 || fingerprint.length > 200) throw bad('fingerprint', 'fingerprint is required (8–200 characters), e.g. "sentinel:<sha256 hex>"');
  const title = String(body.title ?? body.subject ?? '').replace(/\s+/g, ' ').trim();
  if (title.length < 3) throw bad('title', 'title is required (3–500 characters)');

  let priority = null;
  if (body.priority !== undefined && body.priority !== null) {
    priority = Number(body.priority);
    if (![1, 2, 3, 4].includes(priority)) throw bad('priority', 'priority must be 1 (Low), 2 (Medium), 3 (High) or 4 (Urgent)');
  }
  const severity = body.severity ? String(body.severity).trim().toLowerCase() : null;
  if (severity === 'informational') throw bad('severity', 'Informational alerts are not ticketed — filter them out before calling', 'informational_not_ticketed');
  if (severity && !SEVERITY_PRIORITY[severity]) throw bad('severity', 'severity must be Low, Medium, High or Critical');
  if (priority === null) priority = severity ? SEVERITY_PRIORITY[severity] : 2;

  const reopenWithinDays = body.reopenWithinDays === undefined ? DEFAULT_REOPEN_DAYS : Number(body.reopenWithinDays);
  if (!Number.isInteger(reopenWithinDays) || reopenWithinDays < 0 || reopenWithinDays > 90) throw bad('reopenWithinDays', 'reopenWithinDays must be an integer 0–90 (0 = never reopen)');

  const reference = body.reference ? ticketExternalReferenceService.normalizeReference(body.reference, { defaultSystem: body.system || 'sentinel' }) : null;
  const requesterEmail = body.requesterEmail ? String(body.requesterEmail).trim() : null;
  if (!requesterEmail) throw bad('requesterEmail', 'requesterEmail is required (the service identity, e.g. sentinel@bgcengineering.ca)');

  return {
    fingerprint,
    fingerprintDisplay: body.fingerprintDisplay ? String(body.fingerprintDisplay).trim().slice(0, 300) : null,
    title: title.slice(0, 500),
    description: body.description === undefined || body.description === null ? null : String(body.description).slice(0, 100000),
    occurrenceNote: body.occurrenceNote ? String(body.occurrenceNote).slice(0, 20000) : null,
    priority,
    severityLabel: severity ? severity.charAt(0).toUpperCase() + severity.slice(1) : null,
    reopenWithinDays,
    reference,
    requesterEmail,
    requesterName: body.requesterName ? String(body.requesterName).trim().slice(0, 255) : null,
    category: body.category ?? undefined,
    subcategory: body.subcategory ?? undefined,
    ticketType: body.ticketType ?? body.type ?? undefined,
    groupId: body.groupId ?? undefined,
    internalGroupId: body.internalGroupId ?? undefined,
    customFields: body.customFields && typeof body.customFields === 'object' && !Array.isArray(body.customFields) ? body.customFields : undefined,
    tags: Array.isArray(body.tags) ? body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 10) : [],
    occurredAt: reference?.occurredAt || (body.time ? new Date(body.time) : new Date()),
  };
}

async function tagIdsFor(workspaceId, names) {
  if (!names.length) return [];
  const rows = await prisma.ticketTag.findMany({
    where: { workspaceId, isActive: true, OR: names.map((n) => ({ name: { equals: n, mode: 'insensitive' } })) },
    select: { id: true, name: true },
  });
  const missing = names.filter((n) => !rows.some((r) => r.name.toLowerCase() === n.toLowerCase()));
  if (missing.length) throw bad('tags', `Unknown tag(s): ${missing.join(', ')} (GET /tags lists them)`);
  return rows.map((r) => r.id);
}

async function workspaceTz(workspaceId) {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { defaultTimezone: true } }).catch(() => null);
  return ws?.defaultTimezone || 'America/Vancouver';
}

function fmtTime(date, tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' }).format(date);
  } catch { return date.toISOString(); }
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function noteBody({ kind, count, input, tz, previousPriority, raisedTo }) {
  const when = fmtTime(input.occurredAt, tz);
  const head = kind === 'reopened' ? `Reopened — the alert fired again (occurrence #${count}), ${when}` : `Repeat occurrence #${count} — ${when}`;
  const ref = input.reference;
  const refText = ref ? `${ref.system === 'sentinel' ? 'Sentinel incident' : `${ref.system} record`} ${ref.number ? `#${ref.number}` : ref.externalId}` : null;
  const sev = raisedTo ? `Priority raised from ${previousPriority} to ${raisedTo}.` : (input.severityLabel ? `Severity: ${input.severityLabel}.` : null);
  const textLines = [head, refText ? `${refText}${ref.url ? ` (${ref.url})` : ''}.` : null, sev, input.occurrenceNote ? input.occurrenceNote.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null].filter(Boolean);
  const html = [
    `<p><strong>${esc(head)}</strong></p>`,
    refText ? `<p>${ref.url ? `<a href="${esc(ref.url)}">${esc(refText)}</a>` : esc(refText)}</p>` : '',
    sev ? `<p>${esc(sev)}</p>` : '',
    input.occurrenceNote ? `<div>${input.occurrenceNote}</div>` : '',
  ].join('');
  return { bodyText: textLines.join('\n'), bodyHtml: html };
}

const PRIORITY_LABEL = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };

class AlertOccurrenceService {
  /**
   * Record one alert. Returns { action, ticketId, previousTicketId, occurrenceCount,
   * lastOccurrenceAt, priorityRaised }.
   */
  async record(workspaceId, rawBody, actor) {
    const input = normalizeAlertBody(rawBody);
    return withLock(`${workspaceId}:${input.fingerprint}`, () => this._record(workspaceId, input, actor));
  }

  async _record(workspaceId, input, actor) {
    const ref = input.reference;
    if (ref?.alertId) {
      const holder = await ticketExternalReferenceService.findTicketIdForAlert(workspaceId, ref.system, ref.alertId);
      if (holder) {
        const t = await prisma.ticket.findUnique({ where: { id: holder }, select: { occurrenceCount: true, lastOccurrenceAt: true } });
        return { action: 'duplicate', ticketId: holder, previousTicketId: null, occurrenceCount: t?.occurrenceCount ?? null, lastOccurrenceAt: t?.lastOccurrenceAt ?? null, priorityRaised: false };
      }
    }

    const existing = await prisma.ticket.findFirst({
      where: { workspaceId, externalRef: input.fingerprint },
      select: { id: true, status: true, origin: true, priority: true, resolvedAt: true, closedAt: true, updatedAt: true },
    });
    if (!existing) return this._create(workspaceId, input, actor, null);

    const base = await statusService.baseStatusOf(workspaceId, existing.status);
    const tpOwned = existing.origin === TICKET_ORIGIN.TICKETPULSE;
    if (!TERMINAL.includes(base)) return this._occurrence(workspaceId, input, actor, existing, 'occurrence');

    const terminalAt = existing.closedAt || existing.resolvedAt || existing.updatedAt;
    const withinWindow = input.reopenWithinDays > 0 && terminalAt
      && (Date.now() - new Date(terminalAt).getTime()) <= input.reopenWithinDays * 24 * 3600 * 1000;
    if (withinWindow && tpOwned) {
      const openNames = await statusService.statusNamesForBase(workspaceId, 'Open');
      await ticketService.changeStatus(existing.id, workspaceId, openNames[0] || 'Open', actor);
      return this._occurrence(workspaceId, input, actor, existing, 'reopened');
    }
    // Outside the window: a new ticket takes the fingerprint; the old one keeps its history.
    return this._create(workspaceId, input, actor, existing);
  }

  async _create(workspaceId, input, actor, previous) {
    const tagIds = await tagIdsFor(workspaceId, input.tags);
    const customFields = {
      ...(input.customFields || {}),
      ...(input.fingerprintDisplay ? { alert_fingerprint: input.fingerprintDisplay } : {}),
    };
    if (previous) await prisma.ticket.update({ where: { id: previous.id }, data: { externalRef: null } });
    let created;
    try {
      created = await ticketService.createTicket(workspaceId, {
        subject: input.title,
        description: input.description,
        priority: input.priority,
        requesterEmail: input.requesterEmail,
        requesterName: input.requesterName,
        externalRef: input.fingerprint,
        tagIds,
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.subcategory !== undefined ? { subcategory: input.subcategory } : {}),
        ...(input.ticketType !== undefined ? { ticketType: input.ticketType } : {}),
        ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
        ...(input.internalGroupId !== undefined ? { internalGroupId: input.internalGroupId } : {}),
        ...(Object.keys(customFields).length ? { customFields } : {}),
      }, actor, { sourceChannel: TICKET_SOURCE.API, enforceRequired: true });
    } catch (err) {
      if (previous) await prisma.ticket.update({ where: { id: previous.id }, data: { externalRef: input.fingerprint } }).catch(() => {});
      if (err?.code === 'external_ref_exists') {
        // Another instance created it a moment ago: this call is an occurrence of that ticket.
        const winner = await prisma.ticket.findFirst({
          where: { workspaceId, externalRef: input.fingerprint },
          select: { id: true, status: true, origin: true, priority: true, resolvedAt: true, closedAt: true, updatedAt: true },
        });
        if (winner) return this._occurrence(workspaceId, input, actor, winner, 'occurrence');
      }
      throw err;
    }
    const now = input.occurredAt;
    await prisma.ticket.update({ where: { id: created.id }, data: { occurrenceCount: 1, lastOccurrenceAt: now } });
    if (input.reference) await ticketExternalReferenceService.addReferences(created.id, workspaceId, [input.reference], actor?.email || null);
    if (previous) {
      await Promise.resolve()
        .then(async () => {
          const { default: ticketLinkService } = await import('./ticketLinkService.js');
          await ticketLinkService.link(created.id, workspaceId, { relatedTicketId: previous.id, kind: 'related_to' }, actor);
        })
        .catch((err) => logger.warn(`Alert occurrence: could not link ${created.id} to earlier ticket ${previous.id}: ${err.message}`));
    }
    return { action: 'created', ticketId: created.id, previousTicketId: previous?.id ?? null, occurrenceCount: 1, lastOccurrenceAt: now, priorityRaised: false };
  }

  async _occurrence(workspaceId, input, actor, ticket, kind) {
    const tz = await workspaceTz(workspaceId);
    let priorityRaised = false;
    const tpOwned = ticket.origin === TICKET_ORIGIN.TICKETPULSE;
    if (tpOwned && input.priority > (ticket.priority || 0)) {
      await ticketService.updateTicketFields(ticket.id, workspaceId, { priority: input.priority }, actor);
      priorityRaised = true;
    }
    const updated = await prisma.ticket.update({
      where: { id: ticket.id },
      data: { occurrenceCount: { increment: 1 }, lastOccurrenceAt: input.occurredAt },
      select: { occurrenceCount: true, lastOccurrenceAt: true },
    });
    if (input.reference) await ticketExternalReferenceService.addReferences(ticket.id, workspaceId, [input.reference], actor?.email || null);
    const body = noteBody({
      kind, count: updated.occurrenceCount, input, tz,
      previousPriority: PRIORITY_LABEL[ticket.priority] || ticket.priority,
      raisedTo: priorityRaised ? PRIORITY_LABEL[input.priority] : null,
    });
    await Promise.resolve()
      .then(() => ticketService.addPrivateNote(ticket.id, workspaceId, { ...body, agent: 'Occurrence' }, actor))
      .catch((err) => logger.warn(`Alert occurrence note failed on ticket ${ticket.id} (non-fatal): ${err.message}`));
    return { action: kind, ticketId: ticket.id, previousTicketId: null, occurrenceCount: updated.occurrenceCount, lastOccurrenceAt: updated.lastOccurrenceAt, priorityRaised };
  }
}

const alertOccurrenceService = new AlertOccurrenceService();
export default alertOccurrenceService;
export { AlertOccurrenceService };
