import workspaceRepository from './workspaceRepository.js';
import syncLogRepository from './syncLogRepository.js';
import ticketRepository from './ticketRepository.js';
import settingsRepository from './settingsRepository.js';
import syncService, { SYNC_LOCK_STALE_MS } from './syncService.js';
import { sendTransactionalEmail } from './transactionalEmailService.js';
import logger from '../utils/logger.js';

/**
 * Sync liveness self-monitoring (realtime plan Phase 3): compares each active
 * workspace's last COMPLETED ticket sync against its scheduler cadence and
 * classifies it ok / late / stale. This is cheap insurance against the
 * "silently dead scheduler" failure class that Kirsten's frozen dashboard
 * LOOKED like (the scheduler was innocent that time — sync_logs proved it —
 * but nothing would have told us if it hadn't been).
 *
 * Surfaces:
 * - GET /api/sync/health (admin) → Settings health card + admin banner.
 * - A background monitor that emails the admin list ONCE per stale incident
 *   (re-armed only after the workspace recovers to ok) via the same
 *   transactional-email path the send-health telemetry rides on.
 */

// Thresholds are multiples of the workspace's sync interval, with absolute
// floors so short intervals (the common 5m) don't page anyone over one slow
// full-sync cycle: a normal cycle can legitimately run several minutes, and
// catch-up/backfill runs take the lock for longer.
// 2026-08-18 alert storm post-mortem: the stale floor must sit ABOVE the
// watchdog's lock-stale threshold (20m) — Accounting's healthy full cycles run
// ~13 min median on a 5-min cadence, so a 15-min floor flapped ok↔stale on
// every slow-but-healthy run and mailed admins once per flap.
export const LATE_MULTIPLIER = 2;
export const STALE_MULTIPLIER = 3;
export const LATE_FLOOR_MS = 10 * 60 * 1000;
export const STALE_FLOOR_MS = 20 * 60 * 1000;

// Debounce for the EMAIL path only (getHealth stays instantaneous — cards and
// banners show the truth): a workspace must be stale on this many consecutive
// monitor ticks (3 × 5m = 15 min confirmed) before the alert latches + sends.
export const STALE_TICKS_TO_ALERT = 3;

const MONITOR_TICK_MS = 5 * 60 * 1000;
// First check waits out startup: the scheduler runs its own catch-up sync on
// boot, so a stale-at-boot DB usually heals itself within minutes.
const MONITOR_INITIAL_DELAY_MS = 10 * 60 * 1000;

/** Mirror the scheduler's interval validation (scheduledSyncService). */
export function effectiveIntervalMinutes(raw) {
  const minutes = Number(raw) || 5;
  return minutes < 1 || minutes > 60 ? 5 : minutes;
}

/**
 * Classify freshness of a completed sync `ageMs` old for a workspace synced
 * every `intervalMinutes`: 'ok' | 'late' | 'stale' (stale ⇒ >3× interval,
 * floored at 15 minutes).
 */
export function classifySyncFreshness(ageMs, intervalMinutes) {
  const intervalMs = effectiveIntervalMinutes(intervalMinutes) * 60 * 1000;
  const staleMs = Math.max(STALE_MULTIPLIER * intervalMs, STALE_FLOOR_MS);
  const lateMs = Math.max(LATE_MULTIPLIER * intervalMs, LATE_FLOOR_MS);
  if (ageMs > staleMs) return 'stale';
  if (ageMs > lateMs) return 'late';
  return 'ok';
}

const STATUS_RANK = { ok: 0, unknown: 1, late: 2, stale: 3 };

class SyncHealthService {
  constructor() {
    this._timer = null;
    this._initialTimer = null;
    // workspaceId -> ISO timestamp of the alert — one alert per stale
    // incident; cleared only when the workspace recovers to 'ok'.
    this._alertedIncidents = new Map();
    // workspaceId -> consecutive stale monitor ticks (email debounce; any
    // non-stale tick resets it).
    this._consecutiveStale = new Map();
  }

