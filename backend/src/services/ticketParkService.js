// Parked tickets (Sep 2026, plans/PARKED_BUILD_PLAN.md).
//
// A park is a MARKER, not a status: the ticket goes to Pending (FreshService
// sees 3) and carries why it waits and until when. Ticket Pulse shows it as
// "Parked". On the date it wakes (back to Open, assignee told). A requester
// reply, or any status change that is not the park's own, ends it early.
//
// This service is the only writer of ticket_parks and of the denormalised
// tickets.parked_until / park_kind columns.
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import ticketActivityRepository from './ticketActivityRepository.js';
import statusService from './statusService.js';
import { TICKET_ORIGIN, ticketDisplayRef } from '../utils/ticketOrigin.js';
import { readHrNoticeDate, hrWakeDate } from '../utils/hrNoticeDates.js';
import settingsRepository from './settingsRepository.js';

export const PARK_KINDS = Object.freeze(['until_date', 'waiting_on', 'eta']);
export const PARK_KIND_LABELS = Object.freeze({
  until_date: 'Waiting until a date',
  waiting_on: 'Waiting on someone',
  eta: 'In progress, with an ETA',
});
export const PARK_SOURCES = Object.freeze(['agent', 'suggested_hr', 'api', 'workflow', 'bulk']);
// Vahid, 23 Sep 2026: up to six months; past that, park again with a new date.
export const MAX_PARK_DAYS = 184;
const PARKED_STATUS = 'Pending';
const SWEEP_INTERVAL_MS = 60 * 1000;
const SWEEP_BATCH = 20;
const DUE_SOON_HOURS = 24;
// HR notices (§2.6): which subjects are worth reading, and the per-workspace
// switch. Vahid, 23 Sep 2026 (Q2 default): on in IT, off elsewhere.
const HR_SUBJECT_FILTERS = [
  { subject: { startsWith: 'Transfer Notification', mode: 'insensitive' } },
  { subject: { contains: 'Departure Notification', mode: 'insensitive' } },
  { subject: { contains: 'On Leave Notification', mode: 'insensitive' } },
  { subject: { startsWith: 'New Hire', mode: 'insensitive' } },
  { subject: { startsWith: 'NH ' } },
];
const HR_AUTO_DEFAULT = { 1: true };
export const hrAutoParkKey = (workspaceId) => `park_hr_auto_ws${Number(workspaceId)}`;

/** Marks the park's own status changes so the unpark hooks ignore them. */
export function parkActor(actor, extra = {}) {
  return { ...(actor || {}), _parkChange: true, ...extra };
}

export function isParkChange(actor) {
  return Boolean(actor?._parkChange);
}

function actorLabel(actor) {
  return actor?.name || actor?.email || 'Ticket Pulse';
}

