import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import { AuthenticationError } from '../utils/errors.js';
import logger from '../utils/logger.js';

/**
 * Middleware to check if user is authenticated.
 * Checks session cookie first, then falls back to JWT in Authorization header.
 * The JWT fallback is critical for cross-origin deployments where third-party
 * cookies are blocked (e.g., Chrome incognito with frontend and backend on
 * different domains).
 */
export function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }

  // Fallback: check for JWT bearer token
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const token = authHeader.substring(7);
      const decoded = jwt.verify(token, config.session.secret, { algorithms: ['HS256'] });
      // Attach user to request (session-less auth)
      req.user = decoded;
      req.session.user = decoded;
      return next();
    } catch {
      // Invalid or expired token — fall through to auth error
    }
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
