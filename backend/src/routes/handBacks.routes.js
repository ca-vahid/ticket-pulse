import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { AuthorizationError } from '../utils/errors.js';
import ticketHandBackService, { HAND_BACK_REASONS } from '../services/ticketHandBackService.js';

/**
 * Hand-backs review (QA 09-25 item 3). Mounted behind requireWorkspace +
 * requireWorkspaceAccess: the Assignment Review "Hand-backs" tab, the Bounced
 * tab on a technician page, and the handoff strip read from here.
 */
const router = express.Router();

// Same as middleware/auth.js sessionUser(); inlined so partial auth mocks keep working.
const sessionUser = (req) => req.session?.user ?? req.user ?? null;

// Reviewers and admins (Assignment Review), plus read-only observers (the
// technician page's Bounced tab). Basic members don't see who handed back what.
const REVIEW_ROLES = new Set(['admin', 'reviewer', 'readonly']);
router.use(asyncHandler(async (req, _res, next) => {
  const user = sessionUser(req);
  if (user?.role === 'admin') return next();
  const { default: workspaceRepository } = await import('../services/workspaceRepository.js');
  const role = user?.email && req.workspaceId
    ? await workspaceRepository.getAccessRole(user.email, req.workspaceId).catch(() => null)
    : null;
  if (REVIEW_ROLES.has(role)) return next();
  throw new AuthorizationError('Reviewer access required', 'reviewer_required');
}));

// GET /api/hand-backs?reason=&from=&to=&technicianId=&limit=
router.get('/', asyncHandler(async (req, res) => {
  const reason = req.query.reason && HAND_BACK_REASONS[String(req.query.reason)] ? String(req.query.reason) : null;
  const technicianId = Number.parseInt(req.query.technicianId, 10);
  const data = await ticketHandBackService.listForWorkspace(req.workspaceId, {
    reason,
    from: req.query.from || null,
    to: req.query.to || null,
    technicianId: Number.isInteger(technicianId) && technicianId > 0 ? technicianId : null,
    limit: req.query.limit,
  });
  res.json({ success: true, data });
}));

// GET /api/hand-backs/ticket/:ticketId — the reasons given on one ticket.
router.get('/ticket/:ticketId', asyncHandler(async (req, res) => {
  const ticketId = Number.parseInt(req.params.ticketId, 10);
  if (!Number.isInteger(ticketId) || ticketId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid ticket id' });
  }
  const rows = await ticketHandBackService.forTicket(ticketId, req.workspaceId);
  res.json({ success: true, data: rows });
}));

export default router;
