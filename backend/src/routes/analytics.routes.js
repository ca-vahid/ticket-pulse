import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import analyticsService from '../services/analyticsService.js';

const router = express.Router();

router.get('/overview', asyncHandler(async (req, res) => {
  const data = await analyticsService.getOverview(req.workspaceId, req.query);
  res.json({ success: true, data });
}));

router.get('/demand-flow', asyncHandler(async (req, res) => {
  const data = await analyticsService.getDemandFlow(req.workspaceId, req.query);
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

export default router;
