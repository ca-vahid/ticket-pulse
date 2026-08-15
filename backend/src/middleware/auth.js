import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import { AuthenticationError, AuthorizationError } from '../utils/errors.js';
import logger from '../utils/logger.js';

// Lazy import to avoid circular dependency (workspaceRepository → prisma → ...)
let _wsRepo = null;
async function getWsRepo() {
  if (!_wsRepo) {
    const mod = await import('../services/workspaceRepository.js');
    _wsRepo = mod.default;
  }
  return _wsRepo;
}

/**
 * Permission constants for future use (ticket assignment, granular access).
 */
export const PERMISSIONS = {
  VIEW_DASHBOARD: 'view_dashboard',
  MANAGE_SETTINGS: 'manage_settings',
  ASSIGN_TICKETS: 'assign_tickets',
  MANAGE_WORKSPACE: 'manage_workspace',
};

/**
 * The authenticated identity for this request, regardless of transport:
 * session cookie (req.session.user) or Bearer JWT (req.user, set by
 * requireAuth). Session wins when both are present.
 *
 * Every identity read downstream of requireAuth should go through this (or
 * inline `req.session?.user ?? req.user`) — Bearer-only requests no longer
 * write req.session.user, so reading the session alone misses them.
 */
export function sessionUser(req) {
  return req.session?.user ?? req.user ?? null;
}

/**
 * Middleware to check if user is authenticated.
 * Checks session cookie first, then falls back to JWT in Authorization header.
 *
 * Bearer requests set req.user ONLY — they deliberately do NOT write
 * req.session.user. With saveUninitialized:false, writing the session on a
 * cookie-less Bearer request minted a brand-new session ROW in Postgres on
 * every single API call (cookie-blocking browsers = thousands of orphan rows).
 * Downstream readers use sessionUser(req) / `req.session?.user ?? req.user`.
 */
export function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const token = authHeader.substring(7);
      const decoded = jwt.verify(token, config.session.secret, { algorithms: ['HS256'] });
      req.user = {
        email: decoded.email,
        name: decoded.name,
        username: decoded.username || decoded.name,
        role: decoded.role,
        selectedWorkspaceId: decoded.selectedWorkspaceId,
      };
      return next();
    } catch {
      // Invalid or expired token — fall through to auth error
    }
  }

  logger.warn(`Unauthorized access attempt to ${req.path}`);
  throw new AuthenticationError('Authentication required');
}

/**
 * Middleware to check if user is reviewer or admin — allows access to
 * ticket assignment features (view queue, approve/reject, add notes).
 * Global admins always pass. Workspace admins and reviewers pass.
 *
 * Refusals are 403 AuthorizationError (NOT 401): the caller is authenticated,
 * they just lack the role — the frontend must not run auth recovery for this.
 */
export function requireReviewer(req, res, next) {
  const user = sessionUser(req);
  if (user?.role === 'admin') {
    return next();
  }

  const email = user?.email;
  if (!email || !req.workspaceId) {
    logger.warn(`Reviewer access refused for ${req.path} (no email or workspaceId)`);
    return next(new AuthorizationError('Reviewer access required', 'reviewer_required'));
  }

  getWsRepo()
    .then(wsRepo => wsRepo.getAccessRole(email, req.workspaceId))
    .then(wsRole => {
      if (wsRole === 'admin' || wsRole === 'reviewer') return next();
      logger.warn(`Reviewer access refused for ${req.path} by ${email}`);
      next(new AuthorizationError('Reviewer access required', 'reviewer_required'));
    })
    .catch(err => {
      logger.error('Error checking workspace reviewer role:', err.message);
      next(new AuthorizationError('Reviewer access required', 'reviewer_required'));
    });
}

/**
 * Middleware to check if user is admin — either globally or for the
 * current workspace (live DB check via workspace_access.role).
 * Refusals are 403 AuthorizationError (authenticated but not permitted).
 */
