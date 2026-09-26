import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { ValidationError } from '../utils/errors.js';
import knowledgeGapService from '../services/knowledgeGapService.js';
import articleDraftService, { DRAFT_MAX_TICKETS } from '../services/articleDraftService.js';
import knowledgeSettingsService from '../services/knowledgeSettingsService.js';
import fsSolutionImportService, { fsCallsAllowed } from '../services/fsSolutionImportService.js';
import knowledgeReviewDigestService from '../services/knowledgeReviewDigestService.js';
import autoHelpBacktestService, { MAX_N } from '../services/autoHelpBacktestService.js';
import { resolveTicketRefOrThrow } from '../services/ticketRefResolver.js';

/**
 * Knowledge that grows (Auto-help P1, plans/AUTO_HELP_P1_PLAN.md §4-§5):
 * gaps, drafting articles from solved tickets, FreshService import settings,
 * the review digest and playbook backtests. Mounted by knowledge.routes.js,
 * which passes in ITS role gates, so Knowledge keeps one place that decides
 * who may manage it. Reads are open to workspace members; anything that
 * writes, costs a model call or calls FreshService needs the manager gate;
 * recomputing the gaps (?refresh=1, embeddings + a big scan) needs the
 * review capability.
 */

// Drafting costs a model call: at most DRAFT_RATE_LIMIT per person per minute.
export const DRAFT_RATE_LIMIT = 6;
const DRAFT_WINDOW_MS = 60 * 1000;
const draftHits = new Map();
export function _resetDraftRateLimit() { draftHits.clear(); }

