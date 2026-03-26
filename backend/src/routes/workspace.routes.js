import express from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import workspaceRepository from '../services/workspaceRepository.js';
import logger from '../utils/logger.js';

const router = express.Router();

router.use(requireAuth);

/**
 * GET /api/workspaces
 * List workspaces accessible to the current user.
 * Admins see all active workspaces; viewers see only granted ones.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const email = req.session?.user?.email;
    const role = req.session?.user?.role;

    let workspaces;
    if (role === 'admin') {
      workspaces = (await workspaceRepository.getAll()).map(ws => ({
        ...ws,
        role: 'admin',
      }));
    } else {
      workspaces = await workspaceRepository.getAccessibleWorkspaces(email);
    }

    res.json({ success: true, data: workspaces });
  }),
);

/**
 * GET /api/workspaces/:id
 */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const ws = await workspaceRepository.getById(Number(req.params.id));
    res.json({ success: true, data: ws });
  }),
);

/**
 * POST /api/workspaces
 * Create a new workspace (admin only).
 */
router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { name, slug, freshserviceWorkspaceId, defaultTimezone, syncIntervalMinutes } = req.body;

    if (!name || !slug || !freshserviceWorkspaceId) {
      return res.status(400).json({
        success: false,
        message: 'name, slug, and freshserviceWorkspaceId are required',
      });
    }

    const ws = await workspaceRepository.create({
      name,
      slug,
      freshserviceWorkspaceId,
      defaultTimezone,
      syncIntervalMinutes,
    });

    logger.info(`Workspace created: ${name} (slug: ${slug})`);
    res.status(201).json({ success: true, data: ws });
  }),
);

/**
 * PUT /api/workspaces/:id
 * Update workspace config (admin only).
 */
router.put(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const ws = await workspaceRepository.update(Number(req.params.id), req.body);
    res.json({ success: true, data: ws });
  }),
);

/**
 * POST /api/workspaces/select
 * Set the active workspace in the user's session.
 */
router.post(
  '/select',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.body;
    if (!workspaceId) {
      return res.status(400).json({ success: false, message: 'workspaceId is required' });
    }

    const ws = await workspaceRepository.getById(Number(workspaceId));

    if (req.session?.user) {
      req.session.user.selectedWorkspaceId = ws.id;
      req.session.user.selectedWorkspaceName = ws.name;
      req.session.user.selectedWorkspaceSlug = ws.slug;
    }

    logger.info(`User ${req.session?.user?.email} selected workspace: ${ws.name}`);
    res.json({ success: true, data: { workspace: ws } });
  }),
);

/**
 * GET /api/workspaces/:id/access
 * List access grants for a workspace (admin only).
 */
router.get(
  '/:id/access',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const list = await workspaceRepository.getAccessList(Number(req.params.id));
    res.json({ success: true, data: list });
  }),
);

/**
 * POST /api/workspaces/:id/access
 * Grant a user access to a workspace (admin only).
 */
router.post(
  '/:id/access',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { email, role } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'email is required' });
    }

    const access = await workspaceRepository.grantAccess(
      email,
      Number(req.params.id),
      role || 'viewer',
    );

    logger.info(`Granted ${role || 'viewer'} access to ${email} for workspace ${req.params.id}`);
    res.json({ success: true, data: access });
  }),
);

/**
 * DELETE /api/workspaces/:id/access/:email
 * Revoke access (admin only).
 */
router.delete(
  '/:id/access/:email',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const removed = await workspaceRepository.revokeAccess(
      req.params.email,
      Number(req.params.id),
    );

    if (!removed) {
      return res.status(404).json({ success: false, message: 'Access record not found' });
    }

    logger.info(`Revoked access for ${req.params.email} from workspace ${req.params.id}`);
    res.json({ success: true, message: 'Access revoked' });
  }),
);

export default router;
