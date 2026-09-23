import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Simorgh ask 2 (Phase B-1): links, children and merge-many on v1, every
 * structural route behind the own-tickets guard, task externalRef passed
 * through, readyToCloseAt on the read shape.
 */
const ticketServiceMock = { getTicket: jest.fn() };
const mergeMock = { merge: jest.fn(), mergeMany: jest.fn() };
const linkMock = { setParent: jest.fn(), removeParent: jest.fn(), addChild: jest.fn(), listForTicket: jest.fn(), link: jest.fn(), unlink: jest.fn(), relationsSummary: jest.fn() };
const splitMock = { split: jest.fn() };
const taskMock = { create: jest.fn(), listForTicket: jest.fn() };
const guardMock = { assertClientMayStructure: jest.fn() };
const resolverMock = { resolveTicketRefOrThrow: jest.fn(), resolveTicketRef: jest.fn() };
let apiKey;

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/middleware/apiKeyAuth.js', () => ({
  requireApiKey: () => (req, _res, next) => { req.workspaceId = 1; req.apiKey = apiKey; next(); },
  apiRequestContext: (_req, _res, next) => next(),
  clientIp: () => '127.0.0.1',
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/ticketMergeService.js', () => ({ default: mergeMock }));
jest.unstable_mockModule('../src/services/ticketLinkService.js', () => ({ default: linkMock }));
jest.unstable_mockModule('../src/services/ticketSplitService.js', () => ({ default: splitMock }));
jest.unstable_mockModule('../src/services/ticketTaskService.js', () => ({ default: taskMock }));
jest.unstable_mockModule('../src/services/ticketStructureGuard.js', () => guardMock);
jest.unstable_mockModule('../src/services/ticketRefResolver.js', () => resolverMock);
jest.unstable_mockModule('../src/services/technicianRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/groupRepository.js', () => ({ default: { listForWorkspace: jest.fn() } }));
jest.unstable_mockModule('../src/services/oauthClientService.js', () => ({ verifyClientCredentials: jest.fn(), issueAccessToken: jest.fn() }));
jest.unstable_mockModule('../src/services/apiRateLimitService.js', () => ({ default: { hit: jest.fn().mockResolvedValue({ allowed: true, reset: 0 }) } }));
jest.unstable_mockModule('../src/middleware/apiIdempotency.js', () => ({ withIdempotency: (_req, _res, next) => next() }));

const { default: apiV1Routes } = await import('../src/routes/apiV1.routes.js');
const { AuthorizationError } = await import('../src/utils/errors.js');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1', apiV1Routes);
  // eslint-disable-next-line no-unused-vars
  a.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ success: false, message: err.message, code: err.code }));
  return a;
}

const REFS = { 'TP-1601': 1, 'TP-1602': 2, 'TP-1603': 3, 'TP-1604': 4 };
const TICKET = { id: 1, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1601, subject: 'Story', status: 'Open', priority: 2, requester: { name: 'Simorgh', email: 'soc@bgc.ca' }, ccEmails: [], customFields: {}, displayRef: 'TP-1601', readyToCloseAt: new Date('2026-09-19T18:00:00Z') };

beforeEach(() => {
  jest.clearAllMocks();
  apiKey = { name: 'Simorgh', keyPrefix: 'tpc_890e', mode: 'live', scopes: ['*'], oauthClientId: 10, structureOwnTicketsOnly: true };
  guardMock.assertClientMayStructure.mockResolvedValue(undefined);
  resolverMock.resolveTicketRefOrThrow.mockImplementation(async (raw) => ({ id: REFS[raw] }));
  ticketServiceMock.getTicket.mockResolvedValue(TICKET);
  linkMock.relationsSummary.mockResolvedValue({ mergedInto: null, parent: null, childCount: 2 });
  linkMock.addChild.mockResolvedValue({ parent: null, children: [{ id: 2 }] });
  linkMock.listForTicket.mockResolvedValue([{ id: 5, kind: 'related_to', direction: 'out', other: { id: 4, displayRef: 'TP-1604', subject: 'Earlier reverse shell', status: 'Closed' } }]);
  linkMock.link.mockResolvedValue({ id: 6, kind: 'related_to', ticketId: 1, relatedTicketId: 4 });
  linkMock.unlink.mockResolvedValue({ deleted: true });
  mergeMock.merge.mockResolvedValue({ merged: true });
  mergeMock.mergeMany.mockResolvedValue({ primaryId: 1, merged: [{ id: 2 }, { id: 3 }], failed: [] });
  splitMock.split.mockResolvedValue({ child: { id: 9 } });
  taskMock.create.mockResolvedValue({ id: 812, title: 'Isolate', externalRef: 'simorgh:action:9f2c' });
});

