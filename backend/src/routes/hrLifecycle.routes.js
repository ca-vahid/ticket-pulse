import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAdmin } from '../middleware/auth.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import hrLifecycleService, { HR_LIFECYCLE_MODES, TEMPLATE_LABELS, TEMPLATE_NAMES, isAvailable } from '../services/hrLifecycleService.js';
import { resolveTicketRefOrThrow } from '../services/ticketRefResolver.js';

/**
 * Onboarding / Offboarding (plans/HR_LIFECYCLE_PLAN.md). Mounted at
 * /api/hr-lifecycle behind requireAuth + requireWorkspace + requireWorkspaceAccess.
 *
 *   GET  /status                     any member — is the section here, which mode
 *   everything else                  workspace admins (requireAdmin) and only in
 *                                    the workspaces HR_LIFECYCLE_WORKSPACE_IDS
 *                                    lists (404 elsewhere)
 */
const router = express.Router();

const sessionUser = (req) => req.session?.user ?? req.user ?? null;

function requireAvailable(req, _res, next) {
  if (!isAvailable(req.workspaceId)) return next(new NotFoundError('Onboarding is not available in this workspace'));
  return next();
}

router.get('/status', asyncHandler(async (req, res) => {
  const available = isAvailable(req.workspaceId);
  res.json({ success: true, data: { available, mode: available ? await hrLifecycleService.getMode(req.workspaceId) : 'off' } });
}));

router.use(requireAvailable, requireAdmin);

router.get('/settings', asyncHandler(async (req, res) => {
  const [settings, people] = await Promise.all([
    hrLifecycleService.getSettings(req.workspaceId),
    hrLifecycleService.people(req.workspaceId),
  ]);
  res.json({
    success: true,
    data: {
      settings,
      modes: HR_LIFECYCLE_MODES,
      templateNames: TEMPLATE_NAMES,
      templateLabels: TEMPLATE_LABELS,
      detection: hrLifecycleService.detectionRules(),
      ...people,
    },
  });
}));

router.put('/settings', asyncHandler(async (req, res) => {
  const result = await hrLifecycleService.updateSettings(req.workspaceId, req.body || {}, sessionUser(req));
  res.json({ success: true, data: result });
}));

router.get('/settings/changes', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await hrLifecycleService.listSettingsChanges(req.workspaceId, { limit: req.query.limit }) });
}));

router.get('/families', asyncHandler(async (req, res) => {
  const status = ['open', 'closed', 'cancelled'].includes(req.query.status) ? req.query.status : null;
  const kind = ['offboarding', 'onboarding'].includes(req.query.kind) ? req.query.kind : null;
  res.json({ success: true, data: await hrLifecycleService.listFamilies(req.workspaceId, { status, kind, limit: req.query.limit }) });
}));

router.get('/families/:id', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await hrLifecycleService.getFamily(Number(req.params.id), req.workspaceId) });
}));

router.post('/families/:id/after-the-fact', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await hrLifecycleService.switchToAfterTheFact(Number(req.params.id), req.workspaceId, sessionUser(req)) });
}));

router.get('/events', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await hrLifecycleService.listEvents(req.workspaceId, { limit: req.query.limit, familyId: req.query.familyId || null }) });
}));

/** Open notices with no family yet, each with what Organise would take in and create. */
router.get('/candidates', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await hrLifecycleService.candidates(req.workspaceId) });
}));

/** Start the family of one notice now (Live only): existing tickets are taken in, missing ones created. */
router.post('/organise', asyncHandler(async (req, res) => {
  const id = Number(req.body?.ticketId);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('Give the notice ticket id');
  res.json({ success: true, data: await hrLifecycleService.organise(id, req.workspaceId, sessionUser(req)) });
}));

/** Classify a ticket (id or TP-#### / #FS ref) and show what would happen. Writes nothing. */
router.post('/preview', asyncHandler(async (req, res) => {
  const raw = req.body?.ticketId ?? req.body?.ref;
  if (raw === undefined || raw === null || String(raw).trim() === '') throw new ValidationError('Give a ticket id or reference');
  const ticket = /^\d+$/.test(String(raw).trim()) && req.body?.ticketId !== undefined
    ? { id: Number(raw) }
    : await resolveTicketRefOrThrow(raw, req.workspaceId);
  res.json({ success: true, data: await hrLifecycleService.preview(ticket.id, req.workspaceId) });
}));

export default router;
