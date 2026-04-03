import logger from '../utils/logger.js';

const WORKSPACE_EXEMPT_PATHS = [
  '/auth',
  '/workspaces',
  '/health',
];

/**
 * Middleware that resolves the active workspace from the session or header.
 * Attaches req.workspaceId (Int) for use by downstream handlers.
 *
 * Note: Auth, workspace, and health routes are mounted BEFORE this middleware
 * in the router chain (index.js), so they never reach this middleware.
 * The exempt paths list is a safety net only.
 */
export function requireWorkspace(req, res, next) {
  if (WORKSPACE_EXEMPT_PATHS.some(p => req.path.startsWith(p))) {
    return next();
  }

  const fromHeader = req.headers['x-workspace-id'];
  const fromSession = req.session?.user?.selectedWorkspaceId;
  const fromQuery = req.query.workspaceId;

  const raw = fromHeader || fromSession || fromQuery;

  if (raw) {
    req.workspaceId = Number(raw);
    if (Number.isNaN(req.workspaceId)) {
      return res.status(400).json({ success: false, message: 'Invalid workspace ID' });
    }
    return next();
  }

  logger.warn(`No workspace specified for ${req.method} ${req.path}`);
  return res.status(400).json({ success: false, message: 'Workspace selection required' });
}
