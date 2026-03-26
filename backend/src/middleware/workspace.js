import logger from '../utils/logger.js';

const WORKSPACE_EXEMPT_PATHS = [
  '/api/auth',
  '/api/workspaces',
  '/api/health',
  '/health',
];

/**
 * Middleware that resolves the active workspace from the session or header.
 * Attaches req.workspaceId (Int) for use by downstream handlers.
 *
 * Exempt paths (auth, workspace selection, health) skip the check.
 * During the transition period, defaults to workspace 1 (IT) if none is set.
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

  // Backward compatibility: default to workspace 1 (IT) when nothing is set.
  // Remove this fallback once all clients send a workspace header.
  req.workspaceId = 1;
  logger.debug(`No workspace specified for ${req.method} ${req.path}, defaulting to 1`);
  next();
}
