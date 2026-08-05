import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * /api/ticket-statuses guards (Phase 8a): every route is admin-gated —
 * global admins pass, workspace admins pass via the live role check, and
 * plain members/agents are refused. CRUD calls delegate to statusService
 * with the header workspace.
 */

const statusServiceMock = {
  listStatuses: jest.fn(),
  createStatus: jest.fn(),
  updateStatus: jest.fn(),
  deactivateStatus: jest.fn(),
  reactivateStatus: jest.fn(),
};
const getAccessRoleMock = jest.fn();

jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: statusServiceMock,
  invalidateStatusCache: jest.fn(),
  BASE_STATUSES: ['Open', 'Pending', 'Resolved', 'Closed'],
}));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({
  default: { getAccessRole: getAccessRoleMock },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: statusesRoutes } = await import('../src/routes/statuses.routes.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');

function makeApp(sessionUser) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (sessionUser) req.session = { user: sessionUser };
    const ws = Number(req.headers['x-workspace-id']);
    if (Number.isFinite(ws)) req.workspaceId = ws;
    next();
  });
  app.use('/api/ticket-statuses', statusesRoutes);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  statusServiceMock.listStatuses.mockResolvedValue([
    { id: 1, name: 'Open', baseStatus: 'Open', isSystem: true, isActive: true },
  ]);
  statusServiceMock.createStatus.mockResolvedValue({ id: 9, name: 'On hold' });
  statusServiceMock.updateStatus.mockResolvedValue({ id: 9, name: 'On hold' });
  statusServiceMock.deactivateStatus.mockResolvedValue({ id: 9, isActive: false });
  statusServiceMock.reactivateStatus.mockResolvedValue({ id: 9, isActive: true });
  getAccessRoleMock.mockResolvedValue(null);
});

describe('/api/ticket-statuses admin gating', () => {
  test('unauthenticated requests are refused', async () => {
    const res = await request(makeApp(null)).get('/api/ticket-statuses').set('x-workspace-id', '1');
    expect(res.status).toBe(401);
    expect(statusServiceMock.listStatuses).not.toHaveBeenCalled();
  });

  test('non-admin members are refused on every route', async () => {
    getAccessRoleMock.mockResolvedValue('member');
    const app = makeApp({ email: 'member@bgc.ca', role: 'coordinator' });
    for (const call of [
      request(app).get('/api/ticket-statuses'),
      request(app).post('/api/ticket-statuses').send({ name: 'X', baseStatus: 'Open' }),
      request(app).patch('/api/ticket-statuses/9').send({ color: 'pink' }),
      request(app).post('/api/ticket-statuses/9/deactivate'),
      request(app).post('/api/ticket-statuses/9/reactivate'),
    ]) {
      const res = await call.set('x-workspace-id', '1');
      expect(res.status).toBe(401);
    }
    expect(statusServiceMock.listStatuses).not.toHaveBeenCalled();
    expect(statusServiceMock.createStatus).not.toHaveBeenCalled();
    expect(statusServiceMock.updateStatus).not.toHaveBeenCalled();
  });

  test('workspace admins pass via the live role check', async () => {
    getAccessRoleMock.mockResolvedValue('admin');
    const res = await request(makeApp({ email: 'wsadmin@bgc.ca', role: 'coordinator' }))
      .get('/api/ticket-statuses')
      .set('x-workspace-id', '2');
    expect(res.status).toBe(200);
    expect(getAccessRoleMock).toHaveBeenCalledWith('wsadmin@bgc.ca', 2);
    // Settings list includes retired rows.
    expect(statusServiceMock.listStatuses).toHaveBeenCalledWith(2, { includeInactive: true });
  });

  test('global admins skip the workspace role lookup', async () => {
    const res = await request(makeApp({ email: 'admin@bgc.ca', role: 'admin' }))
      .get('/api/ticket-statuses')
      .set('x-workspace-id', '3');
    expect(res.status).toBe(200);
    expect(getAccessRoleMock).not.toHaveBeenCalled();
  });

  test('create/update/deactivate/reactivate delegate to statusService with the header workspace', async () => {
    const app = makeApp({ email: 'admin@bgc.ca', role: 'admin' });

    const created = await request(app).post('/api/ticket-statuses')
      .set('x-workspace-id', '1')
      .send({ name: 'On hold', baseStatus: 'Pending', color: 'cyan' });
    expect(created.status).toBe(201);
    expect(statusServiceMock.createStatus).toHaveBeenCalledWith(
      1, { name: 'On hold', baseStatus: 'Pending', color: 'cyan' }, 'admin@bgc.ca',
    );

    await request(app).patch('/api/ticket-statuses/9').set('x-workspace-id', '1').send({ name: 'Held' });
    expect(statusServiceMock.updateStatus).toHaveBeenCalledWith(1, '9', { name: 'Held' }, 'admin@bgc.ca');

    await request(app).post('/api/ticket-statuses/9/deactivate').set('x-workspace-id', '1');
    expect(statusServiceMock.deactivateStatus).toHaveBeenCalledWith(1, '9', 'admin@bgc.ca');

    await request(app).post('/api/ticket-statuses/9/reactivate').set('x-workspace-id', '1');
    expect(statusServiceMock.reactivateStatus).toHaveBeenCalledWith(1, '9', 'admin@bgc.ca');
  });

  test('there is no DELETE route (retire-don\'t-delete)', async () => {
    const res = await request(makeApp({ email: 'admin@bgc.ca', role: 'admin' }))
      .delete('/api/ticket-statuses/9')
      .set('x-workspace-id', '1');
    expect(res.status).toBe(404);
  });
});