export default function knowledgeGrowthRoutes({
  requireKnowledgeManager, requireKnowledgeReviewer = requireKnowledgeManager, sessionUser, actorOf,
}) {
  const router = express.Router();
  const wantsRefresh = (req) => req.query.refresh === '1' || req.query.refresh === 'true';
  // A cached read is open to members; forcing a recompute needs the review capability.
  const refreshNeedsReviewer = (req, res, next) => (wantsRefresh(req) ? requireKnowledgeReviewer(req, res, next) : next());

  const draftRateLimit = (req, res, next) => {
    const u = sessionUser(req);
    const key = String(u?.email || u?.name || req.ip || 'anon').toLowerCase();
    const now = Date.now();
    const recent = (draftHits.get(key) || []).filter((t) => now - t < DRAFT_WINDOW_MS);
    if (recent.length >= DRAFT_RATE_LIMIT) {
      const retryAfter = Math.max(1, Math.ceil((DRAFT_WINDOW_MS - (now - recent[0])) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        success: false,
        code: 'knowledge_draft_rate_limited',
        message: `That's ${DRAFT_RATE_LIMIT} drafts in a minute. Give it ${retryAfter} seconds and try again.`,
      });
    }
    recent.push(now);
    draftHits.set(key, recent);
    return next();
  };

  // ---------- gaps ----------

  router.get('/gaps', refreshNeedsReviewer, asyncHandler(async (req, res) => {
    const data = await knowledgeGapService.gaps(req.workspaceId, {
      days: req.query.days,
      refresh: wantsRefresh(req),
    });
    res.json({ success: true, data });
  }));

  // ---------- drafts from solved tickets ----------

  /** A gap cluster or hand-picked tickets (ids or refs like TP-1234 / #241406) -> a draft article. */
  router.post('/drafts', requireKnowledgeManager, draftRateLimit, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const ids = Array.isArray(body.ticketIds) ? body.ticketIds.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
    const refs = Array.isArray(body.ticketRefs) ? body.ticketRefs.map((r) => String(r || '').trim()).filter(Boolean) : [];
    if (ids.length + refs.length > 60) throw new ValidationError('Too many tickets');
    for (const ref of refs.slice(0, DRAFT_MAX_TICKETS)) {
      const t = await resolveTicketRefOrThrow(ref, req.workspaceId);
      if (!ids.includes(t.id)) ids.push(t.id);
    }
    if (!ids.length) throw new ValidationError('Pick at least one solved ticket');
    const kind = body.kind === 'gap' ? 'gap' : 'tickets';
    const result = await articleDraftService.draftFromTickets(req.workspaceId, ids, actorOf(req), {
      playbookId: body.playbookId || null, topic: body.topic || null, kind,
    });
    knowledgeGapService.clearCache(req.workspaceId);
    res.status(201).json({ success: true, data: result });
  }));

  /** "Turn into an article" on a ticket with a verified solution (reopens its draft when one exists). */
  router.post('/drafts/from-ticket/:ticketId', requireKnowledgeManager, draftRateLimit, asyncHandler(async (req, res) => {
    const result = await articleDraftService.draftFromTicket(req.workspaceId, req.params.ticketId, actorOf(req));
    res.status(result.reused ? 200 : 201).json({ success: true, data: result });
  }));

  // ---------- settings: FreshService import + review digest ----------

  router.get('/growth-settings', asyncHandler(async (req, res) => {
    const settings = await knowledgeSettingsService.get(req.workspaceId);
    res.json({ success: true, data: { ...settings, fsCallsAllowed: fsCallsAllowed() } });
  }));

  router.put('/growth-settings', requireKnowledgeManager, asyncHandler(async (req, res) => {
    const body = req.body || {};
    // Folder ids must be folders of THIS workspace's FreshService (checked live when FreshService may be called).
    if (Array.isArray(body.fsFolderIds) && body.fsFolderIds.length) {
      await fsSolutionImportService.validateFolderIds(req.workspaceId, body.fsFolderIds.map(String));
    }
    const settings = await knowledgeSettingsService.update(req.workspaceId, body, actorOf(req));
    res.json({ success: true, data: { ...settings, fsCallsAllowed: fsCallsAllowed() } });
  }));

  router.get('/fs-import/folders', requireKnowledgeManager, asyncHandler(async (req, res) => {
    const data = await fsSolutionImportService.listFolders(req.workspaceId, { refresh: req.query.refresh === '1' });
    res.json({ success: true, data });
  }));

  /**
   * "Import now" (the nightly import on demand): starts a background job on
   * the interactive FreshService lane and answers 202 with its id at once.
   * Outside production it answers 200 with the dry-run plan.
   */
  router.post('/fs-import/run', requireKnowledgeManager, asyncHandler(async (req, res) => {
    const data = await fsSolutionImportService.startImport(req.workspaceId, { actor: actorOf(req), dryRun: req.body?.dryRun === true });
    res.status(data?.jobId ? 202 : 200).json({ success: true, data });
  }));

  /** The import's progress (any container): the latest job, or one job by id. */
  router.get('/fs-import/status', requireKnowledgeManager, asyncHandler(async (req, res) => {
    res.json({ success: true, data: await fsSolutionImportService.jobStatus(req.workspaceId) });
  }));

  router.get('/fs-import/jobs/:jobId', requireKnowledgeManager, asyncHandler(async (req, res) => {
    res.json({ success: true, data: await fsSolutionImportService.jobStatus(req.workspaceId, String(req.params.jobId).slice(0, 80)) });
  }));

  /** The signed-in person's own articles due for review, grouped by category. */
  router.get('/review-digest', asyncHandler(async (req, res) => {
    const email = sessionUser(req)?.email || null;
    res.json({ success: true, data: await knowledgeReviewDigestService.forOwner(req.workspaceId, email) });
  }));

  // ---------- backtests ----------

  router.get('/playbooks/:id/backtest', requireKnowledgeManager, asyncHandler(async (req, res) => {
    res.json({ success: true, data: await autoHelpBacktestService.estimate(req.workspaceId, req.params.id, { n: req.query.n }) });
  }));

  router.post('/playbooks/:id/backtest', requireKnowledgeManager, asyncHandler(async (req, res) => {
    const { n, confirm } = req.body || {};
    if (confirm !== true) throw new ValidationError('Confirm the estimated cost to start the backtest');
    if (Number(n) > MAX_N) throw new ValidationError(`At most ${MAX_N} tickets per backtest`);
    const job = await autoHelpBacktestService.start(req.workspaceId, req.params.id, { n, actor: actorOf(req) });
    res.status(202).json({ success: true, data: job });
  }));

  router.get('/playbooks/:id/backtest-results', asyncHandler(async (req, res) => {
    res.json({ success: true, data: await autoHelpBacktestService.results(req.workspaceId, req.params.id, { limit: req.query.limit }) });
  }));

  router.get('/backtest', asyncHandler(async (req, res) => {
    res.json({ success: true, data: await autoHelpBacktestService.status(req.workspaceId) });
  }));

  router.delete('/backtest', requireKnowledgeManager, asyncHandler(async (req, res) => {
    res.json({ success: true, data: await autoHelpBacktestService.cancel(req.workspaceId) });
  }));

  return router;
}
