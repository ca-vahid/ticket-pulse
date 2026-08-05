import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * API v1 /meta (Phase 8c): the statuses list is the WORKSPACE's status
 * registry (custom labels included, display order), not the hardcoded
 * canonical 4; statusDetails adds each label's base for lifecycle-aware
 * consumers. The original string[] shape of `statuses` is preserved.
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticketTypeDefinition: { findMany: jest.fn() },
  ticketStatusDefinition: { findMany: jest.fn() },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/middleware/apiKeyAuth.js', () => ({
  requireApiKey: () => (req, _res, next) => {
    req.workspaceId = 1;
    req.apiKey = { name: 'test key', keyPrefix: 'tp_test_x', mode: 'test', scopes: ['*'], oauthClientId: null };
    next();
  },
  apiRequestContext: (_req, _res, next) => next(),
  clientIp: () => '127.0.0.1',
}));
// Heavy service chains are irrelevant to /meta — stub them out.
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/technicianRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/groupRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/oauthClientService.js', () => ({
  verifyClientCredentials: jest.fn(),
  issueAccessToken: jest.fn(),
}));
jest.unstable_mockModule('../src/services/apiRateLimitService.js', () => ({
  default: { hit: jest.fn().mockResolvedValue({ allowed: true, reset: 0 }) },
}));
jest.unstable_mockModule('../src/middleware/apiIdempotency.js', () => ({
  withIdempotency: (_req, _res, next) => next(),
}));

const { default: apiV1Routes } = await import('../src/routes/apiV1.routes.js');
const { invalidateStatusCache } = await import('../src/services/statusService.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', apiV1Routes);
  return app;
}

describe('GET /api/v1/meta statuses (per-workspace registry)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    invalidateStatusCache();
    prismaMock.ticketTypeDefinition.findMany.mockResolvedValue([
      { name: 'Incident', description: null, isDefault: true },
    ]);
  });

  afterAll(() => invalidateStatusCache());

  test('serves the workspace vocabulary with bases, custom statuses included', async () => {
    prismaMock.ticketStatusDefinition.findMany.mockResolvedValue([
      { id: 1, workspaceId: 1, name: 'Open', baseStatus: 'Open', sortOrder: 0, isSystem: true, isActive: true },
      { id: 2, workspaceId: 1, name: 'Pending', baseStatus: 'Pending', sortOrder: 1, isSystem: true, isActive: true },
      { id: 3, workspaceId: 1, name: 'Resolved', baseStatus: 'Resolved', sortOrder: 2, isSystem: true, isActive: true },
      { id: 4, workspaceId: 1, name: 'Closed', baseStatus: 'Closed', sortOrder: 3, isSystem: true, isActive: true },
      { id: 5, workspaceId: 1, name: 'Needs Rework', baseStatus: 'Pending', sortOrder: 4, isSystem: false, isActive: true },
    ]);

    const response = await request(buildApp()).get('/api/v1/meta').expect(200);

    expect(response.body.data.statuses).toEqual(['Open', 'Pending', 'Resolved', 'Closed', 'Needs Rework']);
    expect(response.body.data.statusDetails).toEqual([
      { name: 'Open', baseStatus: 'Open' },
      { name: 'Pending', baseStatus: 'Pending' },
      { name: 'Resolved', baseStatus: 'Resolved' },
      { name: 'Closed', baseStatus: 'Closed' },
      { name: 'Needs Rework', baseStatus: 'Pending' },
    ]);
    expect(response.body.data.ticketTypes).toHaveLength(1);
  });

  test('pre-seed workspaces keep the canonical 4 (registry fallback)', async () => {
    prismaMock.ticketStatusDefinition.findMany.mockResolvedValue([]);

    const response = await request(buildApp()).get('/api/v1/meta').expect(200);

    expect(response.body.data.statuses).toEqual(['Open', 'Pending', 'Resolved', 'Closed']);
  });
});
