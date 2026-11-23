import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAdmin } from '../middleware/auth.js';
import personalApiKeyService from '../services/personalApiKeyService.js';
import { resolvePublicBaseUrl } from '../utils/publicBaseUrl.js';
import { AuthenticationError } from '../utils/errors.js';

// Inline (not auth.js sessionUser / apiKeyAuth clientIp) so the many tests
// that stub those modules for routes/index.js need no new export.
const sessionUser = (req) => req.session?.user ?? req.user ?? null;
const clientIp = (req) => String(req.ip || '').replace(/^::ffff:/i, '') || null;

/**
 * Personal API keys (4.4.05) — the app's session routes.
 *
 *   /api/me/api-keys…                 the signed-in person's own key (owner)
 *   /api/admin/personal-api-keys…     everyone's keys + who may have one (admin)
 *
 * Both are mounted in routes/index.js ABOVE the strict requireWorkspaceAccess
 * gate (agents often have no workspace_access row), behind requireWorkspace +
 * requireWorkspaceMemberOrAgent. The admin router adds requireAdmin (workspace
 * admin of THIS workspace, or super admin). The access list has its own route
 * here and is never written through the generic PUT /api/settings/:key.
 */

function me(req) {
  const user = sessionUser(req);
  if (!user?.email) throw new AuthenticationError('Authentication required');
  return user;
}

function baseUrlFor(req) {
  return resolvePublicBaseUrl() || `${req.protocol}://${req.get('host')}`;
}

export const personalKeysOwnerRouter = express.Router();

personalKeysOwnerRouter.get('/', asyncHandler(async (req, res) => {
  const data = await personalApiKeyService.getOwnerOverview(req.workspaceId, me(req));
  res.json({ success: true, data });
}));

// Declared before '/:id…' so it is never read as a key id.
personalKeysOwnerRouter.get('/guide', asyncHandler(async (req, res) => {
  const data = await personalApiKeyService.ownerGuide(req.workspaceId, me(req), { baseUrl: baseUrlFor(req) });
  res.json({ success: true, data });
}));

personalKeysOwnerRouter.post('/', asyncHandler(async (req, res) => {
  const data = await personalApiKeyService.createOwnKey(req.workspaceId, me(req), req.body || {}, { ip: clientIp(req) });
  res.status(201).json({ success: true, data });
}));

personalKeysOwnerRouter.post('/:id/rotate', asyncHandler(async (req, res) => {
  const data = await personalApiKeyService.rotateOwnKey(req.workspaceId, me(req), req.params.id, { ip: clientIp(req) });
  res.json({ success: true, data });
}));

personalKeysOwnerRouter.delete('/:id', asyncHandler(async (req, res) => {
  await personalApiKeyService.revokeOwnKey(req.workspaceId, me(req), req.params.id);
  res.json({ success: true });
}));

export const personalKeysAdminRouter = express.Router();
personalKeysAdminRouter.use(requireAdmin);

personalKeysAdminRouter.get('/', asyncHandler(async (req, res) => {
  const data = await personalApiKeyService.adminList(req.workspaceId);
  res.json({ success: true, data });
}));

personalKeysAdminRouter.get('/users', asyncHandler(async (req, res) => {
  const data = await personalApiKeyService.adminUsers(req.workspaceId);
  res.json({ success: true, data });
}));

personalKeysAdminRouter.put('/users', asyncHandler(async (req, res) => {
  // { add, remove } (preferred: a delta) or { technicianIds } (the whole list).
  const data = await personalApiKeyService.adminSetUsers(req.workspaceId, req.body || {}, sessionUser(req));
  res.json({ success: true, data });
}));

personalKeysAdminRouter.patch('/:id', asyncHandler(async (req, res) => {
  const data = await personalApiKeyService.adminSetDisabled(req.workspaceId, req.params.id, req.body?.disabled, sessionUser(req));
  res.json({ success: true, data });
}));

personalKeysAdminRouter.delete('/:id', asyncHandler(async (req, res) => {
  await personalApiKeyService.adminRevoke(req.workspaceId, req.params.id, sessionUser(req));
  res.json({ success: true });
}));

export default { personalKeysOwnerRouter, personalKeysAdminRouter };
