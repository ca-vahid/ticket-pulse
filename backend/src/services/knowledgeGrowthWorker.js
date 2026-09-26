/**
 * Knowledge growth worker (Auto-help P1, plans/AUTO_HELP_P1_PLAN.md §4).
 * One 10-minute tick drives three jobs:
 *
 *   solution embeddings   nightly, quiet hours (utils/quietHours.js), at most
 *                         once per 20 h: solutionEmbeddingService.runAll
 *   FreshService import   nightly, quiet hours, once per 20 h, workspaces with
 *                         the import on; production only (the service itself
 *                         refuses to call FreshService elsewhere)
 *   review digest         Monday 08:00 Pacific, opted-in workspaces, once a
 *                         week each (knowledgeReviewDigestService.tick)
 *
 * Last-run times live in app_settings `knowledge_growth_state`, so a restart
 * does not re-run a job that already ran tonight. Every job is non-fatal.
 * KNOWLEDGE_GROWTH_WORKER=false switches the whole worker off.
 */
import logger from '../utils/logger.js';
import settingsRepository from './settingsRepository.js';
import { isQuietHours } from '../utils/quietHours.js';

const TICK_MS = 10 * 60 * 1000;
const NIGHTLY_GAP_MS = 20 * 3600e3;
const STATE_KEY = 'knowledge_growth_state';

class KnowledgeGrowthWorker {
  constructor() {
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer || process.env.KNOWLEDGE_GROWTH_WORKER === 'false') return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => logger.warn(`Knowledge growth tick failed (non-fatal): ${err.message}`));
    }, TICK_MS);
    this.timer.unref?.();
    logger.info('Knowledge growth worker started (solution embeddings + FreshService import in quiet hours, review digest Mondays 08:00 PT)');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async _state() {
    try {
      const raw = await settingsRepository.get(STATE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  async _save(state) {
    await settingsRepository.set(STATE_KEY, JSON.stringify(state)).catch(() => {});
  }

  _due(lastIso, now) {
    const last = lastIso ? new Date(lastIso).getTime() : 0;
    return !Number.isFinite(last) || now.getTime() - last >= NIGHTLY_GAP_MS;
  }

  async tick(now = new Date()) {
    if (this.running) return { skipped: 'running' };
    this.running = true;
    const done = {};
    try {
      const state = await this._state();
      if (isQuietHours(now)) {
        if (this._due(state.solutionsAt, now)) {
          const { default: solutionEmbeddingService } = await import('./solutionEmbeddingService.js');
          done.solutions = await solutionEmbeddingService.runAll().catch((err) => ({ error: err.message }));
          state.solutionsAt = now.toISOString();
        }
        if (this._due(state.fsImportAt, now)) {
          const { default: fsSolutionImportService } = await import('./fsSolutionImportService.js');
          done.fsImport = await fsSolutionImportService.runAll().catch((err) => ({ error: err.message }));
          state.fsImportAt = now.toISOString();
        }
      }
      const { default: digest } = await import('./knowledgeReviewDigestService.js');
      done.digest = await digest.tick(now).catch((err) => ({ error: err.message }));
      if (done.solutions || done.fsImport) await this._save(state);
      return done;
    } finally {
      this.running = false;
    }
  }
}

const knowledgeGrowthWorker = new KnowledgeGrowthWorker();
export default knowledgeGrowthWorker;
export { KnowledgeGrowthWorker };
