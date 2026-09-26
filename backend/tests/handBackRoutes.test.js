import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * QA 09-25 items 3 + 6 — route guards and validation:
 *  - /api/hand-backs reads: reviewers/admins/observers only; filters pass through
 *  - PUT /api/settings/technicians/:id/assignable-only: boolean, same workspace
 *  - PUT /api/settings/team-forwards: label required, e-mail validated
 */

const prismaMock = {
  technician: { findFirst: jest.fn(), update: jest.fn() },
  teamForward: { findMany: jest.fn(), deleteMany: jest.fn(), update: jest.fn(), create: jest.fn() },
  $transaction: jest.fn(async (ops) => Promise.all(ops)),
};
const listForWorkspace = jest.fn().mockResolvedValue({ items: [], summary: { total: 0, byReason: [], byCategory: [] } });
const getAccessRole = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({ default: { getAccessRole } }));
jest.unstable_mockModule('../src/services/dashboardReadCache.js', () => ({ clearReadCache: jest.fn() }));
jest.unstable_mockModule('../src/middleware/workspace.js', () => ({
  requireWorkspace: (req, _res, next) => { req.workspaceId = 1; next(); },
}));
jest.unstable_mockModule('../src/services/ticketHandBackService.js', () => ({
  default: { listForWorkspace, forTicket: jest.fn().mockResolvedValue([]) },
  HAND_BACK_REASONS: { location: 'Location issue', capacity: 'Capacity full', competency: 'Competency mismatch', other: 'Other', skipped: 'No reason given' },
}));

const { default: handBacksRoutes } = await import('../src/routes/handBacks.routes.js');
const { default: teamRoutingSettingsRoutes } = await import('../src/routes/teamRoutingSettings.routes.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');

function app(user = { email: 'rev@x.io', role: 'viewer' }) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.session = { user }; req.user = user; req.workspaceId = 1; next(); });
  a.use('/api/hand-backs', handBacksRoutes);
  a.use('/api/settings', teamRoutingSettingsRoutes);
  a.use(errorHandler);
  return a;
}

beforeEach(() => {
  jest.clearAllMocks();
  getAccessRole.mockResolvedValue('reviewer');
});

describe('/api/hand-backs', () => {
  test('a reviewer reads the list; known filters pass through, unknown reasons are dropped', async () => {
    await request(app()).get('/api/hand-backs?reason=location&technicianId=7&from=2026-09-01').expect(200);
    expect(listForWorkspace).toHaveBeenCalledWith(1, expect.objectContaining({ reason: 'location', technicianId: 7, from: '2026-09-01' }));
    await request(app()).get('/api/hand-backs?reason=nonsense').expect(200);
    expect(listForWorkspace).toHaveBeenLastCalledWith(1, expect.objectContaining({ reason: null }));
  });

  test('a basic member is refused', async () => {
    getAccessRole.mockResolvedValue('viewer');
    await request(app()).get('/api/hand-backs').expect(403);
    expect(listForWorkspace).not.toHaveBeenCalled();
  });
});

describe('PUT /api/settings/technicians/:id/assignable-only', () => {
  const admin = { email: 'ada@x.io', role: 'admin' };

  test('admin toggles a same-workspace technician', async () => {
    prismaMock.technician.findFirst.mockResolvedValue({ id: 40, name: 'Juan Gonzalez', isActive: false });
    prismaMock.technician.update.mockResolvedValue({ id: 40, name: 'Juan Gonzalez', isActive: false, assignableOnly: true });
    const res = await request(app(admin)).put('/api/settings/technicians/40/assignable-only').send({ assignableOnly: true }).expect(200);
    expect(res.body.data.assignableOnly).toBe(true);
    expect(prismaMock.technician.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 40, workspaceId: 1 } }));
  });

  test('needs a boolean, and the technician must be in this workspace', async () => {
    await request(app(admin)).put('/api/settings/technicians/40/assignable-only').send({ assignableOnly: 'yes' }).expect(400);
    prismaMock.technician.findFirst.mockResolvedValue(null);
    await request(app(admin)).put('/api/settings/technicians/41/assignable-only').send({ assignableOnly: true }).expect(404);
    expect(prismaMock.technician.update).not.toHaveBeenCalled();
  });

  test('non-admins are refused', async () => {
    getAccessRole.mockResolvedValue('reviewer');
    await request(app()).put('/api/settings/technicians/40/assignable-only').send({ assignableOnly: true }).expect(403);
  });
});

describe('PUT /api/settings/team-forwards', () => {
  const admin = { email: 'ada@x.io', role: 'admin' };

  test('saves rows (address optional) and returns the list', async () => {
    prismaMock.teamForward.findMany
      .mockResolvedValueOnce([]) // existing ids
      .mockResolvedValueOnce([{ id: 1, label: 'Digital Solutions Team', email: null, enabled: true }]);
    const res = await request(app(admin)).put('/api/settings/team-forwards')
      .send({ items: [{ label: ' Digital Solutions Team ', email: '' }] }).expect(200);
    expect(prismaMock.teamForward.create).toHaveBeenCalledWith({ data: { workspaceId: 1, label: 'Digital Solutions Team', email: null, enabled: true } });
    expect(res.body.data).toHaveLength(1);
  });

  test('rejects a bad address and a missing name', async () => {
    await request(app(admin)).put('/api/settings/team-forwards').send({ items: [{ label: 'DS', email: 'not-an-email' }] }).expect(400);
    await request(app(admin)).put('/api/settings/team-forwards').send({ items: [{ label: '', email: 'ds@x.io' }] }).expect(400);
    expect(prismaMock.teamForward.create).not.toHaveBeenCalled();
  });
});
