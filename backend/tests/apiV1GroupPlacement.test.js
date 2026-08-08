import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * FR 08-07 #2/#4 — group placement through the public API:
 *  - GET /groups exposes BOTH identifier spaces (`origin` + `freshserviceId`),
 *    since ticket writes take groupId = freshserviceId (FS groups) but
 *    internalGroupId = id (internal groups);
 *  - PATCH /tickets/:id accepts internalGroupId and forwards it (with a
 *    groupId clear) to updateTicketFields;
 *  - ticketShape carries `internalGroup: {id, name}` so senders can read the
 *    placement back.
 */

const ticketServiceMock = {
  getTicket: jest.fn(),
  updateTicketFields: jest.fn(),
  changeStatus: jest.fn(),
  assignTicket: jest.fn(),
  listTickets: jest.fn(),
};
const groupRepositoryMock = { listForWorkspace: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/middleware/apiKeyAuth.js', () => ({
  requireApiKey: () => (req, _res, next) => {
    req.workspaceId = 1;
    req.apiKey = { name: 'test key', keyPrefix: 'tp_test_x', mode: 'live', scopes: ['*'], oauthClientId: null };
    next();
  },
  apiRequestContext: (_req, _res, next) => next(),
  clientIp: () => '127.0.0.1',
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/technicianRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/groupRepository.js', () => ({ default: groupRepositoryMock }));
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

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', apiV1Routes);
  return app;
}

const TICKET = {
  id: 501,
  displayRef: 'TP-1076',
  origin: 'ticketpulse',
  subject: 'New AP project',
  status: 'Open',
  priority: 2,
  ticketType: null,
  requester: { id: 9, name: 'Jane Doe', email: 'jdoe@example.com' },
  assignedTech: null,
  internalCategory: null,
  internalSubcategory: null,
  internalGroupId: 3458,
  internalGroup: { id: 3458, name: 'Project Accounting', origin: 'local' },
  tags: [],
  customFields: {},
  createdAt: '2026-08-07T10:00:00.000Z',
  updatedAt: '2026-08-07T10:00:00.000Z',
  resolvedAt: null,
  thread: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  ticketServiceMock.getTicket.mockResolvedValue(TICKET);
  ticketServiceMock.updateTicketFields.mockResolvedValue(TICKET);
});

describe('GET /api/v1/groups (identifier spaces)', () => {
  test('returns origin and freshserviceId for both group kinds', async () => {
    groupRepositoryMock.listForWorkspace.mockResolvedValue([
      {
        id: 3458, name: 'Project Accounting', description: null, origin: 'local', freshserviceId: null, isActive: true, memberCount: 4,
      },
      {
        id: 12, name: 'IT Operations', description: 'FS group', origin: 'freshservice', freshserviceId: '1000210021', isActive: true, memberCount: 0,
      },
    ]);

    const response = await request(buildApp()).get('/api/v1/groups').expect(200);

    expect(response.body.data).toEqual([
      {
        id: 3458, name: 'Project Accounting', description: null, origin: 'local', freshserviceId: null,
      },
      {
        id: 12, name: 'IT Operations', description: 'FS group', origin: 'freshservice', freshserviceId: '1000210021',
      },
    ]);
  });
});

describe('PATCH /api/v1/tickets/:id internal group placement', () => {
  test('internalGroupId (with a groupId clear) flows through to updateTicketFields', async () => {
    const response = await request(buildApp())
      .patch('/api/v1/tickets/501')
      .send({ internalGroupId: 3458, groupId: null })
      .expect(200);

    expect(ticketServiceMock.updateTicketFields).toHaveBeenCalledWith(
      501, 1, { internalGroupId: 3458, groupId: null }, expect.objectContaining({ role: 'api' }),
    );
    expect(response.body.data.internalGroup).toEqual({ id: 3458, name: 'Project Accounting' });
  });

  test('a PATCH without group fields never invents them', async () => {
    await request(buildApp()).patch('/api/v1/tickets/501').send({ subject: 'Renamed' }).expect(200);
    const fields = ticketServiceMock.updateTicketFields.mock.calls[0][2];
    expect(fields).toEqual({ subject: 'Renamed' });
  });
});

describe('ticketShape internalGroup read-back', () => {
  test('GET /tickets/:id carries internalGroup {id, name} alongside group', async () => {
    const response = await request(buildApp()).get('/api/v1/tickets/501').expect(200);
    expect(response.body.data.internalGroup).toEqual({ id: 3458, name: 'Project Accounting' });
    expect(response.body.data.group).toBeNull();
  });

  test('tickets without an internal group read back internalGroup: null', async () => {
    ticketServiceMock.getTicket.mockResolvedValue({ ...TICKET, internalGroupId: null, internalGroup: null });
    const response = await request(buildApp()).get('/api/v1/tickets/501').expect(200);
    expect(response.body.data.internalGroup).toBeNull();
  });
});
