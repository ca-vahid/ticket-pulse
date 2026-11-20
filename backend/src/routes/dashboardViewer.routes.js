import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { dashboardViewerReadsOnly, sessionUser } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/workspace.js';
import workspaceRepository from '../services/workspaceRepository.js';
import dashboardViewerService from '../services/dashboardViewerService.js';
import analyticsService from '../services/analyticsService.js';
import availabilityService from '../services/availabilityService.js';

/**
 * Dashboard view grant (QA 11-19 item 2) — the reads a listed agent needs
 * besides /dashboard itself. Mounted in routes/index.js ABOVE the strict
 * requireWorkspaceAccess gate, because a listed agent often has no
 * workspace_access row.
 *
 *   GET /dashboard-access         any signed-in person: may I open the
 *                                 Dashboard here? (drives the nav entry and
 *                                 the route gate; says nothing about others)
 *   GET /analytics/categories     the category tree for the Dashboard filter
 *   GET /autoresponse/holidays    the holiday names on the Dashboard calendar
 *
 * The last two answer ONLY a listed viewer (dashboardViewerReadsOnly); for
 * everyone else the request continues to the normal mounts and gates.
 */
const router = express.Router();

router.get('/dashboard-access', requireWorkspace, asyncHandler(async (req, res) => {
  const user = sessionUser(req);
  const email = user?.email;
  if (user?.role === 'admin') {
    return res.json({ success: true, data: { dashboard: true, viaGrant: false } });
  }
  let wsRole = null;
  try {
    wsRole = email ? await workspaceRepository.getAccessRole(email, req.workspaceId) : null;
  } catch {
    wsRole = null;
  }
  if (wsRole === 'admin' || wsRole === 'readonly') {
    return res.json({ success: true, data: { dashboard: true, viaGrant: false } });
  }
  const viaGrant = await dashboardViewerService.isDashboardViewer(email, req.workspaceId);
  return res.json({ success: true, data: { dashboard: viaGrant, viaGrant } });
}));

router.get('/analytics/categories', requireWorkspace, dashboardViewerReadsOnly, asyncHandler(async (req, res) => {
  const data = await analyticsService.getCategoryMetadata(req.workspaceId);
  res.json({ success: true, data });
}));

router.get('/autoresponse/holidays', requireWorkspace, dashboardViewerReadsOnly, asyncHandler(async (req, res) => {
  const data = await availabilityService.getHolidays(req.workspaceId);
  res.json({ success: true, data });
}));

export default router;
