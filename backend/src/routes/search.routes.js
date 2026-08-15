import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireWorkspace } from '../middleware/workspace.js';
import { AuthenticationError, AuthorizationError } from '../utils/errors.js';
import workspaceRepository from '../services/workspaceRepository.js';
import prisma from '../services/prisma.js';
import globalSearchService from '../services/globalSearchService.js';
import logger from '../utils/logger.js';

/**
 * Multi-entity search for the command palette (QA 08-04 #2, Phase 7).
 *
 * GET /api/search?q=&types=tickets,tasks,agents,requesters,departments
 *
 * Access model mirrors the native ticketing router (tickets.routes.js), which
 * is why this mounts BEFORE the global requireWorkspaceAccess chain: agents
 * have no workspace_access rows but are first-class palette users — an active
 * technician profile in the workspace grants access, same as /api/tickets.
 */
const router = express.Router();

router.use(requireWorkspace);

router.use(asyncHandler(async (req, _res, next) => {
  const user = (req.session?.user ?? req.user);
  const email = user?.email?.toLowerCase();
  if (!email) throw new AuthenticationError('Authentication required');
  if (user.role === 'admin') return next();

  const [workspaceRole, technician] = await Promise.all([
    workspaceRepository.getAccessRole(email, req.workspaceId),
    prisma.technician.findFirst({
      where: {
        workspaceId: req.workspaceId,
        isActive: true,
        email: { equals: email, mode: 'insensitive' },
      },
      select: { id: true },
    }),
  ]);
  if (!workspaceRole && !technician) {
    logger.warn(`Search access denied for ${email} in workspace ${req.workspaceId}`);
    // 403, not 401: the caller is authenticated — lacking membership must not
    // trigger the frontend's credential recovery/sign-out (Phase A1).
    throw new AuthorizationError('You do not have access to search in this workspace', 'workspace_access_denied');
  }
  return next();
}));

router.get('/', asyncHandler(async (req, res) => {
  const result = await globalSearchService.search(req.workspaceId, {
    q: req.query.q,
    types: req.query.types,
  });
  res.json({ success: true, data: result });
}));

export default router;
