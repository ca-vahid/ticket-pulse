import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Simorgh asks 2 + 6 (19 Sep 2026): an integration holds REFERENCES, not our row
 * ids — so a ticket named in a request body may be "TP-1504" as well as 44797 —
 * and GET /tickets/{id} says where a merged ticket went.
 */
const ticketServiceMock = { getTicket: jest.fn() };
const mergeMock = { merge: jest.fn() };
const linkMock = { setParent: jest.fn(), relationsSummary: jest.fn() };
const resolverMock = { resolveTicketRefOrThrow: jest.fn(), resolveTicketRef: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/middleware/apiKeyAuth.js', () => ({
  requireApiKey: () => (req, _res, next) => {
    req.workspaceId = 1;
    req.apiKey = { name: 'Simorgh', keyPrefix: 'tpc_890e', mode: 'live', scopes: ['*'], oauthClientId: 10 };
    next();
  },
  apiRequestContext: (_req, _res, next) => next(),
  clientIp: () => '127.0.0.1',
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/ticketMergeService.js', () => ({ default: mergeMock }));
jest.unstable_mockModule('../src/services/ticketLinkService.js', () => ({ default: linkMock }));
jest.unstable_mockModule('../src/services/ticketRefResolver.js', () => resolverMock);
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

const TICKET = { id: 44797, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1504, subject: 'Sentinel incident', status: 'Closed', priority: 2, requester: { name: 'Simorgh', email: 'soc@bgcengineering.ca' }, ccEmails: [], customFields: {}, displayRef: 'TP-1504' };

beforeEach(() => {
  jest.clearAllMocks();
  ticketServiceMock.getTicket.mockResolvedValue(TICKET);
  mergeMock.merge.mockResolvedValue({ merged: true });
  linkMock.setParent.mockResolvedValue({ parent: null, children: [] });
  linkMock.relationsSummary.mockResolvedValue({ mergedInto: { id: 44001, ref: 'TP-1490', status: 'Open' }, parent: null, childCount: 0 });
  resolverMock.resolveTicketRefOrThrow.mockImplementation(async (raw) => ({ id: { 'TP-1490': 44001, 'TP-1504': 44797, 'SR-242218': 44797 }[raw] }));
});

describe('GET /api/v1/tickets/:id — relations', () => {
  test('a merged ticket still answers, and says where the work went', async () => {
    const res = await request(buildApp()).get('/api/v1/tickets/44797').expect(200);
    expect(res.body.data.relations).toEqual({ mergedInto: { id: 44001, ref: 'TP-1490', status: 'Open' }, parent: null, childCount: 0 });
    expect(linkMock.relationsSummary).toHaveBeenCalledWith(44797, 1);
  });

  test('a relations lookup failure costs the block, never the ticket', async () => {
    linkMock.relationsSummary.mockRejectedValue(new Error('db'));
    const res = await request(buildApp()).get('/api/v1/tickets/44797').expect(200);
    expect(res.body.data.relations).toEqual({ mergedInto: null, parent: null, childCount: 0 });
    expect(res.body.data.ref).toBe('TP-1504');
  });
});

describe('ticket references in request bodies', () => {
  test('merge: `target` may be a display reference', async () => {
    await request(buildApp()).post('/api/v1/tickets/TP-1504/merge').send({ target: 'TP-1490' }).expect(200);
    expect(mergeMock.merge).toHaveBeenCalledWith(44797, 1, { targetTicketId: 44001, notifyRequester: false }, expect.any(Object));
  });

  test('merge: the numeric `targetTicketId` keeps working, as a number or a numeric string', async () => {
    await request(buildApp()).post('/api/v1/tickets/44797/merge').send({ targetTicketId: 44001 }).expect(200);
    await request(buildApp()).post('/api/v1/tickets/44797/merge').send({ targetTicketId: '44001' }).expect(200);
    expect(mergeMock.merge.mock.calls.map((c) => c[2].targetTicketId)).toEqual([44001, 44001]);
    expect(resolverMock.resolveTicketRefOrThrow).not.toHaveBeenCalled();
  });

  test('parent: `parent` may be a display reference, `parentTicketId` a reference too', async () => {
    await request(buildApp()).put('/api/v1/tickets/44797/parent').send({ parent: 'TP-1490' }).expect(200);
    await request(buildApp()).put('/api/v1/tickets/44797/parent').send({ parentTicketId: 'TP-1490' }).expect(200);
    expect(linkMock.setParent.mock.calls.map((c) => c[2])).toEqual([{ parentTicketId: 44001 }, { parentTicketId: 44001 }]);
  });

  test('an unknown reference is the resolver’s 404, not a merge into NaN', async () => {
    const { NotFoundError } = await import('../src/utils/errors.js');
    resolverMock.resolveTicketRefOrThrow.mockRejectedValue(new NotFoundError('No ticket matching "TP-9999"'));
    await request(buildApp()).post('/api/v1/tickets/44797/merge').send({ target: 'TP-9999' }).expect(404);
    expect(mergeMock.merge).not.toHaveBeenCalled();
  });
});
