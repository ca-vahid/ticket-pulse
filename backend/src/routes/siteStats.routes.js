import express from 'express';
import { requireGlobalAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import usageReportService from '../services/usageReportService.js';

const router = express.Router();

/**
 * Site stats — SUPER ADMIN ONLY (global role, not workspace admins). Who uses
 * the site, which pages and actions, when. Spans all workspaces;
 * ?workspaceId= narrows it. Every view is written to usage_stats_views with
 * the viewer's e-mail.
 */
router.use(requireGlobalAdmin);

const params = (req) => ({ days: req.query.days, workspaceId: req.query.workspaceId });
const viewer = (req) => (req.session?.user ?? req.user ?? null)?.email;

router.get('/overview', asyncHandler(async (req, res) => {
  const data = await usageReportService.overview(params(req));
  usageReportService.logView(viewer(req), 'overview');
  res.json({ success: true, data });
}));

router.get('/people', asyncHandler(async (req, res) => {
  const data = await usageReportService.peopleReport(params(req));
  usageReportService.logView(viewer(req), 'people');
  res.json({ success: true, data });
}));

router.get('/items', asyncHandler(async (req, res) => {
  const data = await usageReportService.itemsReport(params(req));
  usageReportService.logView(viewer(req), 'items');
  res.json({ success: true, data });
}));

export default router;
