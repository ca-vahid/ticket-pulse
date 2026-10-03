import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// Availability routes (Oct 2026): wiring only — the service is mocked. The
// service itself is exercised against a real Postgres in the release smoke.

const svc = {
  ensureSeed: jest.fn().mockResolvedValue(),
  ensurePerson: jest.fn().mockResolvedValue({ id: 1, email: 'ana@bgc.ca', name: 'Ana', dailyHours: '8' }),
  getSettings: jest.fn().mockResolvedValue({ yearStartMonth: 1, outlookEventsEnabled: false, autoRepliesEnabled: false, purposeNotice: null }),
  listLeaveTypes: jest.fn().mockResolvedValue([{ id: 3, name: 'WFH' }]),
  listOffices: jest.fn().mockResolvedValue([]),
  balances: jest.fn().mockResolvedValue([]),
  isAdmin: jest.fn().mockResolvedValue(false),
  listPendingFor: jest.fn().mockResolvedValue([{ id: 9 }]),
  preview: jest.fn().mockResolvedValue({ outcome: 'approved', reason: 'ok' }),
  submit: jest.fn().mockResolvedValue({ id: 5, status: 'approved' }),
  decideRequest: jest.fn().mockResolvedValue({ id: 5, status: 'approved' }),
  cancelRequest: jest.fn().mockResolvedValue({ id: 5, status: 'cancelled' }),
  calendar: jest.fn().mockResolvedValue({ people: [], entries: [], holidays: [] }),
  assertAdmin: jest.fn(),
  saveRule: jest.fn(),
};

jest.unstable_mockModule('../src/services/availability/availabilityService.js', () => ({ default: svc }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: routes } = await import('../src/routes/availability.routes.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const { AuthorizationError } = await import('../src/utils/errors.js');

function app(user = { email: 'ana@bgc.ca', name: 'Ana', role: 'agent' }) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { if (user) { req.session = { user }; req.user = user; } next(); });
  a.use('/api/availability', routes);
  a.use(errorHandler);
  return a;
}

beforeEach(() => jest.clearAllMocks());

test('GET /me works for an agent (no workspace needed) and seeds once', async () => {
  const res = await request(app()).get('/api/availability/me');
  expect(res.status).toBe(200);
  expect(res.body.data).toMatchObject({ person: { email: 'ana@bgc.ca', dailyHours: 8 }, isAdmin: false, pendingApprovals: 1 });
  await request(app()).get('/api/availability/me');
  expect(svc.ensureSeed).toHaveBeenCalledTimes(1);
});

test('no session → 401', async () => {
  const res = await request(app(null)).get('/api/availability/me');
  expect(res.status).toBe(401);
});

test('preview, submit, decision and cancel pass the caller through', async () => {
  const a = app();
  await request(a).post('/api/availability/requests/preview').send({ leaveTypeId: 3, startDate: '2026-10-14' }).expect(200);
  expect(svc.preview).toHaveBeenCalledWith(expect.objectContaining({ email: 'ana@bgc.ca' }), { leaveTypeId: 3, startDate: '2026-10-14' });
  await request(a).post('/api/availability/requests').send({ leaveTypeId: 3, startDate: '2026-10-14' }).expect(200);
  expect(svc.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ leaveTypeId: 3 }), { onBehalfOf: null });
  await request(a).post('/api/availability/requests/5/decision').send({ action: 'deny', note: 'busy week' }).expect(200);
  expect(svc.decideRequest).toHaveBeenCalledWith('5', 'deny', expect.anything(), 'busy week');
  await request(a).post('/api/availability/requests/5/cancel').send({ reason: 'plans changed' }).expect(200);
  expect(svc.cancelRequest).toHaveBeenCalledWith('5', expect.anything(), 'plans changed');
});

test('admin config refuses a non-admin with 403', async () => {
  svc.assertAdmin.mockRejectedValueOnce(new AuthorizationError('Only administrators can change Availability settings', 'availability_admin'));
  const res = await request(app()).get('/api/availability/admin/config');
  expect(res.status).toBe(403);
});
