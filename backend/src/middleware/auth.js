import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import { AuthenticationError } from '../utils/errors.js';
import logger from '../utils/logger.js';

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
 * current workspace (via workspace_access.role).
 */
export function requireAdmin(req, res, next) {
  if (req.session?.user?.role === 'admin') {
    return next();
  }

  const available = req.session?.user?.availableWorkspaces || [];
  const wsMatch = available.find(w => w.id === req.workspaceId);
  if (wsMatch && wsMatch.role === 'admin') {
    return next();
  }

  logger.warn(`Unauthorized admin access attempt to ${req.path}`);
  throw new AuthenticationError('Admin access required');
}

/**
 * Middleware to verify the authenticated user has access to req.workspaceId.
 * Global admins are always allowed. Viewers must have a workspace_access row.
 * Apply after requireWorkspace in the router chain.
 */
export function requireWorkspaceAccess(req, res, next) {
  if (req.session?.user?.role === 'admin') {
    return next();
  }

  const available = req.session?.user?.availableWorkspaces || [];
  if (available.some(w => w.id === req.workspaceId)) {
    return next();
  }

  logger.warn(`Workspace access denied for ${req.session?.user?.email} to workspace ${req.workspaceId}`);
  throw new AuthenticationError('You do not have access to this workspace');
}

/**
 * Optional auth middleware - doesn't throw error if not authenticated
 */
export function optionalAuth(req, res, next) {
  next();
}
