import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAdmin } from '../middleware/auth.js';
import { ValidationError } from '../utils/errors.js';
import settingsService from '../services/urgentResponse/settingsService.js';
import onCallService from '../services/urgentResponse/onCallService.js';
import { URGENT_RESPONSE_MODES } from '../services/urgentResponse/rules.js';

/**
 * Urgent response (plans/URGENT_RESPONSE_PLAN.md). Mounted at
 * /api/urgent-response behind requireAuth + requireWorkspace +
 * requireWorkspaceMemberOrAgent (see routes/index.js): agents have no
 * workspace_access row, and the on-call schedule and the cover requests are
 * theirs to read and answer.
 *
 *   GET  /status                          any member or agent — the mode, and whether an on-call order is saved
 *   GET  /on-call                         the schedule, who is on call now, me
 *   GET  /on-call/requests/mine           open cover requests waiting for my answer
 *   POST /on-call/requests/:id/respond    accept | decline (first accept wins)
 *   everything else                       workspace admins (requireAdmin)
 *
 * "Me" is the signed-in person's ACTIVE technician row in this workspace,
 * matched by e-mail — the same rule as the ticket routes (resolveTicketActor).
 * The engine (urgentResponseService) is imported lazily: it reaches into the
 * big ticket services, and this router must load without them.
 */
const router = express.Router();

const sessionUser = (req) => req.session?.user ?? req.user ?? null;
const engine = async () => (await import('../services/urgentResponse/urgentResponseService.js')).default;

async function myTechnician(req) {
  return settingsService.technicianForEmail(req.workspaceId, sessionUser(req)?.email);
}

function idParam(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('That id is not valid');
  return id;
}

// ---- any member (agents included) -------------------------------------------

router.get('/status', asyncHandler(async (req, res) => {
  // The SAVED order only: a suggested one is not in force, so there is no schedule to show yet.
  const saved = await settingsService.getSettings(req.workspaceId, { suggest: false });
  res.json({
    success: true,
    data: {
      mode: URGENT_RESPONSE_MODES.includes(saved?.mode) ? saved.mode : 'off',
      onCall: Array.isArray(saved?.onCallOrder) && saved.onCallOrder.length > 0,
    },
  });
}));

router.get('/on-call', asyncHandler(async (req, res) => {
  const now = new Date();
  const plan = await onCallService.schedule(req.workspaceId, { from: now, weeks: req.query.weeks || 8 });
  const current = await onCallService.current(req.workspaceId, now);
  const me = await myTechnician(req);
  res.json({
    success: true,
    data: {
      timezone: plan.timezone,
      handoverDay: plan.handoverDay,
      handoverTime: plan.handoverTime,
      current: {
        technician: current.technician ? { id: current.technician.id, name: current.technician.name } : null,
        scheduled: current.scheduled,
        cover: current.cover,
        until: current.until,
      },
      weeks: plan.weeks,
      me: { technicianId: me?.id ?? null },
    },
  });
}));

router.get('/on-call/requests/mine', asyncHandler(async (req, res) => {
  const me = await myTechnician(req);
  const mine = me ? await onCallService.requestsFor(me.id, { workspaceId: req.workspaceId }) : [];
  // The dates of a request are told in the workspace zone, like the schedule.
  const timezone = mine.length ? await settingsService.timezone(req.workspaceId) : null;
  res.json({ success: true, data: mine.map((r) => ({ ...r, timezone })) });
}));

router.post('/on-call/requests/:id/respond', asyncHandler(async (req, res) => {
  const answer = req.body?.answer;
  if (!['accept', 'decline'].includes(answer)) throw new ValidationError('Answer with "accept" or "decline"');
  const me = await myTechnician(req);
  if (!me) throw new ValidationError('Only technicians of this workspace can answer a cover request');
  res.json({ success: true, data: await onCallService.respond(idParam(req), me.id, answer, { workspaceId: req.workspaceId }) });
}));

// ---- workspace admins ------------------------------------------------------------

router.use(requireAdmin);

router.get('/settings', asyncHandler(async (req, res) => {
  const settings = await settingsService.getSettings(req.workspaceId);
  const technicians = await settingsService.listTechnicians(req.workspaceId);
  const teamsEnabled = await settingsService.teamsEnabled(req.workspaceId);
  const timezone = await settingsService.timezone(req.workspaceId);
  res.json({ success: true, data: { settings, technicians, teamsEnabled, onCallOrderSuggested: settings.onCallOrderSuggested === true, timezone } });
}));

router.put('/settings', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await settingsService.updateSettings(req.workspaceId, req.body || {}, sessionUser(req)) });
}));

router.get('/settings/changes', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await settingsService.listChanges(req.workspaceId, { limit: req.query.limit }) });
}));

/** What a draft of the settings would have done over the last days. Writes nothing. */
router.post('/preview', asyncHandler(async (req, res) => {
  const { days, ...draft } = req.body || {};
  const service = await engine();
  res.json({ success: true, data: await service.preview(req.workspaceId, draft.settings && typeof draft.settings === 'object' ? draft.settings : draft, { days: Number(days) || 30 }) });
}));

router.get('/actions', asyncHandler(async (req, res) => {
  const service = await engine();
  res.json({
    success: true,
    data: await service.listActions(req.workspaceId, {
      limit: req.query.limit, before: req.query.before, layer: req.query.layer || null, shadow: req.query.shadow ?? null,
    }),
  });
}));

router.get('/stats', asyncHandler(async (req, res) => {
  const service = await engine();
  res.json({ success: true, data: await service.stats(req.workspaceId, { days: req.query.days }) });
}));

router.post('/actions/:id/undo', asyncHandler(async (req, res) => {
  const service = await engine();
  // The id must be a row of THIS workspace before anything is moved back.
  const row = await service.getAction(req.workspaceId, idParam(req));
  res.json({ success: true, data: { action: await service.undo(row.id, sessionUser(req)) } });
}));

router.post('/on-call/covers', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await onCallService.createCover(req.workspaceId, req.body || {}, sessionUser(req)) });
}));

router.delete('/on-call/covers/:id', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await onCallService.cancelCover(req.workspaceId, idParam(req), sessionUser(req)) });
}));

router.post('/on-call/requests', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await onCallService.createRequest(req.workspaceId, req.body || {}, sessionUser(req)) });
}));

router.post('/on-call/requests/:id/cancel', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await onCallService.cancelRequest(req.workspaceId, idParam(req), sessionUser(req)) });
}));

export default router;