describe('links', () => {
  test('GET lists with the other ticket by reference', async () => {
    const res = await request(app()).get('/api/v1/tickets/TP-1601/links').expect(200);
    expect(res.body.data).toEqual([{ id: 5, kind: 'related_to', direction: 'out', label: null, other: { id: 4, ref: 'TP-1604', subject: 'Earlier reverse shell', status: 'Closed' } }]);
  });

  test('POST takes `related` as a reference and a kind; guards the URL ticket only', async () => {
    const res = await request(app()).post('/api/v1/tickets/1/links').send({ related: 'TP-1604', kind: 'related_to' }).expect(201);
    expect(linkMock.link).toHaveBeenCalledWith(1, 1, { relatedTicketId: 4, kind: 'related_to' }, expect.objectContaining({ role: 'api' }));
    expect(guardMock.assertClientMayStructure).toHaveBeenCalledWith(apiKey, [1], 'link');
    expect(res.body.data).toEqual({ id: 6, kind: 'related_to', ticketId: 1, relatedTicketId: 4 });
  });

  test('POST without the other ticket → 400 invalid_request', async () => {
    const res = await request(app()).post('/api/v1/tickets/1/links').send({ kind: 'related_to' }).expect(400);
    expect(res.body.code).toBe('invalid_request');
    expect(linkMock.link).not.toHaveBeenCalled();
  });

  test('DELETE passes the actor so history says who unlinked', async () => {
    await request(app()).delete('/api/v1/tickets/1/links/6').expect(200);
    expect(linkMock.unlink).toHaveBeenCalledWith(1, 1, '6', expect.objectContaining({ role: 'api' }));
  });
});

describe('children and merge-many', () => {
  test('POST /children guards BOTH tickets and adds the child', async () => {
    await request(app()).post('/api/v1/tickets/TP-1601/children').send({ child: 'TP-1602' }).expect(201);
    expect(guardMock.assertClientMayStructure).toHaveBeenCalledWith(apiKey, [1, 2], 're-parent');
    expect(linkMock.addChild).toHaveBeenCalledWith(1, 1, { childTicketId: 2 }, expect.any(Object));
  });

  test('POST /merge-many resolves every source reference, guards primary + sources, caps at 20', async () => {
    const res = await request(app()).post('/api/v1/tickets/TP-1601/merge-many').send({ sources: ['TP-1602', 3] }).expect(200);
    expect(guardMock.assertClientMayStructure).toHaveBeenCalledWith(apiKey, [1, 2, 3], 'merge');
    expect(mergeMock.mergeMany).toHaveBeenCalledWith(1, 1, { ticketIds: [2, 3], notifyRequester: false, resolutionReason: null, resolutionNote: null }, expect.any(Object));
    expect(res.body.data.merged).toHaveLength(2);
    await request(app()).post('/api/v1/tickets/1/merge-many').send({ sources: [] }).expect(400);
    await request(app()).post('/api/v1/tickets/1/merge-many').send({ sources: Array.from({ length: 21 }, (_, i) => 100 + i) }).expect(400);
  });
});

describe('the guard sits in front of every structural route', () => {
  test.each([
    ['merge', (a) => a.post('/api/v1/tickets/1/merge').send({ target: 'TP-1602' }), [1, 2]],
    ['split', (a) => a.post('/api/v1/tickets/1/split').send({ subject: 'Part two' }), [1]],
    ['parent PUT', (a) => a.put('/api/v1/tickets/1/parent').send({ parent: 'TP-1602' }), [1, 2]],
    ['parent DELETE', (a) => a.delete('/api/v1/tickets/1/parent'), [1]],
  ])('%s asks the guard about the tickets it changes', async (_label, call, expected) => {
    await call(request(app())).expect((r) => { if (r.status >= 400) throw new Error(`${r.status} ${JSON.stringify(r.body)}`); });
    expect(guardMock.assertClientMayStructure.mock.calls[0][1]).toEqual(expected);
  });

  test('a refusal surfaces as 403 not_client_ticket and nothing is written', async () => {
    guardMock.assertClientMayStructure.mockRejectedValue(new AuthorizationError('This client may only merge tickets it created. Not yours: TP-1602.', 'not_client_ticket'));
    const res = await request(app()).post('/api/v1/tickets/1/merge').send({ target: 'TP-1602' }).expect(403);
    expect(res.body.code).toBe('not_client_ticket');
    expect(mergeMock.merge).not.toHaveBeenCalled();
  });
});

describe('tasks and the read shape', () => {
  test('POST /tasks passes externalRef through to the service', async () => {
    await request(app()).post('/api/v1/tickets/1/tasks').send({ title: 'Isolate', externalRef: 'simorgh:action:9f2c' }).expect(201);
    expect(taskMock.create).toHaveBeenCalledWith(1, 1, expect.objectContaining({ externalRef: 'simorgh:action:9f2c' }), expect.any(Object));
  });

  test('GET /tickets/{id} carries readyToCloseAt', async () => {
    const res = await request(app()).get('/api/v1/tickets/1').expect(200);
    expect(res.body.data.readyToCloseAt).toBe('2026-09-19T18:00:00.000Z');
  });
});
