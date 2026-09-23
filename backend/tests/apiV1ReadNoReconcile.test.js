import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * 22 Sep 2026: ContinuIT read 234 ticket details in 26 s through the public
 * API. Every read went through the UI's detail path, which reconciles with
 * FreshService and refreshes an FS-born thread on the interactive limiter
 * lane — three FreshService calls per read, the shared queue 300 deep, and
 * the people in the app got 15 s thread timeouts. API reads answer from
 * Ticket Pulse's copy; the syncs keep it fresh.
 */
const ticketServiceMock = {
  getTicket: jest.fn(),
  updateTicketFields: jest.fn(),
  changeStatus: jest.fn(),
  assignTicket: jest.fn(),
  listTickets: jest.fn(),
  createTicket: jest.fn(),
  addPrivateNote: jest.fn(),
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/middleware/apiKeyAuth.js', () => ({
  requireApiKey: () => (req, _res, next) => {
    req.workspaceId = 5;
    req.apiKey = { name: 'ContinuIT', keyPrefix: 'tp_test_x', mode: 'live', scopes: ['*'], oauthClientId: 12 };
    next();
  },
  apiRequestContext: (_req, _res, next) => next(),
  clientIp: () => '127.0.0.1',
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/technicianRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/groupRepository.js', () => ({ default: { listForWorkspace: jest.fn() } }));
jest.unstable_mockModule('../src/services/oauthClientService.js', () => ({ verifyClientCredentials: jest.fn(), issueAccessToken: jest.fn() }));
jest.unstable_mockModule('../src/services/apiRateLimitService.js', () => ({ default: { hit: jest.fn().mockResolvedValue({ allowed: true, reset: 0 }) } }));
jest.unstable_mockModule('../src/middleware/apiIdempotency.js', () => ({ withIdempotency: (_req, _res, next) => next() }));

const { default: apiV1Routes } = await import('../src/routes/apiV1.routes.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', apiV1Routes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ success: false, message: err.message, code: err.code }));
  return app;
}

const TICKET = {
  id: 501, workspaceId: 5, origin: 'freshservice', freshserviceTicketId: 243614, subject: 'VPN drops', status: 'Open', priority: 2,
  requester: { name: 'ACME', email: 'acme@example.com' }, thread: [{ id: 1, bodyText: 'hello', kind: 'reply' }],
};

beforeEach(() => {
  jest.clearAllMocks();
  ticketServiceMock.getTicket.mockResolvedValue(TICKET);
  ticketServiceMock.addPrivateNote.mockResolvedValue({ entry: { id: 9001 } });
});

describe('API v1 reads do not re-ask FreshService', () => {
  test('GET /tickets/:id answers from the Ticket Pulse copy (reconcile: false)', async () => {
    const res = await request(buildApp()).get('/api/v1/tickets/501');
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(501);
    expect(ticketServiceMock.getTicket).toHaveBeenCalledWith(501, 5, { reconcile: false });
  });

  test('GET /tickets/:id/conversations likewise', async () => {
    const res = await request(buildApp()).get('/api/v1/tickets/501/conversations');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(ticketServiceMock.getTicket).toHaveBeenCalledWith(501, 5, { reconcile: false });
  });

  test('the read after a PATCH likewise — the write already went through', async () => {
    const res = await request(buildApp()).patch('/api/v1/tickets/501').send({ addNote: 'checked the switch' });
    expect(res.status).toBe(200);
    expect(ticketServiceMock.getTicket).toHaveBeenCalledWith(501, 5, { reconcile: false });
    expect(ticketServiceMock.getTicket.mock.calls.every((c) => c[2]?.reconcile === false)).toBe(true);
  });
});
