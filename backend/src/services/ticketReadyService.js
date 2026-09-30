/**
 * "Ticket ready" workflow trigger (30 Sep 2026, Vahid: "one e-mail instead of
 * three").
 *
 * A new ticket is READY once it is sorted (category saved) and Auto-help has
 * finished with it — answered, suggested an answer, or decided not to — or
 * Auto-help is off in the workspace. Requester-facing workflows on this
 * trigger see what Auto-help did (event.readyReason, event.autoHelpAnswered)
 * instead of racing it:
 *
 *   auto_help_answering  Auto-help is about to send an answer by itself; an
 *                        acknowledgement with "merge into Auto-help" rides on
 *                        top of it (one e-mail)
 *   auto_help_done       Auto-help finished (answer suggested, no match, …)
 *   auto_help_off        Auto-help is off for this ticket's workspace
 *   timeout              nothing settled within READY_MAX_WAIT_MS of arrival —
 *                        it never waits longer, and never overnight when the
 *                        pipeline is queued until the morning
 *
 * "Ticket ready" follows "Ticket arrived" exactly (30 Sep 2026, moving the
 * arrival e-mails onto it): it fires only for tickets whose ticket.created
 * event was dispatched to workflows (noteArrival, called from the lifecycle
 * service after its own gates — an ingest path or a "don't notify the
 * requester" create that ran no arrival workflows runs no ready workflows
 * either), and it carries the same suppressRequesterAck and createdVia.
 *
 * One 'ticket_ready' activity per ticket: written pending at arrival (only in
 * workspaces with an enabled "Ticket ready" workflow, only for tickets that
 * arrived after the first one was switched on), then claimed once — under a
 * per-ticket advisory lock — when it fires. Workflow runs dedupe on
 * `ready:<id>` too.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';

export const READY_TRIGGER = 'ticket.ready';
export const READY_MAX_WAIT_MS = 3 * 60 * 1000;
export const READY_NEW_TICKET_WINDOW_MS = 2 * 60 * 60 * 1000;
export const READY_REASONS = Object.freeze(['auto_help_answering', 'auto_help_done', 'auto_help_off', 'timeout']);
export const READY_ACTIVITY = 'ticket_ready';
const READY_LOCK_NAMESPACE = 48212;
const USES_TRIGGER_CACHE_MS = 60 * 1000;
const SWEEP_LIMIT = 100;

const REASON_NOTES = Object.freeze({
  auto_help_answering: 'Ticket ready — Auto-help is answering it',
  auto_help_done: 'Ticket ready — sorted, and Auto-help has finished with it',
  auto_help_off: 'Ticket ready — sorted (Auto-help is off here)',
  timeout: 'Ticket ready — 3 minutes passed, workflows go ahead without waiting any longer',
});

/** The earliest moment one of these workflows was switched on (enabledAt, else published / created). */
function sinceOf(rows) {
  const times = (rows || [])
    .map((r) => r.enabledAt || r.lastPublishedAt || r.createdAt)
    .filter(Boolean)
    .map((d) => new Date(d).getTime())
    .filter((t) => Number.isFinite(t));
  return times.length ? new Date(Math.min(...times)) : null;
}

class TicketReadyService {
  _usesCache = new Map();

  /**
   * Since when the workspace has an enabled, published "Ticket ready"
   * workflow (the earliest one switched on), or null when it has none.
   * Cached a minute.
   */
  async readySince(workspaceId, { now = Date.now() } = {}) {
    const ws = Number(workspaceId);
    const hit = this._usesCache.get(ws);
    if (hit && now - hit.at < USES_TRIGGER_CACHE_MS) return hit.value;
    const rows = await Promise.resolve()
      .then(() => prisma.notificationWorkflow.findMany({
        where: { workspaceId: ws, triggerType: READY_TRIGGER, isEnabled: true, archivedAt: null, publishedVersion: { gt: 0 } },
        select: { enabledAt: true, lastPublishedAt: true, createdAt: true },
        take: 50,
      }))
      .catch(() => []);
    const value = sinceOf(rows);
    this._usesCache.set(ws, { at: now, value });
    return value;
  }

