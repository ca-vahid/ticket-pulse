import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAdmin } from '../middleware/auth.js';
import statusService from '../services/statusService.js';

/**
 * Per-workspace ticket-status registry (QA 08-04 #12, Phase 8a). Settings
 * CRUD only in this release — queue/board/workflow consumers arrive in 8b/8c.
 *
 * Mounted in routes/index.js AFTER requireAuth + requireWorkspace +
 * requireWorkspaceAccess; every route here is additionally admin-gated, like
 * the other Ticket Ops settings surfaces (SLA policies, macros, types).
 * Statuses are retired (deactivated), never deleted — historical tickets
 * keep their label — so there is deliberately NO DELETE route.
 */
const router = express.Router();

router.use(requireAdmin);

function actorEmail(req) {
  return (req.session?.user ?? req.user)?.email || null;
}

/** Full list including inactive — the Settings manager shows retired rows. */
router.get('/', asyncHandler(async (req, res) => {
  const statuses = await statusService.listStatuses(req.workspaceId, { includeInactive: true });
  res.json({ success: true, data: statuses });
}));

router.post('/', asyncHandler(async (req, res) => {
  const created = await statusService.createStatus(req.workspaceId, req.body || {}, actorEmail(req));
  res.status(201).json({ success: true, data: created });
}));

// Rename (relabels that workspace's tickets transactionally) / recolor /
// reorder / base change (non-system rows only, needs confirmBaseChange).
router.patch('/:id', asyncHandler(async (req, res) => {
  const updated = await statusService.updateStatus(req.workspaceId, req.params.id, req.body || {}, actorEmail(req));
  res.json({ success: true, data: updated });
}));

router.post('/:id/deactivate', asyncHandler(async (req, res) => {
  const updated = await statusService.deactivateStatus(req.workspaceId, req.params.id, actorEmail(req));
  res.json({ success: true, data: updated });
}));

router.post('/:id/reactivate', asyncHandler(async (req, res) => {
  const updated = await statusService.reactivateStatus(req.workspaceId, req.params.id, actorEmail(req));
  res.json({ success: true, data: updated });
}));

export default router;
