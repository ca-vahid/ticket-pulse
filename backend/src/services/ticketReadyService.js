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
 * Exactly once per ticket, and only for tickets that arrived in the last
 * READY_NEW_TICKET_WINDOW_MS and after the workspace's first "Ticket ready"
 * workflow was switched on (turning one on never fires for the tickets of the
 * last two hours): the claim is a 'ticket_ready' activity written
 * under a per-ticket advisory lock; workflow runs dedupe on `ready:<id>` too.
 * Workspaces with no enabled "Ticket ready" workflow are skipped entirely
 * (no activity, no event).
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

  /** Workspaces with an enabled "Ticket ready" workflow → since when (for the sweep). */
  async _workspacesUsingTrigger() {
    const rows = await Promise.resolve()
      .then(() => prisma.notificationWorkflow.findMany({
        where: { triggerType: READY_TRIGGER, isEnabled: true, archivedAt: null, publishedVersion: { gt: 0 } },
        select: { workspaceId: true, enabledAt: true, lastPublishedAt: true, createdAt: true },
        take: 200,
      }))
      .catch(() => []);
    const by = new Map();
    for (const r of rows || []) by.set(r.workspaceId, [...(by.get(r.workspaceId) || []), r]);
    return [...by.entries()].map(([workspaceId, list]) => ({ workspaceId, since: sinceOf(list) })).filter((w) => w.since);
  }

  /**
   * Claim + emit. Returns { emitted } | { skipped: reason } | { already: true }.
   * Never throws.
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
      const since = await this.readySince(ticket.workspaceId);
      if (!since) return { skipped: 'unused' };
      if (new Date(ticket.createdAt) < since) return { skipped: 'before_trigger_on' };

      const claimed = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${READY_LOCK_NAMESPACE}::int, ${Number(ticket.id)}::int)`;
        const existing = await tx.ticketActivity.findFirst({ where: { ticketId: ticket.id, activityType: READY_ACTIVITY }, select: { id: true } });
        if (existing) return false;
        await tx.ticketActivity.create({
          data: {
            ticketId: ticket.id,
            activityType: READY_ACTIVITY,
            performedBy: 'Ticket Pulse',
            performedAt: new Date(now),
            details: { reason: why, note: REASON_NOTES[why], waitedSeconds: Math.max(0, Math.round(ageMs / 1000)), runId: runId ?? null },
          },
        });
        return true;
      });
      if (!claimed) return { already: true };

      const answered = autoHelpAnswered === null
        ? why === 'auto_help_answering' || (await this._autoHelpAnswered(ticket.id))
        : autoHelpAnswered === true;
      const { emitTicketEvent } = await import('./ticketLifecycleNotificationService.js');
      await emitTicketEvent(READY_TRIGGER, ticket.id, {
        source: 'ticket_ready',
        dedupeStamp: `ready:${ticket.id}`,
        extra: {
          readyReason: why,
          autoHelpAnswered: answered,
          autoHelpRunId: runId ?? null,
          waitedSeconds: Math.max(0, Math.round(ageMs / 1000)),
        },
      });
      logger.info(`Ticket ready: ticket ${ticket.id} (${why}${answered ? ', Auto-help answered' : ''}) after ${Math.round(ageMs / 1000)} s`);
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
   * The 3-minute cap: new tickets in workspaces that use the trigger, older
   * than READY_MAX_WAIT_MS and not yet ready, go ahead now.
   */
  async sweep({ now = new Date(), limit = SWEEP_LIMIT } = {}) {
    const workspaces = await this._workspacesUsingTrigger();
    if (!workspaces.length) return { ready: 0 };
    const nowMs = new Date(now).getTime();
    const windowStart = nowMs - READY_NEW_TICKET_WINDOW_MS;
    const tickets = await Promise.resolve()
      .then(() => prisma.ticket.findMany({
        where: {
          OR: workspaces.map((w) => ({
            workspaceId: w.workspaceId,
            createdAt: { gte: new Date(Math.max(windowStart, w.since.getTime())), lte: new Date(nowMs - READY_MAX_WAIT_MS) },
          })),
        },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: 500,
      }))
      .catch(() => []);
    if (!tickets.length) return { ready: 0 };
    const ids = tickets.map((t) => t.id);
    const done = await Promise.resolve()
      .then(() => prisma.ticketActivity.findMany({ where: { ticketId: { in: ids }, activityType: READY_ACTIVITY }, select: { ticketId: true } }))
      .catch(() => null);
    if (done === null) return { ready: 0 };
    const doneIds = new Set(done.map((d) => d.ticketId));
    let ready = 0;
    for (const id of ids) {
      if (ready >= limit) break;
      if (doneIds.has(id)) continue;
      const res = await this.markReady(id, { reason: 'timeout', now });
      if (res.emitted) ready += 1;
    }
    return { ready };
  }
}

const ticketReadyService = new TicketReadyService();
export default ticketReadyService;
