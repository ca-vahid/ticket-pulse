import logger from '../utils/logger.js';
import settingsRepository from './settingsRepository.js';
import { isQuietHours } from '../utils/quietHours.js';

/**
 * Nightly history backfill (Vahid, 24 Sep 2026: "backfill up to 3 years of
 * FreshService tickets in IT"). IT held FreshService tickets from Jan 2025 on;
 * FreshService has ~14,000 more IT tickets from Sep 2023 to Dec 2024.
 *
 * Walks one calendar month per run, newest first (Dec 2024 → Sep 2023), with
 * the existing historical backfill (syncService.backfillDateRange: list →
 * upsert → activity analysis, skipExisting). Runs only in quiet hours
 * (20:00–05:59 PT weekdays, all weekend) so the day's syncs keep the
 * FreshService budget. Resumable: the next month to fetch lives in
 * app_settings `history_backfill_state`; `history_backfill_enabled=false`
 * stops it. The conversations for these tickets follow through
 * fsThreadPullService's gap sweep (IT all-time phase).
 */

const STATE_KEY = 'history_backfill_state';
const ENABLED_KEY = 'history_backfill_enabled';
const TICK_MS = 5 * 60 * 1000;
export const DEFAULT_PLAN = { workspaceId: 1, from: '2023-09-01', to: '2024-12-31' };

const iso = (d) => d.toISOString().slice(0, 10);

/** The month window ending at `endIso` (YYYY-MM-DD), clipped at `fromIso`. */
export function monthWindow(endIso, fromIso) {
  const end = new Date(`${endIso}T00:00:00Z`);
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  const from = new Date(`${fromIso}T00:00:00Z`);
  const clipped = start < from ? from : start;
  const prevEnd = new Date(clipped.getTime() - 24 * 60 * 60 * 1000);
  return { startDate: iso(clipped), endDate: endIso, nextEnd: iso(prevEnd), last: clipped <= from };
}

class HistoryBackfillService {
  constructor() {
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    if (process.env.HISTORY_BACKFILL_ENABLED === 'false') return;
    this.timer = setInterval(() => { this.tick().catch((err) => logger.warn(`History backfill tick failed (non-fatal): ${err.message}`)); }, TICK_MS);
    this.timer.unref?.();
    logger.info('History backfill driver started (quiet hours only, one month per run)');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async _enabled() {
    try {
      const raw = await settingsRepository.get(ENABLED_KEY);
      return raw === null || raw === undefined || String(raw) !== 'false';
    } catch {
      return true;
    }
  }

  async state() {
    try {
      const raw = await settingsRepository.get(STATE_KEY);
      const s = raw ? JSON.parse(raw) : null;
      if (s && s.nextEnd) return s;
    } catch { /* fresh plan */ }
    return { ...DEFAULT_PLAN, nextEnd: DEFAULT_PLAN.to, done: false, runs: [] };
  }

  async _save(state) {
    await settingsRepository.set(STATE_KEY, JSON.stringify(state)).catch(() => {});
  }

  async tick(now = new Date(), { force = false } = {}) {
    if (this.running) return { skipped: 'running' };
    if (!force && !isQuietHours(now)) return { skipped: 'working_hours' };
    if (!(await this._enabled())) return { skipped: 'disabled' };
    const state = await this.state();
    if (state.done) return { skipped: 'done' };

    const { default: syncService } = await import('./syncService.js');
    if (syncService.runningWorkspaces?.has?.(`backfill:${state.workspaceId}`)) return { skipped: 'backfill_busy' };

    const win = monthWindow(state.nextEnd, state.from);
    this.running = true;
    const started = Date.now();
    try {
      logger.info(`History backfill: ws${state.workspaceId} ${win.startDate} → ${win.endDate}`);
      const result = await syncService.backfillDateRange({
        startDate: win.startDate,
        endDate: win.endDate,
        workspaceId: state.workspaceId,
        skipExisting: true,
        activityConcurrency: 2,
        triggeredByEmail: 'history-backfill (nightly)',
      });
      if (result?.status === 'skipped') return { skipped: result.reason || 'skipped' };
      if (result?.status === 'cancelled') {
        // Someone stopped it from the backfill panel: pause the plan, don't advance.
        await this._save({ ...state, cancelledAt: new Date().toISOString() });
        await settingsRepository.set(ENABLED_KEY, 'false').catch(() => {});
        logger.info(`History backfill ${win.startDate}..${win.endDate} was cancelled — plan paused (set ${ENABLED_KEY}=true to resume)`);
        return { skipped: 'cancelled' };
      }
      const run = {
        window: `${win.startDate}..${win.endDate}`,
        fetched: result?.ticketsFetched ?? null,
        synced: result?.ticketsSynced ?? null,
        skippedExisting: result?.skipped ?? null,
        minutes: Math.round((Date.now() - started) / 60000),
        at: new Date().toISOString(),
      };
      const next = {
        ...state,
        nextEnd: win.nextEnd,
        done: win.last,
        failures: 0,
        runs: [...(state.runs || []), run].slice(-24),
        updatedAt: new Date().toISOString(),
      };
      await this._save(next);
      logger.info(`History backfill: ${run.window} done (${run.synced ?? '?'} new of ${run.fetched ?? '?'} in ${run.minutes} min)${win.last ? ' — plan complete' : ''}`);
      return { ok: true, ...run };
    } catch (err) {
      // Keep the window; try it again on a later tick.
      await this._save({ ...state, failures: (state.failures || 0) + 1, lastError: String(err.message).slice(0, 200), updatedAt: new Date().toISOString() });
      logger.warn(`History backfill ${win.startDate}..${win.endDate} failed (will retry): ${err.message}`);
      return { error: err.message };
    } finally {
      this.running = false;
    }
  }
}

const historyBackfillService = new HistoryBackfillService();
export default historyBackfillService;
