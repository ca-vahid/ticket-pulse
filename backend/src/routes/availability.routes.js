/**
 * Availability (plans/AVAILABILITY_TRACKER_PLAN.md, Oct 2026) — the native
 * Vacation Tracker replacement. Company-level: mounted after requireAuth and
 * before workspace enforcement, so every Ticket Pulse user (agents included)
 * can book their own time away. Settings writes are admin-only inside the
 * service; approvals are checked per request.
 */
import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { AuthenticationError } from '../utils/errors.js';
import availabilityService from '../services/availability/availabilityService.js';

const router = express.Router();

const me = (req) => {
  const user = req.session?.user ?? req.user;
  if (!user?.email) throw new AuthenticationError('Authentication required');
  return user;
};
const ok = (res, data) => res.json({ success: true, data });
// 5 Oct 2026: the team calendar shows the workspace you are in (the app sends
// X-Workspace-Id on every call); the service checks you belong to it.
const wsOf = (req) => {
  const raw = req.headers['x-workspace-id'] ?? me(req).selectedWorkspaceId ?? null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

let seeded = null;
// Every Ticket Pulse user is a person here: the roster refreshes on first use
// and every 6 h (3 Oct 2026 — the calendar showed only whoever had visited).
const PEOPLE_SYNC_MS = 6 * 60 * 60 * 1000;
let peopleSyncedAt = 0;
let peopleSync = null;
router.use(asyncHandler(async (_req, _res, next) => {
  if (!seeded) seeded = availabilityService.ensureSeed().catch((err) => { seeded = null; throw err; });
  await seeded;
  if (!peopleSync && Date.now() - peopleSyncedAt > PEOPLE_SYNC_MS) {
    peopleSync = availabilityService.syncPeople()
      .then(() => { peopleSyncedAt = Date.now(); })
      .catch(() => {})
      .finally(() => { peopleSync = null; });
    if (!peopleSyncedAt) await peopleSync; // first time: wait so the calendar is complete
  }
  next();
}));

// --- everyone ---------------------------------------------------------------

router.get('/me', asyncHandler(async (req, res) => {
  const user = me(req);
  const person = await availabilityService.ensurePerson(user);
  const [settings, types, offices, balances, isAdmin, pending] = await Promise.all([
    availabilityService.getSettings(),
    availabilityService.listLeaveTypes(),
    availabilityService.listOffices(),
    availabilityService.balances(person.email),
    availabilityService.isAdmin(user),
    availabilityService.listPendingFor(user),
  ]);
  ok(res, {
    person: { ...person, dailyHours: Number(person.dailyHours) },
    settings: {
      yearStartMonth: settings.yearStartMonth,
      outlookEventsEnabled: settings.outlookEventsEnabled,
      autoRepliesEnabled: settings.autoRepliesEnabled,
      purposeNotice: settings.purposeNotice,
    },
    leaveTypes: types,
    offices,
    balances,
    isAdmin,
    pendingApprovals: pending.length,
  });
}));

router.get('/requests/mine', asyncHandler(async (req, res) => {
  ok(res, await availabilityService.listMine(me(req), { year: req.query.year ? Number(req.query.year) : null }));
}));

router.post('/requests/preview', asyncHandler(async (req, res) => {
  ok(res, await availabilityService.preview(me(req), req.body || {}));
}));

router.post('/requests', asyncHandler(async (req, res) => {
  const body = req.body || {};
  ok(res, await availabilityService.submit(me(req), body, { onBehalfOf: body.onBehalfOf || null }));
}));

router.get('/requests/:id', asyncHandler(async (req, res) => {
  ok(res, await availabilityService.getRequest(req.params.id, me(req)));
}));

router.post('/requests/:id/cancel', asyncHandler(async (req, res) => {
  ok(res, await availabilityService.cancelRequest(req.params.id, me(req), req.body?.reason || null));
}));

router.get('/calendar', asyncHandler(async (req, res) => {
  ok(res, await availabilityService.calendar(me(req), {
    from: req.query.from, to: req.query.to, officeId: req.query.officeId || null, groupId: req.query.groupId || null, workspaceId: wsOf(req),
  }));
}));

router.get('/out-today', asyncHandler(async (req, res) => {
  ok(res, await availabilityService.outToday(me(req), { workspaceId: wsOf(req) }));
}));

// --- approvers --------------------------------------------------------------

router.get('/approvals', asyncHandler(async (req, res) => {
  ok(res, await availabilityService.listPendingFor(me(req)));
}));

router.post('/requests/:id/decision', asyncHandler(async (req, res) => {
  const { action, note } = req.body || {};
  ok(res, await availabilityService.decideRequest(req.params.id, action, me(req), note || null));
}));

// --- admin (checked in the service) ------------------------------------------

router.get('/admin/config', asyncHandler(async (req, res) => {
  const user = me(req);
  await availabilityService.assertAdmin(user);
  const [settings, types, offices, groups, rules, people] = await Promise.all([
    availabilityService.getSettings(),
    availabilityService.listLeaveTypes({ includeInactive: true }),
    availabilityService.listOffices(),
    availabilityService.listGroups(),
    availabilityService.listRules(),
    availabilityService.listPeople(),
  ]);
  ok(res, { settings, leaveTypes: types, offices, groups, rules, people: people.map((p) => ({ ...p, dailyHours: Number(p.dailyHours) })) });
}));

router.patch('/admin/settings', asyncHandler(async (req, res) => ok(res, await availabilityService.updateSettings(req.body || {}, me(req)))));
router.post('/admin/offices', asyncHandler(async (req, res) => ok(res, await availabilityService.saveOffice(req.body || {}, me(req)))));
router.post('/admin/leave-types', asyncHandler(async (req, res) => ok(res, await availabilityService.saveLeaveType(req.body || {}, me(req)))));
router.post('/admin/groups', asyncHandler(async (req, res) => ok(res, await availabilityService.saveGroup(req.body || {}, me(req)))));
router.delete('/admin/groups/:id', asyncHandler(async (req, res) => ok(res, await availabilityService.deleteGroup(req.params.id, me(req)))));
router.post('/admin/rules', asyncHandler(async (req, res) => ok(res, await availabilityService.saveRule(req.body || {}, me(req)))));
router.delete('/admin/rules/:id', asyncHandler(async (req, res) => ok(res, await availabilityService.deleteRule(req.params.id, me(req)))));
router.patch('/admin/people/:id', asyncHandler(async (req, res) => ok(res, await availabilityService.updatePerson(req.params.id, req.body || {}, me(req)))));
router.post('/admin/people/sync', asyncHandler(async (req, res) => {
  const user = me(req);
  await availabilityService.assertAdmin(user);
  ok(res, await availabilityService.syncPeople());
}));
router.get('/admin/balances', asyncHandler(async (req, res) => ok(res, await availabilityService.balanceReport(me(req), { year: req.query.year ? Number(req.query.year) : null }))));
router.post('/admin/balances/adjust', asyncHandler(async (req, res) => ok(res, await availabilityService.adjustBalance(req.body || {}, me(req)))));
router.post('/admin/balances/import', asyncHandler(async (req, res) => ok(res, await availabilityService.importBalancesCsv(me(req), req.body || {}))));
router.post('/admin/import/vacation-tracker', asyncHandler(async (req, res) => ok(res, await availabilityService.importFromVacationTracker(me(req), req.body || {}))));
router.post('/admin/reproject', asyncHandler(async (req, res) => ok(res, await availabilityService.reprojectAll(me(req), req.body || {}))));

export default router;
