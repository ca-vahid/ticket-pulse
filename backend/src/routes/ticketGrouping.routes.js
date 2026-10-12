import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAdmin, requireReviewer } from '../middleware/auth.js';
import { ValidationError } from '../utils/errors.js';
import { MODES, SENDER_KINDS } from '../services/ticketGrouping/rules.js';

/**
 * Ticket grouping (plans/TICKET_GROUPING_PLAN.md). Mounted at
 * /api/ticket-grouping behind requireAuth + requireWorkspace.
 *
 *   GET   /                      reviewers — the Grouped page: waiting, combined, repeats, senders, settings
 *   POST  /events/:id/undo       reviewers — put a grouped ticket back as its own work
 *   POST  /events/:id/accept     reviewers — agree with a suggestion
 *   POST  /events/:id/dismiss    reviewers — "not related"
 *   PUT   /settings              admins — on/off, and whether people's tickets are combined or only suggested
 *   PATCH /senders/:id           admins — what kind of mail a sender sends, or stop grouping it
 *
 * The engine is imported lazily: it reaches into the big ticket services and
 * this router must load without them.
 */
const router = express.Router();

const sessionUser = (req) => req.session?.user ?? req.user ?? null;
const engine = async () => (await import('../services/ticketGrouping/groupingService.js')).default;
const actorOf = (req) => {
  const user = sessionUser(req) || {};
  return { email: user.email || null, name: user.name || user.email || 'A coordinator', role: user.role || null, technicianId: null };
};
const idOf = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('That id is not valid.');
  return id;
};

/** The same rule as requireAdmin, asked quietly: the page only uses it to show the switches. Never throws. */
async function canManage(req) {
  try {
    const user = sessionUser(req);
    if (user?.role === 'admin') return true;
    if (!user?.email || !req.workspaceId) return false;
    const { default: wsRepo } = await import('../services/workspaceRepository.js');
    return (await wsRepo.getAccessRole(user.email, req.workspaceId)) === 'admin';
  } catch {
    return false;
  }
}

router.get('/', requireReviewer, asyncHandler(async (req, res) => {
  const service = await engine();
  res.json({ success: true, data: { ...(await service.overview(req.workspaceId, { days: req.query.days })), canManage: await canManage(req) } });
}));

for (const action of ['undo', 'accept', 'dismiss']) {
  router.post(`/events/:id/${action}`, requireReviewer, asyncHandler(async (req, res) => {
    const service = await engine();
    const out = await service[action](idOf(req), req.workspaceId, actorOf(req));
    res.json({ success: true, data: { changed: out.changed, state: out.event.state } });
  }));
}

router.put('/settings', requireAdmin, asyncHandler(async (req, res) => {
  const patch = {};
  if (req.body?.mode !== undefined) {
    if (!MODES.includes(req.body.mode)) throw new ValidationError('Grouping is either on or off.');
    patch.mode = req.body.mode;
  }
  if (req.body?.peopleAuto !== undefined) patch.peopleAuto = req.body.peopleAuto === true;
  const service = await engine();
  res.json({ success: true, data: await service.saveSettings(req.workspaceId, patch) });
}));

router.patch('/senders/:id', requireAdmin, asyncHandler(async (req, res) => {
  const patch = {};
  if (req.body?.kind !== undefined) {
    if (!SENDER_KINDS.includes(req.body.kind)) throw new ValidationError('That kind is not one of: repeating, distinct, unsure.');
    patch.kind = req.body.kind;
  }
  if (req.body?.enabled !== undefined) patch.enabled = req.body.enabled === true;
  const service = await engine();
  const row = await service.updateSender(idOf(req), req.workspaceId, patch, actorOf(req));
  res.json({ success: true, data: { id: row.id, kind: row.kind, enabled: row.enabled, decidedBy: row.decidedBy } });
}));

export default router;