  /**
   * Per-workspace sync freshness. Never throws for a single workspace's
   * missing log — a workspace that has never completed a sync is 'unknown'
   * (new workspace / FS not configured), which is visible but non-alerting.
   *
   * Honesty fixes (2026-08-18 alert storm):
   * - A RUNNING sync counts as liveness: age is measured from
   *   max(lastCompletedAt, runningSince), so a slow-but-healthy 13-min full
   *   cycle no longer ages the workspace past the stale floor mid-run. The
   *   credit is voided once the run exceeds SYNC_LOCK_STALE_MS — a genuinely
   *   hung run must still go stale.
   * - Data freshness (MAX(tickets.lastIngestedAt), stamped by BOTH the full
   *   sync and the 60s fast lane) is a second signal: 'stale' requires stale
   *   completions AND stale ingest. Workspaces with no ticket data fall back
   *   to completions-only.
   */
  async getHealth(now = Date.now()) {
    const workspaces = await workspaceRepository.getAllActive();
    const workspaceIds = workspaces.map((ws) => ws.id);
    // Both helpers swallow their own DB errors into an empty Map — a failed
    // side-signal degrades to the old completions-only behavior, never a 500.
    const [runningSinceByWs, dataFreshByWs] = await Promise.all([
      syncLogRepository.getRunningSince(workspaceIds),
      ticketRepository.getMaxLastIngestedAt(workspaceIds),
    ]);

    const rows = await Promise.all(workspaces.map(async (ws) => {
      const intervalMinutes = effectiveIntervalMinutes(ws.syncIntervalMinutes);
      const intervalMs = intervalMinutes * 60 * 1000;
      let lastSync = null;
      try {
        lastSync = await syncLogRepository.getLatestSuccessful(ws.id);
      } catch (error) {
        logger.warn(`Sync health: could not read last sync for workspace ${ws.id}: ${error.message}`);
      }
      const lastSyncAt = lastSync?.completedAt || null;
      const ageMs = lastSyncAt ? now - new Date(lastSyncAt).getTime() : null;

      // In-flight run: the sync_log 'started' row is authoritative; the
      // in-process lock map is a cheap cross-check for the window before the
      // row lands (only meaningful when health runs inside the sync process).
      let runningSinceMs = null;
      const dbRunningSince = runningSinceByWs.get(ws.id);
      if (dbRunningSince) {
        runningSinceMs = new Date(dbRunningSince).getTime();
      } else {
        const inProcessSince = syncService.runningWorkspaces?.get?.(ws.id);
        if (typeof inProcessSince === 'number') runningSinceMs = inProcessSince;
      }
      const runningForMs = runningSinceMs === null ? null : Math.max(0, now - runningSinceMs);
      // A run past the watchdog threshold is presumed hung — no liveness credit.
      const syncRunning = runningForMs !== null && runningForMs <= SYNC_LOCK_STALE_MS;

      // Classify on now - max(lastCompletedAt, runningSince): a healthy
      // in-flight run keeps the workspace fresh however long the previous
      // completion has aged.
      let effectiveAgeMs = ageMs;
      if (syncRunning) {
        effectiveAgeMs = ageMs === null ? runningForMs : Math.min(ageMs, runningForMs);
      }

      const dataFreshDate = dataFreshByWs.get(ws.id) || null;
      const dataFreshAt = dataFreshDate ? new Date(dataFreshDate).toISOString() : null;
      const dataAgeMs = dataFreshDate ? Math.max(0, now - new Date(dataFreshDate).getTime()) : null;

      const staleMs = Math.max(STALE_MULTIPLIER * intervalMs, STALE_FLOOR_MS);
      let status = effectiveAgeMs === null ? 'unknown' : classifySyncFreshness(effectiveAgeMs, intervalMinutes);
      // Stale requires BOTH stale completions AND stale ingest: while ticket
      // data keeps arriving (fast lane / webhooks) the dashboards aren't
      // actually serving old data. Null dataFreshAt (empty workspace) keeps
      // the completions-only verdict.
      if (status === 'stale' && dataAgeMs !== null && dataAgeMs <= staleMs) {
        status = 'late';
      }

      return {
        workspaceId: ws.id,
        name: ws.name,
        intervalMinutes,
        lastSyncAt,
        ageMs,
        status,
        syncRunning,
        runningSince: runningSinceMs === null ? null : new Date(runningSinceMs).toISOString(),
        runningForMs,
        dataFreshAt,
        dataAgeMs,
        thresholds: {
          lateMs: Math.max(LATE_MULTIPLIER * intervalMs, LATE_FLOOR_MS),
          staleMs,
        },
      };
    }));

    const overall = rows.reduce(
      (worst, row) => (STATUS_RANK[row.status] > STATUS_RANK[worst] ? row.status : worst),
      'ok',
    );
    return { checkedAt: new Date(now).toISOString(), overall, workspaces: rows };
  }

