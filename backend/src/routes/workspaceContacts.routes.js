import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAdmin, requireWorkspaceAccess, sessionUser } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/workspace.js';
import { ValidationError } from '../utils/errors.js';
import workspaceContactService from '../services/workspaceContactService.js';

/**
 * Settings -> Contacts (QA 11-26 item 2), mounted at /api/settings/contacts.
 *
 * Workspace admins of the SELECTED workspace (or super admins) only; every
 * refusal is a 403 from requireAdmin, never a 401. The workspace is always the
 * one the request is scoped to (x-workspace-id / selected workspace): a body or
 * query workspaceId naming another one is refused rather than followed, and a
 * contact id from another workspace is a 404. Sandbox writes are refused in
 * the service.
 */
const router = express.Router();

router.use(requireWorkspace, requireWorkspaceAccess, requireAdmin);

function sameWorkspace(req, _res, next) {
  const named = req.body?.workspaceId ?? req.query?.workspaceId;
  if (named !== undefined && named !== null && named !== '' && Number(named) !== req.workspaceId) {
    return next(new ValidationError('That workspace is not the one selected'));
  }
  return next();
}
router.use(sameWorkspace);

const actorEmail = (req) => sessionUser(req)?.email || null;

router.get('/', asyncHandler(async (req, res) => {
  const data = await workspaceContactService.list(req.workspaceId, { search: req.query.q || req.query.search || '' });
  res.json({ success: true, data });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name, email, phone, jobTitle, note } = req.body || {};
  const data = await workspaceContactService.add(req.workspaceId, { name, email, phone, jobTitle, note }, actorEmail(req));
  res.status(data.existing ? 200 : 201).json({ success: true, data });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const { name, email, phone, jobTitle, note } = req.body || {};
  const data = await workspaceContactService.update(req.workspaceId, req.params.id, { name, email, phone, jobTitle, note }, actorEmail(req));
  res.json({ success: true, data });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const data = await workspaceContactService.remove(req.workspaceId, req.params.id, actorEmail(req));
  res.json({ success: true, data });
}));

export default router;
