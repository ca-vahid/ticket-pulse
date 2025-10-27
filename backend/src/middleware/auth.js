import { AuthenticationError } from '../utils/errors.js';
import logger from '../utils/logger.js';

/**
 * Middleware to check if user is authenticated
 */
export function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    // User is authenticated
    return next();
  }

  logger.warn(`Unauthorized access attempt to ${req.path}`);
  throw new AuthenticationError('Authentication required');
}

/**
 * Middleware to check if user is admin (for future role-based access)
 */
export function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') {
    // User is admin
    return next();
  }

  logger.warn(`Unauthorized admin access attempt to ${req.path}`);
  throw new AuthenticationError('Admin access required');
}

/**
 * Optional auth middleware - doesn't throw error if not authenticated
 */
export function optionalAuth(req, res, next) {
  // Just pass through, req.session.user will be available if authenticated
  next();
}
