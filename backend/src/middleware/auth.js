import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import { AuthenticationError } from '../utils/errors.js';
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
 * Middleware to check if user is authenticated.
 * Checks session cookie first, then falls back to JWT in Authorization header.
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
      req.user = decoded;
      if (!req.session.user) {
        req.session.user = decoded;
      } else {
        req.session.user.email = decoded.email;
        req.session.user.name = decoded.name;
        req.session.user.role = decoded.role;
      }
      return next();
    } catch {
      // Invalid or expired token — fall through to auth error
    }
  }

  logger.warn(`Unauthorized access attempt to ${req.path}`);
  throw new AuthenticationError('Authentication required');
}

/**
 * Middleware to check if user is admin — either globally or for the
 * current workspace (live DB check via workspace_access.role).
 */
export async function requireAdmin(req, res, next) {
  if (req.session?.user?.role === 'admin') {
    return next();
  }

  const email = req.session?.user?.email;
  if (email && req.workspaceId) {
    try {
      const wsRepo = await getWsRepo();
      const wsRole = await wsRepo.getAccessRole(email, req.workspaceId);
      if (wsRole === 'admin') {
        return next();
      }
    } catch (err) {
      logger.error('Error checking workspace admin role:', err.message);
    }
  }

  logger.warn(`Unauthorized admin access attempt to ${req.path}`);
  throw new AuthenticationError('Admin access required');
}

/**
 * Middleware to verify the authenticated user has access to req.workspaceId.
 * Global admins are always allowed. Viewers must have a workspace_access row
 * (checked live against the DB, not the stale session cache).
 */
export async function requireWorkspaceAccess(req, res, next) {
  if (req.session?.user?.role === 'admin') {
    return next();
  }

  const email = req.session?.user?.email;
  if (email && req.workspaceId) {
    try {
      const wsRepo = await getWsRepo();
      const wsRole = await wsRepo.getAccessRole(email, req.workspaceId);
      if (wsRole) {
        return next();
      }
    } catch (err) {
      logger.error('Error checking workspace access:', err.message);
    }
  }

  logger.warn(`Workspace access denied for ${email} to workspace ${req.workspaceId}`);
  throw new AuthenticationError('You do not have access to this workspace');
}

/**
 * Optional auth middleware - doesn't throw error if not authenticated
 */
export function optionalAuth(req, res, next) {
  next();
}
