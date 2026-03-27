import express from 'express';
import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import workspaceRepository from '../services/workspaceRepository.js';
import settingsRepository from '../services/settingsRepository.js';
import availabilityService from '../services/availabilityService.js';
import llmConfigService from '../services/llmConfigService.js';
import noiseRuleService from '../services/noiseRuleService.js';
import scheduledSyncService from '../services/scheduledSyncService.js';
import { createFreshServiceClient } from '../integrations/freshservice.js';
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
 * Initialize a workspace with defaults (business hours, LLM, noise rules, sync).
 */
async function initializeWorkspace(ws) {
  try {
    await availabilityService.initializeDefaultBusinessHours(ws.id);
  } catch (err) {
    logger.warn(`Failed to init business hours for workspace ${ws.id}:`, err.message);
  }
  try {
    await llmConfigService.initializeDefaultConfig(ws.id);
  } catch (err) {
    logger.warn(`Failed to init LLM config for workspace ${ws.id}:`, err.message);
  }
  try {
    await noiseRuleService.seedDefaults(ws.id);
  } catch (err) {
    logger.warn(`Failed to seed noise rules for workspace ${ws.id}:`, err.message);
  }
  try {
    await scheduledSyncService.startForWorkspace(ws);
    logger.info(`Started sync schedule for workspace "${ws.name}"`);
  } catch (err) {
    logger.warn(`Failed to start sync for workspace ${ws.id}:`, err.message);
  }
}

/**
 * GET /api/workspaces/discover
 * Fetch all workspaces from FreshService and cross-reference with DB.
 * Returns each workspace with status: active, inactive, or new.
 */
router.get(
  '/discover',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const fsConfig = await settingsRepository.getFreshServiceConfig();
    const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey);

    const fsWorkspaces = await client.fetchWorkspaces();

    const dbWorkspaces = await workspaceRepository.getAll();
    const dbInactive = await workspaceRepository.getAllInactive();
    const dbMap = new Map();
    for (const ws of [...dbWorkspaces, ...dbInactive]) {
      dbMap.set(String(ws.freshserviceWorkspaceId), ws);
    }

    const merged = fsWorkspaces.map(fsWs => {
      const fsId = String(fsWs.id);
      const dbWs = dbMap.get(fsId);

      let status = 'new';
      if (dbWs) {
        status = dbWs.isActive ? 'active' : 'inactive';
      }

      return {
        freshserviceId: fsWs.id,
        name: fsWs.name || `Workspace ${fsWs.id}`,
        description: fsWs.description || null,
        primary: fsWs.primary || false,
        status,
        dbWorkspace: dbWs || null,
      };
    });

    res.json({ success: true, data: merged });
  }),
);

/**
 * POST /api/workspaces/activate
 * Activate a FreshService workspace: create DB record if needed,
 * initialize defaults, and start sync schedule.
 */
router.post(
  '/activate',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { freshserviceWorkspaceId, name, slug, defaultTimezone, syncIntervalMinutes } = req.body;

    if (!freshserviceWorkspaceId || !name) {
      return res.status(400).json({
        success: false,
        message: 'freshserviceWorkspaceId and name are required',
      });
    }

    const wsSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    let ws;
    const existing = await workspaceRepository.getByFreshserviceId(freshserviceWorkspaceId);

    if (existing) {
      ws = await workspaceRepository.update(existing.id, { isActive: true });
      logger.info(`Re-activated workspace: ${ws.name}`);
    } else {
      ws = await workspaceRepository.create({
        name,
        slug: wsSlug,
        freshserviceWorkspaceId,
        defaultTimezone: defaultTimezone || 'America/Los_Angeles',
        syncIntervalMinutes: syncIntervalMinutes || 5,
      });
      logger.info(`Created workspace: ${ws.name} (slug: ${ws.slug})`);
    }

    await initializeWorkspace(ws);

    res.status(201).json({ success: true, data: ws });
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
 * Create a new workspace (admin only). Initializes defaults and starts sync.
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

    await initializeWorkspace(ws);

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

    const user = req.session?.user || req.user || {};
    const authToken = jwt.sign(
      {
        email: user.email,
        name: user.name,
        username: user.username || user.name,
        role: user.role,
        selectedWorkspaceId: ws.id,
      },
      config.session.secret,
      { algorithm: 'HS256', expiresIn: '8h' },
    );

    logger.info(`User ${user.email} selected workspace: ${ws.name}`);
    res.json({ success: true, data: { workspace: ws }, authToken });
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
