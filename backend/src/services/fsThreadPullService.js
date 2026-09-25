import prisma from './prisma.js';
import logger from '../utils/logger.js';
import settingsRepository from './settingsRepository.js';
import mirrorService from './mirrorService.js';
import ticketThreadRepository from './ticketThreadRepository.js';
import { TICKET_ORIGIN } from '../utils/ticketOrigin.js';
import { isQuietHours } from '../utils/quietHours.js';

/**
 * FreshService notes and replies on FS-born tickets (plans/FS_THREAD_SYNC_GAP_REPORT.md,
 * 24 Sep 2026). The activity feed ("X added a private note") reached Ticket
 * Pulse within a minute, but the conversation itself only on open, in the
 * today-cohort preheat, or at resolution through a hook the fast sync made
 * dead (resolvedAt was already set). About 11,000 tickets were missing notes.
 *
 * Three feeds, one queue:
 *  - on change: a new note / reply / forward activity line queues its ticket
 *    (ticketThreadRepository.bulkUpsert);
 *  - on close: a sync that moves a ticket to Resolved/Closed queues it
 *    (syncService._upsertTicket);
 *  - the gap sweep: tickets whose activity feed shows more notes/replies than
 *    stored conversation rows, walked a workspace at a time (the backfill, and
 *    the net under the two above — the in-memory queue does not survive a
 *    restart, the sweep does).
 *
 * Low-priority FreshService lane, a few tickets per tick, and the whole worker
 * stands down while the shared queue is busy, so it can never starve the syncs
 * or the mirror. A pull that times out in the queue is re-queued, never dropped.
 */

export const NOTE_ACTIVITY_RE = /(added a (?:private |public )?note|replied|forwarded)/i;
const DEBOUNCE_MS = 90 * 1000;
const TICK_MS = 30 * 1000;
const PULLS_PER_TICK = 5;
const PULLS_PER_TICK_QUIET = 10; // 20:00–05:59 PT and weekends: the budget is free
const BUSY_QUEUE_DEPTH = 30; // above this: a trickle of one ticket a tick
const HARD_BUSY_QUEUE_DEPTH = 150; // above this: stand down completely
// 25 Sep 2026: "stand down at 30" stalled the backfill for hours — the regular
// background work keeps 30–100 low-priority requests queued most of the time,
// and pulls wait their turn in that queue anyway. A trickle keeps it moving.
const MAX_QUEUE = 20000;
const MAX_ATTEMPTS = 6;
const SWEEP_EVERY_TICKS = 2; // one sweep step a minute
const SWEEP_SCAN_IDS = 2500; // ticket-id range examined per sweep step
const SWEEP_QUEUE_CEILING = 40; // do not feed the queue past this
const STATE_KEY = 'fs_thread_backfill_state';
const ENABLED_KEY = 'fs_thread_backfill_enabled';
// Workspace order for the backfill: IT's last 90 days first (Vahid, 24 Sep).
export const SWEEP_PHASES = [
  { workspaceId: 1, days: 90 },
  { workspaceId: 1, days: null },
  { workspaceId: 2, days: null },
  { workspaceId: 3, days: null },
  { workspaceId: 4, days: null },
  { workspaceId: 5, days: null },
];

const GAP_SQL = (days) => `
  SELECT t.id, t.workspace_id AS "workspaceId"
  FROM tickets t
  WHERE t.workspace_id = $1
    AND t.origin = 'freshservice'
    AND t.freshservice_ticket_id IS NOT NULL
    AND t.id > $2 AND t.id <= $3
    ${days ? `AND t.created_at > now() - interval '${Number(days)} days'` : ''}
    AND (t.fs_thread_pulled_at IS NULL OR t.freshservice_updated_at > t.fs_thread_pulled_at)
    AND (SELECT count(*) FROM ticket_thread_entries a
         WHERE a.ticket_id = t.id AND a.source = 'freshservice_activity'
           AND a.content ~* '(added a (private |public )?note|replied|forwarded)')
      > (SELECT count(*) FROM ticket_thread_entries c
         WHERE c.ticket_id = t.id AND c.source = 'freshservice_conversation')
  ORDER BY t.id
  LIMIT 50`;

