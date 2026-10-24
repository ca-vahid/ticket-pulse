import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { ValidationError } from '../utils/errors.js';
import confluenceKnowledgeService from '../services/confluenceKnowledgeService.js';

/**
 * Knowledge -> Settings -> Confluence (QA 10-23 #4). Mounted by
 * knowledge.routes.js with ITS gates, like the FreshService import:
 * members read the card and the run history (read-only, no e-mail, never the
 * token); everything that saves, calls Confluence or costs a model call needs
 * the manager gate.
 */
export default function knowledgeConfluenceRoutes({ requireKnowledgeManager, isKnowledgeManager, actorOf }) {
  const router = express.Router();

  router.get('/confluence', asyncHandler(async (req, res) => {
    const canManage = await isKnowledgeManager(req).catch(() => false);
    res.json({ success: true, data: { ...(await confluenceKnowledgeService.view(req.workspaceId, { canManage })), canManage } });
  }));

  router.get('/confluence/runs', asyncHandler(async (req, res) => {
    res.json({ success: true, data: await confluenceKnowledgeService.runs(req.workspaceId, { limit: req.query.limit }) });
  }));

  router.put('/confluence/connection', requireKnowledgeManager, asyncHandler(async (req, res) => {
    const { siteUrl, email, apiToken } = req.body || {};
    res.json({ success: true, data: await confluenceKnowledgeService.saveConnection(req.workspaceId, { siteUrl, email, apiToken }, actorOf(req)) });
  }));

  router.delete('/confluence/connection', requireKnowledgeManager, asyncHandler(async (req, res) => {
    res.json({ success: true, data: await confluenceKnowledgeService.clearConnection(req.workspaceId, actorOf(req)) });
  }));

  router.post('/confluence/test', requireKnowledgeManager, asyncHandler(async (req, res) => {
    res.json({ success: true, data: await confluenceKnowledgeService.testConnection(req.workspaceId) });
  }));

  router.get('/confluence/spaces', requireKnowledgeManager, asyncHandler(async (req, res) => {
    res.json({ success: true, data: await confluenceKnowledgeService.listSpaces(req.workspaceId) });
  }));

  /** The page trees of the chosen spaces with counts; withModel adds the include / skip suggestions. */
  router.post('/confluence/analyze', requireKnowledgeManager, asyncHandler(async (req, res) => {
    const body = req.body || {};
    if (body.spaceIds !== undefined && !Array.isArray(body.spaceIds)) throw new ValidationError('spaceIds must be a list');
    const data = await confluenceKnowledgeService.analyze(req.workspaceId, { spaceIds: body.spaceIds || null, withModel: body.withModel === true, actor: actorOf(req) });
    res.json({ success: true, data });
  }));

  router.put('/confluence/selection', requireKnowledgeManager, asyncHandler(async (req, res) => {
    res.json({ success: true, data: await confluenceKnowledgeService.saveSelection(req.workspaceId, req.body || {}, actorOf(req)) });
  }));

  router.put('/confluence/nightly', requireKnowledgeManager, asyncHandler(async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') throw new ValidationError('enabled must be true or false');
    res.json({ success: true, data: await confluenceKnowledgeService.setNightly(req.workspaceId, req.body.enabled, actorOf(req)) });
  }));

  /** "Run import now": a background job; 202 with its id. */
  router.post('/confluence/import', requireKnowledgeManager, asyncHandler(async (req, res) => {
    res.status(202).json({ success: true, data: await confluenceKnowledgeService.startImport(req.workspaceId, { actor: actorOf(req) }) });
  }));

  router.get('/confluence/import/status', requireKnowledgeManager, asyncHandler(async (req, res) => {
    res.json({ success: true, data: await confluenceKnowledgeService.importStatus(req.workspaceId) });
  }));

  return router;
}
