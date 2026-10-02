import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Onboarding / Offboarding routes: /status for any member; everything else
 * workspace-admin only, and only where HR_LIFECYCLE_WORKSPACE_IDS lists the
 * workspace (404 elsewhere). Settings saves carry the session user to the audit.
 */
const svc = {
  getMode: jest.fn(async () => 'observe'),
  getSettings: jest.fn(async () => ({ mode: 'observe', templates: {} })),
  people: jest.fn(async () => ({ technicians: [], groups: [] })),
  detectionRules: jest.fn(() => ({ senders: [], rules: [] })),
  updateSettings: jest.fn(async (ws, body) => ({ settings: body, changes: [{ field: 'mode', before: 'off', after: body.mode }] })),
  listSettingsChanges: jest.fn(async () => []),
  listFamilies: jest.fn(async () => []),
  getFamily: jest.fn(async (id) => ({ id })),
  switchToAfterTheFact: jest.fn(async (id) => ({ familyId: id, closed: [] })),
  listEvents: jest.fn(async () => []),
  preview: jest.fn(async (id) => ({ ticketId: id })),
};
const wsRepo = { getAccessRole: jest.fn(async () => 'viewer') };

jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/hrLifecycleService.js', () => ({
  default: svc,
  HR_LIFECYCLE_MODES: ['off', 'observe', 'live'],
  TEMPLATE_NAMES: ['offboarding_standard', 'offboarding_after_fact', 'onboarding'],
  TEMPLATE_LABELS: {},
  isAvailable: (ws) => String(process.env.HR_LIFECYCLE_WORKSPACE_IDS ?? '1').split(',').map(Number).includes(Number(ws)),
}));
jest.unstable_mockModule('../src/services/ticketRefResolver.js', () => ({ resolveTicketRefOrThrow: jest.fn(async () => ({ id: 42 })) }));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({ default: wsRepo }));

const { default: router } = await import('../src/routes/hrLifecycle.routes.js');

const ADMIN = { email: 'root@example.com', name: 'Root', role: 'admin' };
const MEMBER = { email: 'viewer@example.com', name: 'Viewer', role: 'user' };

function app(user, workspaceId = 1) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.session = { user }; req.workspaceId = workspaceId; next(); });
  a.use('/api/hr-lifecycle', router);
  // eslint-disable-next-line no-unused-vars
  a.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message, code: err.code }));
  return a;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.HR_LIFECYCLE_WORKSPACE_IDS;
  wsRepo.getAccessRole.mockResolvedValue('viewer');
});

test('any member reads /status; it says whether the section exists here', async () => {
  const r = await request(app(MEMBER)).get('/api/hr-lifecycle/status');
  expect(r.status).toBe(200);
  expect(r.body.data).toEqual({ available: true, mode: 'observe' });
  const other = await request(app(MEMBER, 2)).get('/api/hr-lifecycle/status');
  expect(other.body.data).toEqual({ available: false, mode: 'off' });
});

test.each([
  ['get', '/settings'],
  ['put', '/settings'],
  ['get', '/settings/changes'],
  ['get', '/families'],
  ['get', '/families/3'],
  ['post', '/families/3/after-the-fact'],
  ['get', '/events'],
  ['post', '/preview'],
])('%s %s is admin-only', async (method, path) => {
  const r = await request(app(MEMBER))[method](`/api/hr-lifecycle${path}`).send({ mode: 'live', ticketId: 1 });
  expect(r.status).toBe(403);
  expect(svc.updateSettings).not.toHaveBeenCalled();
  expect(svc.switchToAfterTheFact).not.toHaveBeenCalled();
});

test('a workspace admin (not a global admin) passes', async () => {
  wsRepo.getAccessRole.mockResolvedValue('admin');
  expect((await request(app(MEMBER)).get('/api/hr-lifecycle/families')).status).toBe(200);
});

test('outside the listed workspaces everything but /status is 404, even for admins', async () => {
  const r = await request(app(ADMIN, 2)).get('/api/hr-lifecycle/settings');
  expect(r.status).toBe(404);
});

test('settings save passes the session user to the audit', async () => {
  const r = await request(app(ADMIN)).put('/api/hr-lifecycle/settings').send({ mode: 'live' });
  expect(r.status).toBe(200);
  expect(svc.updateSettings).toHaveBeenCalledWith(1, { mode: 'live' }, ADMIN);
  expect(r.body.data.changes).toEqual([{ field: 'mode', before: 'off', after: 'live' }]);
});

test('settings read carries the rules and the people for the pickers', async () => {
  const r = await request(app(ADMIN)).get('/api/hr-lifecycle/settings');
  expect(r.body.data).toMatchObject({ settings: { mode: 'observe' }, modes: ['off', 'observe', 'live'], detection: { senders: [] }, technicians: [], groups: [] });
});

test('after-the-fact and preview', async () => {
  expect((await request(app(ADMIN)).post('/api/hr-lifecycle/families/7/after-the-fact')).body.data).toEqual({ familyId: 7, closed: [] });
  expect(svc.switchToAfterTheFact).toHaveBeenCalledWith(7, 1, ADMIN);
  expect((await request(app(ADMIN)).post('/api/hr-lifecycle/preview').send({ ref: 'TP-12' })).body.data).toEqual({ ticketId: 42 });
  expect((await request(app(ADMIN)).post('/api/hr-lifecycle/preview').send({})).status).toBe(400);
});
