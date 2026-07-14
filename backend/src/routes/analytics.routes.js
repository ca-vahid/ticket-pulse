import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import analyticsService from '../services/analyticsService.js';

const router = express.Router();

router.get('/categories', asyncHandler(async (req, res) => {
  const data = await analyticsService.getCategoryMetadata(req.workspaceId);
  res.json({ success: true, data });
}));

router.get('/overview', asyncHandler(async (req, res) => {
  const data = await analyticsService.getOverview(req.workspaceId, req.query);
  res.json({ success: true, data });
}));

router.get('/demand-flow', asyncHandler(async (req, res) => {
  const data = await analyticsService.getDemandFlow(req.workspaceId, req.query);
  res.json({ success: true, data });
}));

router.get('/category-intelligence', asyncHandler(async (req, res) => {
  const data = await analyticsService.getCategoryIntelligence(req.workspaceId, req.query);
  res.json({ success: true, data });
}));

router.get('/team-balance', asyncHandler(async (req, res) => {
  const data = await analyticsService.getTeamBalance(req.workspaceId, req.query);
  res.json({ success: true, data });
}));

router.get('/quality', asyncHandler(async (req, res) => {
  const data = await analyticsService.getQuality(req.workspaceId, req.query);
  res.json({ success: true, data });
}));

router.get('/automation-ops', asyncHandler(async (req, res) => {
  const data = await analyticsService.getAutomationOps(req.workspaceId, req.query);
  res.json({ success: true, data });
}));

router.get('/insights', asyncHandler(async (req, res) => {
  const data = await analyticsService.getInsights(req.workspaceId, req.query);
  res.json({ success: true, data });
}));

// ---- Reports (feedback 07-14): saved snapshots — deterministic dataset +
// clearly-labeled AI narrative for weekly meetings.
router.get('/reports', asyncHandler(async (req, res) => {
  const { default: reportService } = await import('../services/reportService.js');
  res.json({ success: true, data: await reportService.list(req.workspaceId) });
}));

router.post('/reports', asyncHandler(async (req, res) => {
  const { default: reportService } = await import('../services/reportService.js');
  const row = await reportService.generate(req.workspaceId, {
    scope: req.body?.scope,
    rangeDays: req.body?.rangeDays,
    title: req.body?.title,
  }, req.session?.user || null);
  res.status(201).json({ success: true, data: row });
}));

router.get('/reports/:id', asyncHandler(async (req, res) => {
  const { default: reportService } = await import('../services/reportService.js');
  res.json({ success: true, data: await reportService.get(req.params.id, req.workspaceId) });
}));

router.patch('/reports/:id', asyncHandler(async (req, res) => {
  const { default: reportService } = await import('../services/reportService.js');
  res.json({ success: true, data: await reportService.rename(req.params.id, req.workspaceId, req.body?.title) });
}));

router.delete('/reports/:id', asyncHandler(async (req, res) => {
  const { default: reportService } = await import('../services/reportService.js');
  res.json({ success: true, data: await reportService.remove(req.params.id, req.workspaceId) });
}));

export default router;
