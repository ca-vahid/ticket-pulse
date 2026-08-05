import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * /api/search route guards (QA 08-04 #2, Phase 7): auth is mandatory, the
 * workspace comes from the header, and access mirrors the native ticketing
 * router — admin, workspace member, or active technician in that workspace.
 */

const prismaMock = { technician: { findFirst: jest.fn() } };
const getAccessRoleMock = jest.fn();
const searchMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({
  default: { getAccessRole: getAccessRoleMock },
}));
jest.unstable_mockModule('../src/services/globalSearchService.js', () => ({
  default: { search: searchMock },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: searchRoutes } = await import('../src/routes/search.routes.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');

function makeApp(sessionUser) {
  const app = express();
  app.use((req, _res, next) => {
    if (sessionUser) req.session = { user: sessionUser };
    next();
  });
  app.use('/api/search', searchRoutes);
  app.use(errorHandler);
  return app;
}

const member = { email: 'Coord@bgc.ca', role: 'coordinator' };

beforeEach(() => {
  jest.clearAllMocks();
  searchMock.mockResolvedValue({ query: 'x', sections: { tickets: [] } });
  getAccessRoleMock.mockResolvedValue(null);
  prismaMock.technician.findFirst.mockResolvedValue(null);
});

describe('GET /api/search', () => {
  test('rejects unauthenticated requests with 401', async () => {
    const res = await request(makeApp(null)).get('/api/search').set('x-workspace-id', '1');
    expect(res.status).toBe(401);
    expect(searchMock).not.toHaveBeenCalled();
  });

  test('rejects requests without a workspace with 400', async () => {
    const res = await request(makeApp(member)).get('/api/search');
    expect(res.status).toBe(400);
    expect(searchMock).not.toHaveBeenCalled();
  });

  test('rejects a user with neither workspace access nor a technician profile', async () => {
    const res = await request(makeApp(member)).get('/api/search?q=printer').set('x-workspace-id', '2');
    expect(res.status).toBe(401);
    expect(searchMock).not.toHaveBeenCalled();
    // membership was checked against the RIGHT workspace, with a lowercased email
    expect(getAccessRoleMock).toHaveBeenCalledWith('coord@bgc.ca', 2);
    expect(prismaMock.technician.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: 2, isActive: true }),
    }));
  });

  test('workspace member searches their selected workspace only', async () => {
    getAccessRoleMock.mockResolvedValue('member');
    const res = await request(makeApp(member))
      .get('/api/search?q=printer&types=tickets,tasks')
      .set('x-workspace-id', '1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(searchMock).toHaveBeenCalledWith(1, { q: 'printer', types: 'tickets,tasks' });
  });

  test('agent-role users get in via their active technician profile', async () => {
    prismaMock.technician.findFirst.mockResolvedValue({ id: 12 });
    const res = await request(makeApp({ email: 'agent@bgc.ca', role: 'agent' }))
      .get('/api/search?q=vpn')
      .set('x-workspace-id', '3');
    expect(res.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith(3, { q: 'vpn', types: undefined });
  });

  test('admins skip the membership lookups entirely', async () => {
    const res = await request(makeApp({ email: 'admin@bgc.ca', role: 'admin' }))
      .get('/api/search?q=vpn')
      .set('x-workspace-id', '4');
    expect(res.status).toBe(200);
    expect(getAccessRoleMock).not.toHaveBeenCalled();
    expect(prismaMock.technician.findFirst).not.toHaveBeenCalled();
  });
});
