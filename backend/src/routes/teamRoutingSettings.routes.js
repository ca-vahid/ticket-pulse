import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAdmin, requireWorkspaceAccess } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/workspace.js';
import prisma from '../services/prisma.js';
import teamForwardService from '../services/teamForwardService.js';
import { clearReadCache } from '../services/dashboardReadCache.js';
import logger from '../utils/logger.js';

/**
 * QA 09-25 item 6 — people from other teams and their inboxes. Mounted at
 * /api/settings next to settings.routes.js (distinct paths):
 *   PUT /technicians/:id/assignable-only   admin — can own tickets, not counted
 *   GET /team-forwards                     admin — the workspace's list
 *   PUT /team-forwards                     admin — replace the list
 */
const router = express.Router();
const guard = [requireWorkspace, requireWorkspaceAccess, requireAdmin];
const actorEmail = (req) => req.user?.email || req.session?.user?.email || 'unknown';

router.put('/technicians/:id/assignable-only', ...guard, asyncHandler(async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const { assignableOnly } = req.body || {};
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid technician id' });
  }
  if (typeof assignableOnly !== 'boolean') {
    return res.status(400).json({ success: false, message: 'assignableOnly boolean is required' });
  }
  const existing = await prisma.technician.findFirst({
    where: { id, workspaceId: req.workspaceId },
    select: { id: true, name: true, isActive: true },
  });
  if (!existing) return res.status(404).json({ success: false, message: 'Technician not found in this workspace' });
  const tech = await prisma.technician.update({
    where: { id },
    data: { assignableOnly },
    select: { id: true, name: true, isActive: true, assignableOnly: true },
  });
  clearReadCache();
  logger.info(`Technician ${tech.name} (${id}) assignable-only ${assignableOnly ? 'on' : 'off'} by ${actorEmail(req)} in workspace ${req.workspaceId}`);
  res.json({ success: true, data: tech });
}));

router.get('/team-forwards', ...guard, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await teamForwardService.list(req.workspaceId) });
}));

router.put('/team-forwards', ...guard, asyncHandler(async (req, res) => {
  const items = Array.isArray(req.body) ? req.body : req.body?.items;
  const saved = await teamForwardService.replace(req.workspaceId, items);
  logger.info(`Team forwards saved (${saved.length}) by ${actorEmail(req)} in workspace ${req.workspaceId}`);
  res.json({ success: true, data: saved });
}));

export default router;
