import express from 'express';
import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import { requireAuth, requireAdmin, sessionUser } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { resolveUserAccess } from './auth.routes.js';
import workspaceRepository from '../services/workspaceRepository.js';
import settingsRepository from '../services/settingsRepository.js';
import availabilityService from '../services/availabilityService.js';
import llmConfigService from '../services/llmConfigService.js';
import noiseRuleService from '../services/noiseRuleService.js';
import scheduledSyncService from '../services/scheduledSyncService.js';
import { createFreshServiceClient } from '../integrations/freshservice.js';
import azureAdService from '../services/azureAdService.js';
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
    const user = req.session?.user ?? req.user;
    const email = user?.email;
    const role = user?.role;

    let workspaces;
    if (role === 'admin') {
      workspaces = (await workspaceRepository.getAll()).map(ws => ({
        ...ws,
        role: 'admin',
      }));
    } else {
      // Union of access-row workspaces and technician workspaces (Phase A1
      // picker merge): a partial access grant must never hide the other
      // workspaces the user's technician profiles cover. Access role wins
      // the label; technician-only rows carry role 'agent'.
      workspaces = await workspaceRepository.getMergedWorkspaces(email);
    }

    res.json({ success: true, data: workspaces });
  }),
);

/**
 * Initialize a workspace with defaults (business hours, LLM, sync).
 * Noise rules intentionally start empty outside the IT workspace.
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
 * GET /api/workspaces/users/search?q=<query>
 * Search Azure AD (GAL) for users by name or email prefix.
 * Used by the workspace access panel for autocomplete.
 */
router.get(
  '/users/search',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const q = (req.query.q || '').trim();
    if (q.length < 2) {
      return res.json({ success: true, data: [] });
    }
    if (!azureAdService.isConfigured()) {
      return res.status(400).json({ success: false, message: 'Azure AD is not configured' });
    }
    const results = await azureAdService.searchUsers(q, 8);
    res.json({ success: true, data: results });
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

    // Verify the user has access to this workspace (live DB check). An
    // access row OR an active technician profile qualifies — the merged
    // picker (Phase A1) offers technician workspaces, so select must too.
    const sessionOrTokenUser = req.session?.user ?? req.user;
    const userRole = sessionOrTokenUser?.role;
    if (userRole !== 'admin') {
      const email = sessionOrTokenUser?.email;
      const wsRole = email ? await workspaceRepository.getAccessRole(email, ws.id) : null;
      const isTechnician = !wsRole && email
        ? await workspaceRepository.hasActiveTechnician(email, ws.id)
        : false;
      if (!wsRole && !isTechnician) {
        return res.status(403).json({ success: false, message: 'You do not have access to this workspace', code: 'workspace_access_denied' });
      }
    }

    if (req.session?.user) {
      req.session.user.selectedWorkspaceId = ws.id;
      req.session.user.selectedWorkspaceName = ws.name;
      req.session.user.selectedWorkspaceSlug = ws.slug;
    }

    const user = req.session?.user || req.user || {};

    // Live role refresh (Mega 08-23 AC2): re-resolve the role from the DB
    // before re-signing, so the fresh JWT carries the CURRENT role — a grant
    // or revoke made since login takes effect here, not at the next re-login.
    let effectiveRole = user.role;
    try {
      const resolved = await resolveUserAccess(String(user.email || '').toLowerCase(), user.role);
      effectiveRole = resolved.role;
      if (req.session?.user) {
        req.session.user.role = resolved.role;
        req.session.user.availableWorkspaces = resolved.availableWorkspaces;
      }
    } catch (err) {
      logger.warn('Live access refresh failed on /workspaces/select (keeping session role):', err.message);
    }

    const authToken = jwt.sign(
      {
        email: user.email,
        name: user.name,
        username: user.username || user.name,
        role: effectiveRole,
        selectedWorkspaceId: ws.id,
      },
      config.session.secret,
      { algorithm: 'HS256', expiresIn: config.session.jwtExpiresIn },
    );

    logger.info(`User ${user.email} selected workspace: ${ws.name}`);
    res.json({ success: true, data: { workspace: ws }, authToken });
  }),
);

/**
 * The only roles a workspace_access row may hold. Everything else is a 400 —
 * the old handler upserted `role || 'viewer'` raw, so any string became a
 * "role" (Mega 08-23 AC1 hardening).
 */
const ALLOWED_ACCESS_ROLES = ['viewer', 'reviewer', 'admin'];

/**
 * Bind the admin gate for the /:id/access + /:id/members routes to the
 * TARGET workspace (Mega 08-23 AC1 security fix).
 *
 * These routes are mounted BEFORE requireWorkspace (routes/index.js), so
 * req.workspaceId was never set here: requireAdmin refused every
 * workspace-scoped admin outright, and — had the middleware run — it would
 * have checked the client-controllable x-workspace-id header while the
 * handler mutated req.params.id (cross-workspace privilege escalation).
 *
 * Fix: derive req.workspaceId from the route param itself, so requireAdmin
 * verifies the caller's admin role against the exact workspace being read or
 * mutated. If a non-global-admin request carries a DIFFERENT ambient
 * workspace scope (header or session selection), refuse it explicitly with
 * 403 workspace_mismatch. Global admins may operate on any workspace.
 */