function parseUntil(raw) {
  if (raw instanceof Date) return raw;
  const text = String(raw ?? '').trim();
  if (!text) return null;
  // A bare date ("2026-10-05") means the START of that local business day;
  // keep it simple and wake at 07:00 UTC-ish via noon-safe parsing: treat
  // it as 08:00 America/Vancouver by adding the offset explicitly.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return new Date(`${text}T15:00:00.000Z`);
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

function cleanWaitingOn(list) {
  if (!Array.isArray(list)) return null;
  const out = list
    .map((p) => ({
      ...(p?.technicianId ? { technicianId: Number(p.technicianId) } : {}),
      ...(p?.email ? { email: String(p.email).trim().toLowerCase() } : {}),
      name: String(p?.name || p?.email || '').trim().slice(0, 120),
    }))
    .filter((p) => p.name || p.email || p.technicianId)
    .slice(0, 10);
  return out.length ? out : null;
}

/** Validation shared by the API, the UI routes, workflows and bulk. */
export function validatePark({ kind, until, reason, waitingOn } = {}, { now = new Date(), requesterEmail = null } = {}) {
  if (!PARK_KINDS.includes(kind)) {
    throw new ValidationError(`kind must be one of: ${PARK_KINDS.join(', ')}`);
  }
  const date = parseUntil(until);
  if (!date) throw new ValidationError('A date is required (until / chase-on / ETA)');
  if (date.getTime() <= now.getTime()) throw new ValidationError('The date must be in the future');
  const max = new Date(now.getTime() + MAX_PARK_DAYS * 86400e3);
  if (date.getTime() > max.getTime()) {
    const err = new ValidationError('A ticket can be parked for up to six months — park it again later with a new date and reason');
    err.code = 'park_date_invalid';
    throw err;
  }
  const text = String(reason ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new ValidationError('Say why it is waiting (one line)');
  const people = kind === 'waiting_on' ? cleanWaitingOn(waitingOn) : null;
  if (kind === 'waiting_on' && !people) throw new ValidationError('Say who it is waiting on');
  if (people && requesterEmail && people.some((p) => p.email && p.email === String(requesterEmail).toLowerCase())) {
    const err = new ValidationError('Waiting on the requester is not a park — set the ticket to Pending Response and FreshService reminds them');
    err.code = 'park_requester_use_pending_response';
    throw err;
  }
  return { kind, until: date, reason: text.slice(0, 500), waitingOn: people };
}

/** Public shape for API / UI. */
export function parkView(park) {
  if (!park) return null;
  return {
    id: park.id,
    kind: park.kind,
    kindLabel: PARK_KIND_LABELS[park.kind] || park.kind,
    until: park.until,
    reason: park.reason,
    waitingOn: park.waitingOn || null,
    source: park.source,
    parkedBy: park.parkedBy,
    parkedAt: park.parkedAt,
  };
}

class TicketParkService {
  async _loadTicket(ticketId, workspaceId) {
    const ticket = await prisma.ticket.findFirst({
      where: { id: Number(ticketId), workspaceId: Number(workspaceId) },
      select: {
        id: true, workspaceId: true, origin: true, status: true, subject: true, dueBy: true, dueBySetBy: true,
        nativeNumber: true, freshserviceTicketId: true, parkedUntil: true, parkKind: true, assignedTechId: true,
        requester: { select: { email: true } },
        assignedTech: { select: { id: true, name: true, email: true } },
      },
    });
    if (!ticket) throw new NotFoundError('Ticket not found');
    return ticket;
  }

  async activePark(ticketId) {
    return prisma.ticketPark.findFirst({
      where: { ticketId: Number(ticketId), endedAt: null },
      orderBy: { id: 'desc' },
    }).catch(() => null);
  }

  async history(ticketId, { take = 20 } = {}) {
    return prisma.ticketPark.findMany({
      where: { ticketId: Number(ticketId) },
      orderBy: { id: 'desc' },
      take,
    }).catch(() => []);
  }

  /** Change status through the normal origin-aware path, marked as the park's own. */
  async _setStatus(ticket, status, actor) {
    if (ticket.status === status) return;
    const { default: ticketService } = await import('./ticketService.js');
    if (ticket.origin === TICKET_ORIGIN.TICKETPULSE) {
      await ticketService.changeStatus(ticket.id, ticket.workspaceId, status, parkActor(actor), {});
    } else {
      await ticketService.updateFsTicket(ticket.id, ticket.workspaceId, { status }, parkActor(actor));
    }
  }

  _broadcast(ticket, kind) {
    import('./ticketService.js')
      .then(({ default: ticketService }) => ticketService._broadcast?.(ticket.workspaceId, kind, ticket))
      .catch(() => {});
  }

  _emit(eventType, ticketId, extra) {
    import('./ticketLifecycleNotificationService.js')
      .then(({ emitTicketEvent }) => emitTicketEvent(eventType, ticketId, {
        source: 'ticketpulse_native',
        dedupeStamp: `${eventType}:${ticketId}:${extra?.parkId ?? ''}:${Date.now()}`,
        extra,
      }))
      .catch((err) => logger.debug?.(`Park event ${eventType} not dispatched for ticket ${ticketId}: ${err.message}`));
  }

  /**
   * Park a ticket (or re-park it: the active park ends as 'extended').
   * @returns {{ park, ticket }} the new park and the ticket's display ref
   */
  async park(ticketId, workspaceId, input = {}, actor = null, { source = 'agent' } = {}) {
    const ticket = await this._loadTicket(ticketId, workspaceId);
    if (['Deleted', 'Spam'].includes(ticket.status)) throw new ValidationError('A deleted ticket cannot be parked');
    const base = await statusService.resolveBaseStatus(workspaceId, ticket.status);
    if (base === 'Resolved' || base === 'Closed') throw new ValidationError('A resolved or closed ticket cannot be parked — reopen it first');
    const clean = validatePark(input, { requesterEmail: ticket.requester?.email || null });
    const existing = await this.activePark(ticket.id);

    // Status first: if FreshService refuses Pending, nothing is parked.
    await this._setStatus(ticket, PARKED_STATUS, actor);

    const now = new Date();
    const park = await prisma.$transaction(async (tx) => {
      if (existing) {
        await tx.ticketPark.update({
          where: { id: existing.id },
          data: { endedAt: now, endReason: 'extended', endedBy: actorLabel(actor) },
        });
      }
      const created = await tx.ticketPark.create({
        data: {
          ticketId: ticket.id,
          workspaceId: ticket.workspaceId,
          kind: clean.kind,
          until: clean.until,
          reason: clean.reason,
          waitingOn: clean.waitingOn ?? undefined,
          source: PARK_SOURCES.includes(source) ? source : 'agent',
          parkedBy: actorLabel(actor),
          parkedAt: now,
          // Keep the FIRST status before parking across re-parks.
          statusBefore: existing?.statusBefore || ticket.status,
        },
      });
      await tx.ticket.update({
        where: { id: ticket.id },
        data: { parkedUntil: clean.until, parkKind: clean.kind },
      });
      return created;
    });

    await ticketActivityRepository.create({
      ticketId: ticket.id,
      activityType: existing ? 'ticket_park_extended' : 'ticket_parked',
      performedBy: actorLabel(actor),
      performedAt: now,
      details: {
        kind: clean.kind,
        kindLabel: PARK_KIND_LABELS[clean.kind],
        until: clean.until.toISOString(),
        reason: clean.reason,
        waitingOn: clean.waitingOn,
        source,
        ...(existing ? { previousUntil: existing.until } : {}),
      },
    }).catch(() => {});
    this._emit('ticket.parked', ticket.id, { parkId: park.id, kind: clean.kind, until: clean.until.toISOString(), reason: clean.reason, source, extended: Boolean(existing), actor: { name: actorLabel(actor) } });
    this._broadcast({ ...ticket, parkedUntil: clean.until, parkKind: clean.kind }, 'parked');
    logger.info(`Ticket ${ticketDisplayRef(ticket)} parked until ${clean.until.toISOString()} (${clean.kind}) by ${actorLabel(actor)}`);
    return { park: parkView(park), extended: Boolean(existing) };
  }

  /**
   * End the active park.
   *  - manual (Unpark button / API DELETE): the ticket comes back as Open now;
   *  - automatic (requester replied, someone changed the status, closed): only
   *    the marker ends; whatever changed the ticket already set its status.
   */
  async unpark(ticketId, workspaceId, { reason = 'unparked', reopen = true, note = null } = {}, actor = null) {
    const ticket = await this._loadTicket(ticketId, workspaceId);
    const park = await this.activePark(ticket.id);
    if (!park) {
      if (ticket.parkedUntil) await prisma.ticket.update({ where: { id: ticket.id }, data: { parkedUntil: null, parkKind: null } }).catch(() => {});
      return { unparked: false };
    }
    const now = new Date();
    const claimed = await prisma.ticketPark.updateMany({
      where: { id: park.id, endedAt: null },
      data: { endedAt: now, endReason: reason, endedBy: actorLabel(actor) },
    });
    if (!claimed.count) return { unparked: false };
    await prisma.ticket.update({ where: { id: ticket.id }, data: { parkedUntil: null, parkKind: null } });
    if (reopen && ticket.status === PARKED_STATUS) {
      await this._setStatus(ticket, this._wakeStatus(park), actor).catch((err) => {
        logger.warn(`Unpark of ${ticketDisplayRef(ticket)}: status not reopened (${err.message})`);
      });
    }
    await ticketActivityRepository.create({
      ticketId: ticket.id,
      activityType: 'ticket_unparked',
      performedBy: actorLabel(actor),
      performedAt: now,
      details: { reason, kind: park.kind, until: park.until, ...(note ? { note } : {}) },
    }).catch(() => {});
    this._broadcast({ ...ticket, parkedUntil: null, parkKind: null }, 'unparked');
    return { unparked: true, reason };
  }

  _wakeStatus(park) {
    // Back to where it was when that was an open state; otherwise Open.
    const before = String(park?.statusBefore || '');
    return before && before !== PARKED_STATUS && !/pending/i.test(before) ? before : 'Open';
  }

  /** The date came: back to the assignee. Called by the sweep after it claimed the park. */
  async _wake(park) {
    const ticket = await this._loadTicket(park.ticketId, park.workspaceId).catch(() => null);
    if (!ticket) return;
    await prisma.ticket.update({ where: { id: ticket.id }, data: { parkedUntil: null, parkKind: null } });
    const actor = { name: 'Ticket Pulse (park ended)', role: 'automation' };
    let reopened = false;
    if (ticket.status === PARKED_STATUS) {
      try {
        await this._setStatus(ticket, this._wakeStatus(park), actor);
        reopened = true;
      } catch (err) {
        logger.warn(`Park wake of ${ticketDisplayRef(ticket)}: status not reopened (${err.message})`);
      }
    }
    // Ticket Pulse tickets: the time parked does not count against the due
    // date (FreshService owns FS-born due dates — untouched).
    if (ticket.origin === TICKET_ORIGIN.TICKETPULSE && ticket.dueBy) {
      const parkedMs = Math.max(0, Date.now() - new Date(park.parkedAt).getTime());
      const shifted = new Date(new Date(ticket.dueBy).getTime() + parkedMs);
      await prisma.ticket.update({ where: { id: ticket.id }, data: { dueBy: shifted } }).catch(() => {});
    }
    await ticketActivityRepository.create({
      ticketId: ticket.id,
      activityType: 'ticket_woke',
      performedBy: 'Ticket Pulse',
      performedAt: new Date(),
      details: { kind: park.kind, kindLabel: PARK_KIND_LABELS[park.kind], until: park.until, reason: park.reason, reopened },
    }).catch(() => {});
    this._emit('ticket.woke', ticket.id, { parkId: park.id, kind: park.kind, until: park.until, reason: park.reason });
    this._broadcast({ ...ticket, parkedUntil: null, parkKind: null }, 'woke');
    await this._notifyAssignee(ticket, park).catch((err) => logger.warn(`Park wake notice for ${ticketDisplayRef(ticket)} not sent: ${err.message}`));
    logger.info(`Ticket ${ticketDisplayRef(ticket)} woke (${park.kind}, parked by ${park.parkedBy})`);
  }

  async _notifyAssignee(ticket, park) {
    const to = ticket.assignedTech?.email;
    if (!to) return { sent: false, reason: 'no_assignee' };
    const { resolvePublicBaseUrl } = await import('../utils/publicBaseUrl.js').catch(() => ({}));
    const base = typeof resolvePublicBaseUrl === 'function' ? resolvePublicBaseUrl() : (process.env.PUBLIC_APP_URL || 'https://ticketpulse.bgcsaas.com');
    const ref = ticketDisplayRef(ticket);
    const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const what = park.kind === 'waiting_on'
      ? `It was waiting on ${esc((park.waitingOn || []).map((p) => p.name || p.email).join(', ') || 'someone')} — time to chase.`
      : park.kind === 'eta' ? 'Its ETA has come — please update the ticket.' : 'Its date has come — it is back in your queue.';
    const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#0f172a">
<p style="margin:0 0 10px">A ticket you parked is back: <b>${esc(ref)} ${esc(ticket.subject)}</b>.</p>
<p style="margin:0 0 10px">${what}</p>
<p style="margin:0 0 14px;color:#475569">Parked by ${esc(park.parkedBy)} — “${esc(park.reason)}”.</p>
<p style="margin:0"><a href="${base}/tickets/${ticket.id}" style="color:#1d4ed8">Open ${esc(ref)} in Ticket Pulse</a></p></div>`;
    const { sendTransactionalEmail } = await import('./transactionalEmailService.js');
    return sendTransactionalEmail({ workspaceId: ticket.workspaceId, to, subject: `Back in your queue: ${ref} ${ticket.subject}`.slice(0, 180), html, label: 'park wake' });
  }

  // ---------- hooks ----------

  /**
   * Any status change that is not the park's own ends the park (the new
   * status stands). Safe to call on every status change; a no-op when the
   * ticket is not parked.
   */
  async afterStatusChange(ticketId, workspaceId, { newStatus, actor } = {}) {
    if (isParkChange(actor)) return { unparked: false };
    const park = await this.activePark(ticketId);
    if (!park) return { unparked: false };
    const base = await statusService.resolveBaseStatus(workspaceId, newStatus).catch(() => null);
    const reason = base === 'Resolved' || base === 'Closed' ? 'closed' : 'status_changed';
    return this.unpark(ticketId, workspaceId, { reason, reopen: false, note: `Status set to ${newStatus}` }, actor);
  }

  /** A requester reply wakes the ticket early: back to Open with the reply. */
  async afterRequesterReply(ticketId, workspaceId) {
    const park = await this.activePark(ticketId);
    if (!park) return { unparked: false };
    return this.unpark(ticketId, workspaceId, { reason: 'requester_replied', reopen: true, note: 'The requester replied' }, { name: 'Ticket Pulse (requester replied)', role: 'automation' });
  }

  // ---------- sweep ----------

  start() {
    if (this._timer || process.env.TICKET_PARK_SWEEP_ENABLED === 'false') return;
    this._timer = setInterval(() => { this.sweep().catch((err) => logger.warn(`Park sweep failed: ${err.message}`)); }, SWEEP_INTERVAL_MS);
    this._timer.unref?.();
    logger.info(`Park sweep started (every ${SWEEP_INTERVAL_MS / 1000}s)`);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /**
   * One pass: wake due parks (atomic claim), end parks whose ticket was moved
   * off Pending by anything (sync, workflow, API — the safety net behind the
   * direct hooks), and announce parks due within a day.
   */
  async sweep({ now = new Date() } = {}) {
    if (this._running) return { skipped: true };
    this._running = true;
    const out = { woke: 0, ended: 0, dueSoon: 0 };
    try {
      const due = await prisma.ticketPark.findMany({
        where: { endedAt: null, until: { lte: now } },
        orderBy: { until: 'asc' },
        take: SWEEP_BATCH,
      });
      for (const park of due) {
        const claimed = await prisma.ticketPark.updateMany({
          where: { id: park.id, endedAt: null },
          data: { endedAt: now, endReason: 'woke', endedBy: 'Ticket Pulse' },
        });
        if (!claimed.count) continue;
        await this._wake(park).catch((err) => logger.warn(`Park ${park.id} wake failed: ${err.message}`));
        out.woke += 1;
      }

      // Safety net: parked tickets that are no longer Pending.
      const drifted = await prisma.ticket.findMany({
        where: { parkedUntil: { not: null }, NOT: { status: PARKED_STATUS } },
        select: { id: true, workspaceId: true, status: true },
        take: SWEEP_BATCH,
      });
      for (const t of drifted) {
        const base = await statusService.resolveBaseStatus(t.workspaceId, t.status).catch(() => null);
        const reason = base === 'Resolved' || base === 'Closed' || ['Deleted', 'Spam'].includes(t.status) ? 'closed' : 'status_changed';
        await this.unpark(t.id, t.workspaceId, { reason, reopen: false, note: `Status is now ${t.status}` }, { name: 'Ticket Pulse', role: 'automation' }).catch(() => {});
        out.ended += 1;
      }

      const soon = await prisma.ticketPark.findMany({
        where: { endedAt: null, dueSoonNotifiedAt: null, until: { gt: now, lte: new Date(now.getTime() + DUE_SOON_HOURS * 3600e3) } },
        take: SWEEP_BATCH,
      });
      for (const park of soon) {
        const claimed = await prisma.ticketPark.updateMany({ where: { id: park.id, dueSoonNotifiedAt: null }, data: { dueSoonNotifiedAt: now } });
        if (!claimed.count) continue;
        this._emit('ticket.park_due_soon', park.ticketId, { parkId: park.id, kind: park.kind, until: park.until, reason: park.reason });
        out.dueSoon += 1;
      }
      // New HR notices with a clear date (IT on by default) — every 10th pass.
      this._hrPass = (this._hrPass || 0) + 1;
      if (this._hrPass % 10 === 1) {
        const workspaces = await prisma.workspace.findMany({ where: { isActive: true, id: { notIn: [6, 7, 8] } }, select: { id: true } }).catch(() => []);
        for (const ws of workspaces) {
          if (!(await this.hrAutoParkEnabled(ws.id))) continue;
          const parked = (await this.autoParkHrNotices({ workspaceId: ws.id, sinceDays: 2 })).filter((r) => r.parked);
          out.hrParked = (out.hrParked || 0) + parked.length;
        }
      }
      if (out.woke || out.ended || out.hrParked) logger.info(`Park sweep: ${out.woke} woke, ${out.ended} ended (status moved), ${out.dueSoon} due soon, ${out.hrParked || 0} HR notice(s) parked`);
      return out;
    } finally {
      this._running = false;
    }
  }

  // ---------- HR notices (§2.6) ----------

  /** The clear date an HR notice states, or null. Never guesses. */
  async hrSuggestion(ticketId, workspaceId) {
    const t = await prisma.ticket.findFirst({
      where: { id: Number(ticketId), workspaceId: Number(workspaceId) },
      select: { subject: true, descriptionText: true, description: true, createdAt: true },
    }).catch(() => null);
    if (!t) return null;
    const read = readHrNoticeDate({
      subject: t.subject,
      text: t.descriptionText || String(t.description || '').replace(/<[^>]+>/g, ' '),
      createdAt: t.createdAt,
    });
    if (!read) return null;
    // Lead time (25 Sep 2026): wake ahead of the notice's date — see hrWakeDate.
    // If the lead window has already begun, the ticket needs work now: not usable.
    let isBusinessDay = null;
    try {
      const { default: businessCalendarService } = await import('./businessCalendarService.js');
      const cal = await businessCalendarService.loadCalendar(Number(workspaceId));
      if (cal) isBusinessDay = (iso) => cal.byDay.has(new Date(`${iso}T00:00:00Z`).getUTCDay()) && !cal.isHolidayDate(iso);
    } catch { /* Monday–Friday */ }
    const wakeDate = hrWakeDate(read.kind, read.date, { isBusinessDay });
    const until = new Date(`${wakeDate}T15:00:00.000Z`);
    const now = Date.now();
    const usable = until.getTime() > now + 3600e3 && until.getTime() <= now + MAX_PARK_DAYS * 86400e3;
    return { ...read, wakeDate, until: until.toISOString(), usable };
  }

  async hrAutoParkEnabled(workspaceId) {
    const raw = await settingsRepository.get(hrAutoParkKey(workspaceId)).catch(() => null);
    if (raw === null || raw === undefined || raw === '') return HR_AUTO_DEFAULT[Number(workspaceId)] === true;
    return raw === true || raw === 'true';
  }

  /**
   * Park HR notices whose date is clear, in the future and within six months.
   * A ticket that was EVER parked is left alone (an Unpark is final).
   *   { workspaceId, sinceDays: 2 } — the sweep, new notices only
   *   { workspaceId, sinceDays: null, dryRun } — the one-off backfill
   */
  async autoParkHrNotices({ workspaceId, sinceDays = 2, dryRun = false, limit = 20 } = {}) {
    const results = [];
    const openNames = await statusService.statusNamesForBase(workspaceId, ['Open', 'Pending']);
    const candidates = await prisma.ticket.findMany({
      where: {
        workspaceId: Number(workspaceId),
        status: { in: openNames },
        parkedUntil: null,
        parks: { none: {} },
        ...(sinceDays ? { createdAt: { gte: new Date(Date.now() - sinceDays * 86400e3) } } : {}),
        OR: HR_SUBJECT_FILTERS,
      },
      select: { id: true, subject: true },
      orderBy: { id: 'desc' },
      take: limit,
    }).catch(() => []);
    for (const c of candidates) {
      const s = await this.hrSuggestion(c.id, workspaceId);
      if (!s || !s.usable) { results.push({ id: c.id, subject: c.subject, parked: false, why: s ? `date ${s.date} (wake ${s.wakeDate}) is past or more than six months out` : 'no clear date' }); continue; }
      if (dryRun) { results.push({ id: c.id, subject: c.subject, parked: false, would: { until: s.wakeDate, date: s.date, reason: s.reason } }); continue; }
      try {
        await this.park(c.id, workspaceId, { kind: 'until_date', until: s.until, reason: s.reason }, { name: 'Ticket Pulse (HR notice)', role: 'automation' }, { source: 'suggested_hr' });
        results.push({ id: c.id, subject: c.subject, parked: true, until: s.wakeDate, date: s.date, reason: s.reason });
      } catch (err) {
        results.push({ id: c.id, subject: c.subject, parked: false, why: err.message });
      }
    }
    return results;
  }

  // ---------- counts for queue / dashboard ----------

  async countsForWorkspace(workspaceId) {
    const now = new Date();
    const week = new Date(now.getTime() + 7 * 86400e3);
    const [parked, wakingWeek] = await Promise.all([
      prisma.ticket.count({ where: { workspaceId: Number(workspaceId), parkedUntil: { not: null } } }),
      prisma.ticket.count({ where: { workspaceId: Number(workspaceId), parkedUntil: { not: null, lte: week } } }),
    ]).catch(() => [0, 0]);
    return { parked, wakingWeek };
  }
}

export default new TicketParkService();