  /**
   * Monitor tick: alert admins about NEWLY stale workspaces (once per
   * incident), re-arm on recovery. Alert emails ride the transactional-email
   * path, so failures show up in the existing send-health telemetry.
   */
  async checkAndAlert(now = Date.now()) {
    const health = await this.getHealth(now);

    // Recovery re-arms the incident latch (only a full 'ok' clears it, so a
    // workspace flapping between late and stale doesn't re-alert). Any
    // non-stale tick resets the email debounce counter.
    for (const row of health.workspaces) {
      if (row.status === 'ok') this._alertedIncidents.delete(row.workspaceId);
      if (row.status !== 'stale') this._consecutiveStale.delete(row.workspaceId);
    }

    // Debounce: require STALE_TICKS_TO_ALERT consecutive stale ticks before a
    // workspace is email-eligible — one borderline reading (e.g. a slow cycle
    // completing right at the threshold) must not page anyone. getHealth
    // above is untouched: cards/banners show stale immediately.
    for (const row of health.workspaces) {
      if (row.status === 'stale') {
        this._consecutiveStale.set(row.workspaceId, (this._consecutiveStale.get(row.workspaceId) || 0) + 1);
      }
    }

    const newlyStale = health.workspaces.filter(
      (row) => row.status === 'stale'
        && (this._consecutiveStale.get(row.workspaceId) || 0) >= STALE_TICKS_TO_ALERT
        && !this._alertedIncidents.has(row.workspaceId),
    );
    if (newlyStale.length === 0) return { health, alerted: [] };

    // Latch BEFORE sending: a broken email path must not turn into an alert
    // storm (the failure is visible in email send-health instead).
    for (const row of newlyStale) {
      this._alertedIncidents.set(row.workspaceId, new Date(now).toISOString());
    }

    if (process.env.SYNC_HEALTH_ALERTS === 'false') {
      logger.warn(`Sync health: ${newlyStale.length} workspace(s) stale but alerts disabled (SYNC_HEALTH_ALERTS=false)`);
      return { health, alerted: [] };
    }

    try {
      const to = await this._adminEmails();
      if (to.length === 0) {
        logger.warn('Sync health: stale workspace(s) but no admin emails configured');
        return { health, alerted: [] };
      }
      const names = newlyStale.map((r) => r.name).join(', ');
      const rowsHtml = newlyStale.map((r) => {
        const ageMin = r.ageMs === null ? '—' : Math.round(r.ageMs / 60000);
        const freshCell = r.dataAgeMs === null
          ? 'no ticket data yet'
          : `data last arrived ${Math.round(r.dataAgeMs / 60000)} min ago`;
        const runCell = r.runningForMs === null
          ? 'no run in flight'
          : `a run started ${Math.round(r.runningForMs / 60000)} min ago ${r.syncRunning ? 'is still going' : 'appears hung'}`;
        return `<tr><td style="padding:4px 12px 4px 0;"><strong>${r.name}</strong></td><td style="padding:4px 12px 4px 0;">every ${r.intervalMinutes}m</td><td style="padding:4px 12px 4px 0;">last completed sync ${ageMin} min ago</td><td style="padding:4px 12px 4px 0;">${freshCell}</td><td style="padding:4px 0;">${runCell}</td></tr>`;
      }).join('');
      // "Sync now" is bad advice while a run is already in flight (the header
      // disables the button in that state, and for a hung run the next
      // scheduled sync takes the lock over automatically).
      const anyInFlight = newlyStale.some((r) => r.runningSince !== null);
      const advice = anyInFlight
        ? 'Check <strong>Settings → Notifications → Sync freshness</strong> (or GET /api/sync/health) and the app logs. A run is already in flight — do not trigger "Sync now"; a hung run is taken over by the next scheduled sync automatically, so if this persists consider a service restart.'
        : 'Check <strong>Settings → Notifications → Sync freshness</strong> (or GET /api/sync/health), the app logs, and consider "Sync now" or a service restart.';
      const html = `
        <p>Ticket Pulse's FreshService sync has been <strong>stale</strong> for ${STALE_TICKS_TO_ALERT} consecutive checks (no completed sync AND no fresh ticket data in over 3× the configured interval) for:</p>
        <table style="border-collapse:collapse;font-size:14px;">${rowsHtml}</table>
        <p>Dashboards keep serving the last synced data, but new FreshService activity is not arriving.</p>
        <p>${advice} You will not be alerted again for these workspaces until they recover.</p>`;
      const result = await sendTransactionalEmail({
        workspaceId: newlyStale[0].workspaceId,
        to,
        subject: `Ticket Pulse: sync is stale for ${names}`,
        html,
        label: 'sync-health-alert',
      });
      if (result.sent) {
        logger.warn(`Sync health: stale alert emailed to ${to.length} admin(s) for ${names} (via ${result.via})`);
      } else {
        logger.warn(`Sync health: stale alert for ${names} could not be emailed (${result.reason || result.error || 'unknown'})`);
      }
    } catch (error) {
      logger.error('Sync health: stale alert send failed:', error.message);
    }
    return { health, alerted: newlyStale.map((r) => r.workspaceId) };
  }

  async _adminEmails() {
    let raw = null;
    try {
      raw = await settingsRepository.get('admin_emails');
    } catch { /* fall through to env */ }
    const source = raw && raw.trim() ? raw : (process.env.ADMIN_EMAILS || '');
    return source.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  }

  /** Start the background monitor (called from app.js next to the scheduler). */
  start() {
    this.stop();
    this._initialTimer = setTimeout(() => {
      this._initialTimer = null;
      this.checkAndAlert().catch((error) => logger.error('Sync health check failed:', error.message));
      this._timer = setInterval(() => {
        this.checkAndAlert().catch((error) => logger.error('Sync health check failed:', error.message));
      }, MONITOR_TICK_MS);
      this._timer.unref?.();
    }, MONITOR_INITIAL_DELAY_MS);
    this._initialTimer.unref?.();
    logger.info(`Sync health monitor armed (first check in ${MONITOR_INITIAL_DELAY_MS / 60000}m, then every ${MONITOR_TICK_MS / 60000}m)`);
  }

  stop() {
    if (this._initialTimer) {
      clearTimeout(this._initialTimer);
      this._initialTimer = null;
    }
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

export default new SyncHealthService();
export { SyncHealthService };