class FsThreadPullService {
  constructor() {
    this.queue = new Map(); // ticketId -> { workspaceId, dueAt, attempts, reason }
    this.timer = null;
    this.running = false;
    this.ticks = 0;
    this.stats = { pulled: 0, entries: 0, requeued: 0, dropped: 0, deferred: 0, trickled: 0, sweepQueued: 0 };
    this.lastStatusLogAt = 0;
    this.lastGapLogAt = Date.now() - 5.5 * 60 * 60 * 1000; // first gap line ~30 min after boot, not during the boot rush
  }

  /** Queue a conversation pull. A burst for one ticket collapses into one pull. */
  enqueue(ticketId, workspaceId, reason = 'change', { delayMs = DEBOUNCE_MS } = {}) {
    const id = Number(ticketId);
    if (!id) return false;
    const existing = this.queue.get(id);
    if (!existing && this.queue.size >= MAX_QUEUE) return false;
    this.queue.set(id, {
      workspaceId: Number(workspaceId) || existing?.workspaceId || null,
      dueAt: Date.now() + delayMs,
      attempts: existing?.attempts || 0,
      reason: existing?.reason || reason,
    });
    return true;
  }

  /** New thread rows from the activity sync: queue tickets with a new note/reply line. */
  noteActivityArrived(entries = []) {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let queued = 0;
    for (const e of entries) {
      if (e?.source !== 'freshservice_activity') continue;
      if (!NOTE_ACTIVITY_RE.test(String(e.content || e.title || ''))) continue;
      if (/updated a note/i.test(String(e.content || ''))) continue;
      const at = e.occurredAt ? new Date(e.occurredAt).getTime() : Date.now();
      if (at < cutoff) continue; // history is the sweep's job
      if (this.enqueue(e.ticketId, e.workspaceId, 'note_activity')) queued += 1;
    }
    return queued;
  }