export function requireAdmin(req, res, next) {
  const user = sessionUser(req);
  if (user?.role === 'admin') {
    return next();
  }

  const email = user?.email;
  if (!email || !req.workspaceId) {
    logger.warn(`Admin access refused for ${req.path} (no email or workspaceId)`);
    return next(new AuthorizationError('Admin access required', 'admin_required'));
  }

  getWsRepo()
    .then(wsRepo => wsRepo.getAccessRole(email, req.workspaceId))
    .then(wsRole => {
      if (wsRole === 'admin') return next();
      logger.warn(`Admin access refused for ${req.path} by ${email}`);
      next(new AuthorizationError('Admin access required', 'admin_required'));
    })
    .catch(err => {
      logger.error('Error checking workspace admin role:', err.message);
      next(new AuthorizationError('Admin access required', 'admin_required'));
    });
}

/**
 * GLOBAL admins only ("super admins") — workspace-scoped admins do NOT pass.
 * For cross-workspace surfaces like the AI usage/cost report, which exposes
 * every workspace's data regardless of which workspace is selected.
 * Refusals are 403 AuthorizationError (authenticated but not permitted).
 */
export function requireGlobalAdmin(req, res, next) {
  const user = sessionUser(req);
  if (user?.role === 'admin') {
    return next();
  }
  logger.warn(`Global-admin access refused for ${req.path} by ${user?.email || 'anonymous'}`);
  return next(new AuthorizationError('Super admin access required', 'super_admin_required'));
}

/**
 * Middleware to verify the authenticated user has access to req.workspaceId.
 * Global admins are always allowed. Viewers must have a workspace_access row
 * (checked live against the DB, not the stale session cache).
 *
 * Refusals are 403 AuthorizationError with code 'workspace_access_denied'
 * (NOT 401) — global-'agent' users hitting gated endpoints with perfectly
 * valid credentials must never trigger the frontend's sign-out recovery.
 */
export function requireWorkspaceAccess(req, res, next) {
  const user = sessionUser(req);
  if (user?.role === 'admin') {
    return next();
  }

  const email = user?.email;
  if (!email || !req.workspaceId) {
    logger.warn('Workspace access denied: no email or workspaceId');
    return next(new AuthorizationError('You do not have access to this workspace', 'workspace_access_denied'));
  }

  getWsRepo()
    .then(wsRepo => wsRepo.getAccessRole(email, req.workspaceId))
    .then(wsRole => {
      if (wsRole) return next();
      logger.warn(`Workspace access denied for ${email} to workspace ${req.workspaceId}`);
      next(new AuthorizationError('You do not have access to this workspace', 'workspace_access_denied'));
    })
    .catch(err => {
      logger.error('Error checking workspace access (DB):', err.message);
      // DB error is not an access denial — let the request through and let
      // downstream handlers deal with it, rather than locking users out
      next();
    });
}

/**
 * Agent-allowed tier (Mega 08-15 Phase A1): passes everyone
 * requireWorkspaceAccess passes, PLUS global-'agent' users who are active
 * technicians in the workspace. Used for the small READ-ONLY set the ticket
 * queue needs (/sse, GET /settings/ticket-types) — same membership model as
 * the native ticketing router (tickets.routes.js resolveTicketActor).
 * Settings writes and analytics stay behind requireWorkspaceAccess/+admin.
 */
export function requireWorkspaceMemberOrAgent(req, res, next) {
  const user = sessionUser(req);
  if (user?.role === 'admin') {
    return next();
  }

  const email = user?.email?.toLowerCase();
  if (!email || !req.workspaceId) {
    logger.warn('Workspace member/agent access denied: no email or workspaceId');
    return next(new AuthorizationError('You do not have access to this workspace', 'workspace_access_denied'));
  }

  getWsRepo()
    .then(wsRepo => Promise.all([
      wsRepo.getAccessRole(email, req.workspaceId),
      wsRepo.hasActiveTechnician(email, req.workspaceId),
    ]))
    .then(([wsRole, isTechnician]) => {
      if (wsRole || isTechnician) return next();
      logger.warn(`Workspace member/agent access denied for ${email} to workspace ${req.workspaceId}`);
      next(new AuthorizationError('You do not have access to this workspace', 'workspace_access_denied'));
    })
    .catch(err => {
      logger.error('Error checking workspace member/agent access (DB):', err.message);
      // Mirror requireWorkspaceAccess: a DB error is not an access denial.
      next();
    });
}

/**
 * Optional auth middleware - doesn't throw error if not authenticated
 */
export function optionalAuth(req, res, next) {
  next();
}
