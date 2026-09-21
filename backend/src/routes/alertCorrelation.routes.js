import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import alertCorrelationService, { STARTER_RULES } from '../services/alertCorrelationService.js';
import logger from '../utils/logger.js';

/**
 * Alert correlation (20 Sep 2026): pair rules + storm grouping for machine
 * alerts. Reads for any signed-in member of the workspace; writes and the
 * "apply now" button are admin-only.
 */
const router = express.Router();
router.use(requireAuth);

const requestActor = (req) => ({ email: req.user?.email || null, name: req.user?.name || null });
const bad = (res, message) => res.status(400).json({ success: false, message });

router.get('/rules', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await alertCorrelationService.listRules(req.workspaceId) });
}));

router.get('/starter', asyncHandler(async (_req, res) => {
  res.json({ success: true, data: STARTER_RULES });
}));

router.post('/rules', requireAdmin, asyncHandler(async (req, res) => {
  try {
    const rule = await alertCorrelationService.createRule(req.workspaceId, req.body || {}, requestActor(req));
    logger.info(`Alert correlation rule created: ${rule.name} (ws ${req.workspaceId})`);
    res.status(201).json({ success: true, data: rule });
  } catch (err) { return bad(res, err.message); }
}));

router.post('/rules/starter', requireAdmin, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await alertCorrelationService.installStarterRules(req.workspaceId, requestActor(req)) });
}));

router.put('/rules/:id', requireAdmin, asyncHandler(async (req, res) => {
  try {
    res.json({ success: true, data: await alertCorrelationService.updateRule(req.workspaceId, req.params.id, req.body || {}) });
  } catch (err) { return err.message === 'Rule not found' ? res.status(404).json({ success: false, message: err.message }) : bad(res, err.message); }
}));

router.delete('/rules/:id', requireAdmin, asyncHandler(async (req, res) => {
  try {
    res.json({ success: true, data: await alertCorrelationService.deleteRule(req.workspaceId, req.params.id) });
  } catch (err) { return res.status(404).json({ success: false, message: err.message }); }
}));

router.post('/preview', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await alertCorrelationService.preview(req.workspaceId, { days: req.body?.days }) });
}));

router.post('/apply', requireAdmin, asyncHandler(async (req, res) => {
  const out = await alertCorrelationService.applyOpen(req.workspaceId, { days: req.body?.days });
  logger.info(`Alert correlation applied to open tickets (ws ${req.workspaceId}): ${out.handled.length} handled of ${out.evaluated}`);
  res.json({ success: true, data: out });
}));

router.get('/suggestions', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await alertCorrelationService.suggestions(req.workspaceId, { days: req.query?.days }) });
}));

router.get('/activity', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await alertCorrelationService.activity(req.workspaceId, { days: req.query?.days }) });
}));

export default router;