  start() {
    if (this.timer) return;
    if (process.env.FS_THREAD_PULL_ENABLED === 'false') return;
    this.timer = setInterval(() => { this.tick().catch((err) => logger.warn(`FS thread pull tick failed (non-fatal): ${err.message}`)); }, TICK_MS);
    this.timer.unref?.();
    logger.info(`FS thread pull worker started (every ${TICK_MS / 1000}s, ${PULLS_PER_TICK} tickets a tick)`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async _queueDepth(workspaceId) {
    try {
      const client = await mirrorService.getClient(workspaceId || 1);
      const stats = typeof client?.getLimiterStats === 'function' ? client.getLimiterStats() : null;
      const depth = Number(stats?.queueDepth);
      return Number.isFinite(depth) ? depth : 0;
    } catch {
      return 0;
    }
  }

  async tick(now = Date.now()) {
    if (this.running) return;
    this.running = true;
    try {
      this.ticks += 1;
      const depth = await this._queueDepth(1);
      this._logStatus(now, depth);
      if (depth >= HARD_BUSY_QUEUE_DEPTH) {
        this.stats.deferred += 1;
        return;
      }
      const perTick = depth >= BUSY_QUEUE_DEPTH ? 1 : (isQuietHours(new Date(now)) ? PULLS_PER_TICK_QUIET : PULLS_PER_TICK);
      if (depth >= BUSY_QUEUE_DEPTH) this.stats.trickled += 1;
      const due = [...this.queue.entries()]
        .filter(([, v]) => v.dueAt <= now)
        .sort((a, b) => a[1].dueAt - b[1].dueAt)
        .slice(0, perTick);
      for (const [ticketId, item] of due) {
        this.queue.delete(ticketId);
        try {
          const n = await this.pull(ticketId);
          this.stats.pulled += 1;
          this.stats.entries += n;
        } catch (err) {
          const attempts = (item.attempts || 0) + 1;
          const queueTimeout = err?.code === 'FS_QUEUE_TIMEOUT' || /rate-limit queue|429/i.test(String(err?.message || ''));
          if (queueTimeout || attempts < MAX_ATTEMPTS) {
            // Back off and try again; a congested queue is never a reason to drop.
            const backoff = Math.min(10 * 60 * 1000, 60 * 1000 * attempts);
            this.queue.set(ticketId, { ...item, attempts: queueTimeout ? item.attempts : attempts, dueAt: Date.now() + backoff });
            this.stats.requeued += 1;
          } else {
            this.stats.dropped += 1;
            logger.warn(`FS thread pull gave up on ticket ${ticketId} after ${attempts} attempts: ${err.message}`);
          }
        }
      }
      if (this.ticks % SWEEP_EVERY_TICKS === 0) await this.sweepStep().catch((err) => logger.warn(`FS thread gap sweep step failed (non-fatal): ${err.message}`));
      // The notes gap, logged every 6 h so the briefs and the hourly review can
      // see it move (target: about 0 per workspace for the last 90 days).
      if (!this.lastGapLogAt || now - this.lastGapLogAt >= 6 * 60 * 60 * 1000) {
        this.lastGapLogAt = now;
        const gap = await this.gapReport({ days: 90 }).catch(() => null);
        if (gap) logger.info(`FS notes gap (last 90 days, tickets): ${Object.entries(gap).map(([k, v]) => `${k}=${v}`).join(' ')} · pulled ${this.stats.pulled}, queued ${this.queue.size}`);
      }
    } finally {
      this.running = false;
    }
  }

  /** One status line an hour, so the hourly review can see the worker move. */
  _logStatus(now, depth) {
    if (now - this.lastStatusLogAt < 60 * 60 * 1000) return;
    this.lastStatusLogAt = now;
    const s = this.stats;
    logger.info(`FS thread pull: pulled ${s.pulled} (${s.entries} entries), queued ${this.queue.size}, requeued ${s.requeued}, dropped ${s.dropped}, trickle ticks ${s.trickled}, stood down ${s.deferred}, FS queue ${depth}`);
  }

  /** Pull one FS-born ticket's whole conversation (no 60-entry cap) and store it. */
  async pull(ticketId) {
    const ticket = await prisma.ticket.findUnique({
      where: { id: Number(ticketId) },
      select: { id: true, workspaceId: true, origin: true, freshserviceTicketId: true, freshserviceUpdatedAt: true },
    });
    if (!ticket?.freshserviceTicketId || ticket.origin !== TICKET_ORIGIN.FRESHSERVICE) return 0;
    const client = await mirrorService.getClient(ticket.workspaceId);
    if (!client) return 0;
    const fsId = Number(ticket.freshserviceTicketId);
    const conversations = await client.fetchTicketConversations(fsId);
    let upserted = 0;
    if (conversations?.length) {
      const { transformTicketConversationEntries } = await import('../integrations/freshserviceTransformer.js');
      const entries = transformTicketConversationEntries(conversations, { ticketId: ticket.id, workspaceId: ticket.workspaceId });
      if (entries.length) ({ upserted } = await ticketThreadRepository.bulkUpsert(entries));
    }
    // Mark it checked (fs_thread_pulled_at — the preheat's conversation cursor
    // could read "caught up" with notes still missing, 24 Sep sample #241450):
    // the gap sweep/metric treat a ticket pulled since its last FreshService
    // change as settled (FS can hold
    // fewer conversations than activity lines — deleted or merged notes — and
    // such a ticket must not be re-pulled on every lap).
    await prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        fsThreadPulledAt: new Date(),
        ...(ticket.freshserviceUpdatedAt ? { conversationsSyncFreshserviceUpdatedAt: ticket.freshserviceUpdatedAt } : {}),
      },
    }).catch(() => {});
    return upserted || 0;
  }

  async _enabled() {
    try {
      const raw = await settingsRepository.get(ENABLED_KEY);
      return raw === null || raw === undefined || String(raw) !== 'false';
    } catch {
      return true;
    }
  }

  async _state() {
    try {
      const raw = await settingsRepository.get(STATE_KEY);
      const s = raw ? JSON.parse(raw) : null;
      if (s && Number.isInteger(s.phase)) return s;
    } catch { /* fresh start */ }
    return { phase: 0, afterId: 0, queued: 0, startedAt: new Date().toISOString() };
  }

  async _maxTicketId() {
    const row = await prisma.ticket.aggregate({ _max: { id: true } }).catch(() => null);
    return row?._max?.id || 0;
  }

  /**
   * One step of the gap sweep: scan the next ticket-id range of the current
   * phase and queue the tickets whose stored conversation falls short of their
   * activity feed. Wraps round after the last phase, so it keeps catching new
   * gaps after the backfill is done.
   */
  async sweepStep() {
    if (this.queue.size >= SWEEP_QUEUE_CEILING) return { skipped: 'queue_full' };
    if (!(await this._enabled())) return { skipped: 'disabled' };
    const state = await this._state();
    const phase = SWEEP_PHASES[state.phase % SWEEP_PHASES.length];
    const maxId = await this._maxTicketId();
    const from = state.afterId || 0;
    const to = from + SWEEP_SCAN_IDS;
    const rows = await prisma.$queryRawUnsafe(GAP_SQL(phase.days), phase.workspaceId, from, to).catch((err) => {
      logger.warn(`FS thread gap sweep query failed (non-fatal): ${err.message}`);
      return null;
    });
    if (rows === null) return { skipped: 'query_failed' };
    for (const r of rows) {
      if (this.enqueue(r.id, r.workspaceId, 'backfill', { delayMs: 0 })) this.stats.sweepQueued += 1;
    }
    // A full page means more gaps inside this range: resume after the last one.
    let next = rows.length >= 50 ? Number(rows[rows.length - 1].id) : to;
    let nextPhase = state.phase;
    if (next >= maxId) {
      logger.info(`FS thread gap sweep finished phase ${state.phase % SWEEP_PHASES.length} (ws${phase.workspaceId}${phase.days ? `, last ${phase.days} days` : ''})`);
      nextPhase = (state.phase + 1) % SWEEP_PHASES.length;
      next = 0;
    }
    const newState = { ...state, phase: nextPhase, afterId: next, queued: (state.queued || 0) + rows.length, updatedAt: new Date().toISOString() };
    await settingsRepository.set(STATE_KEY, JSON.stringify(newState)).catch(() => {});
    return { queued: rows.length, phase: state.phase, afterId: next };
  }

  /** Notes gap per workspace: FS-born tickets whose activity shows more notes/replies than stored conversation rows. */
  async gapReport({ days = 90 } = {}) {
    const out = {};
    for (const ws of [1, 2, 3, 4, 5]) {
      const rows = await prisma.$queryRawUnsafe(`
        SELECT count(*)::int AS n FROM tickets t
        WHERE t.workspace_id = $1 AND t.origin = 'freshservice' AND t.freshservice_ticket_id IS NOT NULL
          ${days ? `AND t.created_at > now() - interval '${Number(days)} days'` : ''}
          AND (t.fs_thread_pulled_at IS NULL OR t.freshservice_updated_at > t.fs_thread_pulled_at)
          AND (SELECT count(*) FROM ticket_thread_entries a
               WHERE a.ticket_id = t.id AND a.source = 'freshservice_activity'
                 AND a.content ~* '(added a (private |public )?note|replied|forwarded)')
            > (SELECT count(*) FROM ticket_thread_entries c
               WHERE c.ticket_id = t.id AND c.source = 'freshservice_conversation')`, ws).catch(() => null);
      out[`ws${ws}`] = rows?.[0]?.n ?? null;
    }
    return out;
  }

  async status() {
    return {
      queued: this.queue.size,
      stats: { ...this.stats },
      backfill: await this._state(),
      enabled: await this._enabled(),
    };
  }
}

const fsThreadPullService = new FsThreadPullService();
export default fsThreadPullService;