function scopeToTargetWorkspace(req, res, next) {
  const targetId = Number(req.params.id);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid workspace id' });
  }

  const user = sessionUser(req);
  if (user?.role !== 'admin') {
    const scopedRaw = req.headers['x-workspace-id'] ?? user?.selectedWorkspaceId ?? null;
    const scopedId = scopedRaw === null || scopedRaw === undefined || scopedRaw === ''
      ? null
      : Number(scopedRaw);
    if (scopedId !== null && !Number.isNaN(scopedId) && scopedId !== targetId) {
      logger.warn(`Workspace access route refused: ${user?.email || 'unknown'} scoped to workspace ${scopedId} targeted workspace ${targetId}`);
      return res.status(403).json({
        success: false,
        message: 'You can only manage access for your current workspace',
        code: 'workspace_mismatch',
      });
    }
  }

  req.workspaceId = targetId; // requireAdmin checks the role against the TARGET
  return next();
}

/**
 * GET /api/workspaces/:id/access
 * List access grants for a workspace (workspace admin of THAT workspace, or
 * global admin).
 */
router.get(
  '/:id/access',
  scopeToTargetWorkspace,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const list = await workspaceRepository.getAccessList(req.workspaceId);
    res.json({ success: true, data: list });
  }),
);

/**
 * GET /api/workspaces/:id/members
 * App-access ∪ active-technician union for the Members panel (Mega 08-23 AC3):
 * [{ email, name, photoUrl, technicianId?, accessRole }] where accessRole is
 * 'viewer'|'reviewer'|'admin' or null for technician-only people (no app
 * access yet — the Marcus case). Same admin gate as the grant routes.
 */
router.get(
  '/:id/members',
  scopeToTargetWorkspace,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const members = await workspaceRepository.getWorkspaceMembers(req.workspaceId);
    res.json({ success: true, data: members });
  }),
);

/**
 * POST /api/workspaces/:id/access
 * Grant or change a user's access (workspace admin of THAT workspace, or
 * global admin). Ceiling: only GLOBAL admins may grant the admin role or
 * change an existing admin's role — a workspace admin manages up to reviewer.
 */
router.post(
  '/:id/access',
  scopeToTargetWorkspace,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { email, role } = req.body;
    if (!email || !String(email).trim()) {
      return res.status(400).json({ success: false, message: 'email is required' });
    }

    const targetEmail = String(email).trim().toLowerCase();
    const requestedRole = role || 'viewer';
    if (!ALLOWED_ACCESS_ROLES.includes(requestedRole)) {
      return res.status(400).json({
        success: false,
        message: `role must be one of: ${ALLOWED_ACCESS_ROLES.join(', ')}`,
      });
    }

    const actor = sessionUser(req);
    const isGlobalAdmin = actor?.role === 'admin';
    const existingRole = await workspaceRepository.getAccessRole(targetEmail, req.workspaceId);
    if (!isGlobalAdmin && (requestedRole === 'admin' || existingRole === 'admin')) {
      return res.status(403).json({
        success: false,
        message: 'Only a global admin can grant the admin role or change an existing admin',
        code: 'super_admin_required',
      });
    }

    const access = await workspaceRepository.grantAccess(targetEmail, req.workspaceId, requestedRole);

    logger.info('Workspace access granted', {
      actor: actor?.email || null,
      target: targetEmail,
      workspaceId: req.workspaceId,
      oldRole: existingRole || null,
      newRole: requestedRole,
    });
    res.json({ success: true, data: access });
  }),
);

/**
 * DELETE /api/workspaces/:id/access/:email
 * Revoke access (workspace admin of THAT workspace, or global admin).
 * Revoking an existing ADMIN grant requires a global admin — a workspace
 * admin must not be able to remove their peers or themselves from the tier
 * above their ceiling.
 */
router.delete(
  '/:id/access/:email',
  scopeToTargetWorkspace,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const targetEmail = String(req.params.email || '').trim().toLowerCase();
    const actor = sessionUser(req);
    const isGlobalAdmin = actor?.role === 'admin';

    const existingRole = await workspaceRepository.getAccessRole(targetEmail, req.workspaceId);
    if (!existingRole) {
      return res.status(404).json({ success: false, message: 'Access record not found' });
    }
    if (existingRole === 'admin' && !isGlobalAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Only a global admin can revoke an admin grant',
        code: 'super_admin_required',
      });
    }

    const removed = await workspaceRepository.revokeAccess(targetEmail, req.workspaceId);
    if (!removed) {
      return res.status(404).json({ success: false, message: 'Access record not found' });
    }

    logger.info('Workspace access revoked', {
      actor: actor?.email || null,
      target: targetEmail,
      workspaceId: req.workspaceId,
      oldRole: existingRole,
      newRole: null,
    });
    res.json({ success: true, message: 'Access revoked' });
  }),
);

export default router;