  /**
   * ticket.created was dispatched to workflows for this ticket: remember it
   * (pending) with what the arrival workflows saw. Never throws.
   */
  async noteArrival(ticketId, { workspaceId = null, createdAt = null, suppressRequesterAck = false, createdVia = null, now = new Date() } = {}) {
    try {
      let ws = Number(workspaceId) || null;
      let created = createdAt ? new Date(createdAt) : null;
      if (!ws || !created) {
        const t = await prisma.ticket.findUnique({ where: { id: Number(ticketId) }, select: { workspaceId: true, createdAt: true } });
        if (!t) return { skipped: 'no_ticket' };
        ws = t.workspaceId;
        created = new Date(t.createdAt);
      }
      if (new Date(now).getTime() - created.getTime() > READY_NEW_TICKET_WINDOW_MS) return { skipped: 'not_new' };
      const since = await this.readySince(ws);
      if (!since) return { skipped: 'unused' };
      if (created < since) return { skipped: 'before_trigger_on' };
      const noted = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${READY_LOCK_NAMESPACE}::int, ${Number(ticketId)}::int)`;
        const existing = await tx.ticketActivity.findFirst({ where: { ticketId: Number(ticketId), activityType: READY_ACTIVITY }, select: { id: true } });
        if (existing) return false;
        await tx.ticketActivity.create({
          data: {
            ticketId: Number(ticketId),
            activityType: READY_ACTIVITY,
            performedBy: 'Ticket Pulse',
            performedAt: created,
            details: {
              pending: true,
              suppressRequesterAck: suppressRequesterAck === true,
              createdVia: createdVia || null,
              note: 'Waiting for the ticket to be sorted before "Ticket ready" workflows run',
            },
          },
        });
        return true;
      });
      return noted ? { noted: true } : { already: true };
    } catch (err) {
      logger.warn(`Ticket ready: arrival not noted for ticket ${ticketId}: ${err.message}`);
      return { skipped: 'error', error: err.message };
    }
  }

  /**
   * Claim + emit. Returns { emitted } | { skipped: reason } | { already: true }.
   * Only a ticket whose arrival was noted fires. Never throws.
   */
  async markReady(ticketId, { reason = 'auto_help_done', autoHelpAnswered = null, runId = null, now = new Date() } = {}) {
    try {
      const why = READY_REASONS.includes(reason) ? reason : 'auto_help_done';
      const ticket = await Promise.resolve()
        .then(() => prisma.ticket.findUnique({ where: { id: Number(ticketId) }, select: { id: true, workspaceId: true, createdAt: true } }))
        .catch(() => null);
      if (!ticket) return { skipped: 'no_ticket' };
      const ageMs = new Date(now).getTime() - new Date(ticket.createdAt).getTime();
      if (!(ageMs <= READY_NEW_TICKET_WINDOW_MS)) return { skipped: 'not_new' };

      const claim = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${READY_LOCK_NAMESPACE}::int, ${Number(ticket.id)}::int)`;
        const row = await tx.ticketActivity.findFirst({ where: { ticketId: ticket.id, activityType: READY_ACTIVITY }, select: { id: true, details: true } });
        if (!row) return { skipped: 'not_arrived' };
        const details = row.details && typeof row.details === 'object' ? row.details : {};
        if (details.firedAt) return { already: true };
        const next = {
          ...details,
          pending: false,
          firedAt: new Date(now).toISOString(),
          reason: why,
          note: REASON_NOTES[why],
          waitedSeconds: Math.max(0, Math.round(ageMs / 1000)),
          runId: runId ?? null,
        };
        await tx.ticketActivity.update({ where: { id: row.id }, data: { details: next, performedAt: new Date(now) } });
        return { claimed: next };
      });
      if (!claim.claimed) return claim;

      const answered = autoHelpAnswered === null
        ? why === 'auto_help_answering' || (await this._autoHelpAnswered(ticket.id))
        : autoHelpAnswered === true;
      const { emitTicketEvent } = await import('./ticketLifecycleNotificationService.js');
      await emitTicketEvent(READY_TRIGGER, ticket.id, {
        source: 'ticket_ready',
        dedupeStamp: `ready:${ticket.id}`,
        createdVia: claim.claimed.createdVia || null,
        extra: {
          readyReason: why,
          autoHelpAnswered: answered,
          autoHelpRunId: runId ?? null,
          waitedSeconds: claim.claimed.waitedSeconds,
          // What "Ticket arrived" saw: the agent already replied → no requester ack.
          ...(claim.claimed.suppressRequesterAck ? { suppressRequesterAck: true } : {}),
        },
      });
      logger.info(`Ticket ready: ticket ${ticket.id} (${why}${answered ? ', Auto-help answered' : ''}) after ${claim.claimed.waitedSeconds} s`);
      return { emitted: true, reason: why };
    } catch (err) {
      logger.warn(`Ticket ready not emitted for ticket ${ticketId}: ${err.message}`);
      return { skipped: 'error', error: err.message };
    }
  }

  /** An Auto-help answer already went to the requester (sent by an agent, or by itself). */
  async _autoHelpAnswered(ticketId) {
    const { SENT_DECISIONS } = await import('./autoHelpOutcomes.js');
    const n = await Promise.resolve()
      .then(() => prisma.autoHelpRun.count({ where: { ticketId: Number(ticketId), decision: { in: [...SENT_DECISIONS] } } }))
      .catch(() => 0);
    return Number(n) > 0;
  }

  /**
   * The 3-minute cap: arrivals noted more than READY_MAX_WAIT_MS ago and not
   * yet ready go ahead now.
   */
  async sweep({ now = new Date(), limit = SWEEP_LIMIT } = {}) {
    const nowMs = new Date(now).getTime();
    const rows = await Promise.resolve()
      .then(() => prisma.ticketActivity.findMany({
        where: {
          activityType: READY_ACTIVITY,
          performedAt: { gte: new Date(nowMs - READY_NEW_TICKET_WINDOW_MS), lte: new Date(nowMs - READY_MAX_WAIT_MS) },
        },
        select: { ticketId: true, details: true },
        orderBy: { performedAt: 'asc' },
        take: 500,
      }))
      .catch(() => []);
    let ready = 0;
    for (const row of rows || []) {
      if (ready >= limit) break;
      if (row.details?.firedAt) continue;
      const res = await this.markReady(row.ticketId, { reason: 'timeout', now });
      if (res.emitted) ready += 1;
    }
    return { ready };
  }
}

const ticketReadyService = new TicketReadyService();
export default ticketReadyService;
