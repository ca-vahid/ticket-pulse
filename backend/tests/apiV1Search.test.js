import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * ContinuIT SEARCH request (23 Sep 2026): POST /search/similar (+ batch),
 * GET /search/tickets?in=…, and one-tag add/remove for linking.
 *
 * (Harness copied from apiV1ContinuIT.test.js.) Original header:
 * ContinuIT integration request (rev. 2, 15 Sep 2026; built 19 Sep):
 *  B1  dueBy on POST /tickets and PATCH /tickets/{id} for trusted-intake
 *      credentials, stored as a manual due date.
 *  C1  GET /agents with e-mail, active flag, FreshService id and office.
 *  C3/C4  GET /contacts filterable by location; e-mail is the join key.
 *  Go-live round (19 Sep, 3.9.54): B4 assignedTechEmail, C1 origin + groups[],
 *  C3 jobTitle, B6 categories description/isActive, C2 ids= batch read.
 */
const ticketServiceMock = { getTicket: jest.fn(), createTicket: jest.fn(), updateTicketFields: jest.fn(), changeStatus: jest.fn(), assignTicket: jest.fn(), listTickets: jest.fn(), setTags: jest.fn() };
const technicianRepositoryMock = { getAll: jest.fn() };
const prismaMock = { requester: { findMany: jest.fn() }, technician: { findFirst: jest.fn() }, groupMember: { findMany: jest.fn().mockResolvedValue([]) }, competencyCategory: { findMany: jest.fn().mockResolvedValue([]) }, workspace: { findUnique: jest.fn().mockResolvedValue({ externalRefCustomFieldKey: null, apiResubmissionMatchEnabled: false, apiResubmissionMatchWindowDays: 30 }) } };
let apiKey;

prismaMock.$queryRawUnsafe = jest.fn();
prismaMock.ticketTag = { findFirst: jest.fn() };
prismaMock.ticketTagLink = { findMany: jest.fn() };
prismaMock.ticket = { findFirst: jest.fn(), findUnique: jest.fn() };
const similarMock = { search: jest.fn() };
const fsStatusMock = { isFreshServiceBorn: jest.fn(), changeFsBornStatus: jest.fn() };
const alertMock = { record: jest.fn() };
jest.unstable_mockModule('../src/services/alertOccurrenceService.js', () => ({ default: alertMock }));
const refsMock = { listReferences: jest.fn(), addReferences: jest.fn(), normalizeReference: jest.fn((r) => ({ system: 'sentinel', externalId: r.incidentId, alertId: r.alertId || null })), MAX_REFERENCES_PER_CALL: 50 };
jest.unstable_mockModule('../src/services/ticketExternalReferenceService.js', () => ({ default: refsMock }));
jest.unstable_mockModule('../src/services/fsBornStatusService.js', () => ({ default: fsStatusMock }));
jest.unstable_mockModule('../src/services/ticketSimilaritySearchService.js', () => ({ default: similarMock }));
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/middleware/apiKeyAuth.js', () => ({
  requireApiKey: () => (req, _res, next) => { req.workspaceId = 8; req.apiKey = apiKey; next(); },
  apiRequestContext: (_req, _res, next) => next(),
  clientIp: () => '127.0.0.1',
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/technicianRepository.js', () => ({ default: technicianRepositoryMock }));
jest.unstable_mockModule('../src/services/groupRepository.js', () => ({ default: { listForWorkspace: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketResubmissionService.js', () => ({ default: { findByExternalRef: jest.fn().mockResolvedValue(null), deriveExternalRef: jest.fn().mockResolvedValue({ ref: null, ticket: null, matchedBy: null }), applyResubmission: jest.fn() }, normalizeExternalRef: (v) => v }));
jest.unstable_mockModule('../src/services/ticketLinkService.js', () => ({ default: { relationsSummary: jest.fn().mockResolvedValue({ mergedInto: null, parent: null, childCount: 0 }) } }));
jest.unstable_mockModule('../src/services/oauthClientService.js', () => ({ verifyClientCredentials: jest.fn(), issueAccessToken: jest.fn() }));
jest.unstable_mockModule('../src/services/apiRateLimitService.js', () => ({ default: { hit: jest.fn().mockResolvedValue({ allowed: true, reset: 0 }) } }));
jest.unstable_mockModule('../src/middleware/apiIdempotency.js', () => ({ withIdempotency: (_req, _res, next) => next() }));

const { default: apiV1Routes } = await import('../src/routes/apiV1.routes.js');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1', apiV1Routes);
  // eslint-disable-next-line no-unused-vars
  a.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ success: false, message: err.message || err.detail, code: err.code }));
  return a;
}

const KEY = { name: 'ContinuIT', keyPrefix: 'tpc_cont', mode: 'live', scopes: ['*'], oauthClientId: 12, trustedIntake: true };
const HIT = { id: 45790, ref: 'TP-1591', subject: 'Fredericton firewall replacement', score: 0.82, matchedOn: 'semantic' };
const META = { scoreModel: '2026-09-23', thresholds: { likely: 0.7, possible: 0.6 }, semantic: true };

beforeEach(() => {
  jest.clearAllMocks();
  apiKey = KEY;
  similarMock.search.mockResolvedValue({ results: { text: [HIT] }, meta: META });
});

describe('POST /search/similar', () => {
  test('passes the text and only the documented options; answers the hit list + meta', async () => {
    const res = await request(app()).post('/api/v1/search/similar')
      .send({ text: 'the firewall for Fredericton', limit: 3, minScore: 0.6, status: ['open'], excludeExternalRefPrefix: 'continuit:', requesterEmail: 'om@bgc.ca', department: 'Fredericton', junk: 1 })
      .expect(200);
    expect(similarMock.search).toHaveBeenCalledWith(8, [{ key: 'text', text: 'the firewall for Fredericton' }],
      { limit: 3, minScore: 0.6, status: ['open'], excludeExternalRefPrefix: 'continuit:', requesterEmail: 'om@bgc.ca', department: 'Fredericton' });
    expect(res.body.data).toEqual([HIT]);
    expect(res.body.meta.scoreModel).toBe('2026-09-23');
  });

  test('a validation error from the service is a 400 naming the field', async () => {
    similarMock.search.mockRejectedValue(Object.assign(new Error('limit must be an integer 1–20'), { field: 'limit', validation: true }));
    const res = await request(app()).post('/api/v1/search/similar').send({ text: 'x y z', limit: 99 }).expect(400);
    // The router's own problem+json handler answers: detail names the field.
    expect(res.body.detail || res.body.message).toMatch(/limit/);
  });

  test('needs search:read', async () => {
    apiKey = { ...KEY, scopes: ['tickets:read'] };
    // requireApiKey is mocked to pass; the route declares the scope — assert the declaration instead.
    const src = (await import('node:fs')).readFileSync(new URL('../src/routes/apiV1.routes.js', import.meta.url), 'utf8');
    expect(src).toContain("router.post('/search/similar', S('search:read')");
    expect(src).toContain("router.post('/search/similar/batch', S('search:read')");
  });
});

describe('POST /search/similar/batch', () => {
  test('forwards items and answers keyed results', async () => {
    similarMock.search.mockResolvedValue({ results: { 'extracted-1': [HIT], 'extracted-2': [] }, meta: META });
    const items = [{ key: 'extracted-1', text: 'firewall Fredericton' }, { key: 'extracted-2', text: 'nothing like it' }];
    const res = await request(app()).post('/api/v1/search/similar/batch').send({ items, limit: 3, minScore: 0.55 }).expect(200);
    expect(similarMock.search).toHaveBeenCalledWith(8, items, { limit: 3, minScore: 0.55 });
    expect(res.body.data).toEqual({ 'extracted-1': [HIT], 'extracted-2': [] });
  });
});

describe('GET /search/tickets?in=', () => {
  test('ranks through the full-text query, keeps that order, and shapes tickets', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ id: 3 }, { id: 1 }]);
    ticketServiceMock.listTickets.mockResolvedValue({ items: [{ id: 1, subject: 'b', status: 'Open' }, { id: 3, subject: 'a', status: 'Open' }] });
    const res = await request(app()).get('/api/v1/search/tickets?query=lenovo%20calgary&in=subject,description').expect(200);
    expect(res.body.data.items.map((t) => t.id)).toEqual([3, 1]);
    const sql = prismaMock.$queryRawUnsafe.mock.calls[0][0];
    expect(sql).toContain('3 AS bucket');
    expect(sql).toContain('2 AS bucket');
    expect(sql).not.toContain('ticket_thread_entries');
    expect(ticketServiceMock.listTickets).toHaveBeenCalledWith(8, { ids: [3, 1], pageSize: 25 });
  });

  test('conversations need conversations:read; unknown fields are a 400', async () => {
    apiKey = { ...KEY, scopes: ['search:read', 'tickets:read'] };
    await request(app()).get('/api/v1/search/tickets?query=vpn&in=conversations').expect(403);
    await request(app()).get('/api/v1/search/tickets?query=vpn&in=subject,attachments').expect(400);
  });

  test('without in= the old substring search is unchanged', async () => {
    ticketServiceMock.listTickets.mockResolvedValue({ items: [], page: 1, pageSize: 25, total: 0 });
    await request(app()).get('/api/v1/search/tickets?query=TP-1580').expect(200);
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(ticketServiceMock.listTickets).toHaveBeenCalledWith(8, expect.objectContaining({ q: 'TP-1580' }));
  });
});

describe('one-tag add / remove (linking)', () => {
  beforeEach(() => {
    prismaMock.ticketTag.findFirst.mockResolvedValue({ id: 15, name: 'continuit' });
    prismaMock.ticketTagLink.findMany.mockResolvedValue([{ tagId: 3 }]);
    ticketServiceMock.setTags.mockResolvedValue({ changed: true, tags: [] });
  });

  test('POST adds the tag by name and keeps the tags already there', async () => {
    await request(app()).post('/api/v1/tickets/901/tags').send({ name: 'ContinuIT' }).expect(200);
    expect(prismaMock.ticketTag.findFirst.mock.calls[0][0].where).toMatchObject({ workspaceId: 8, isActive: true, name: { equals: 'ContinuIT', mode: 'insensitive' } });
    expect(ticketServiceMock.setTags).toHaveBeenCalledWith(901, 8, [3, 15], expect.any(Object));
  });

  test('DELETE removes only that tag (by id)', async () => {
    prismaMock.ticketTagLink.findMany.mockResolvedValue([{ tagId: 3 }, { tagId: 15 }]);
    await request(app()).delete('/api/v1/tickets/901/tags/15').expect(200);
    expect(prismaMock.ticketTag.findFirst.mock.calls[0][0].where).toMatchObject({ id: 15 });
    expect(ticketServiceMock.setTags).toHaveBeenCalledWith(901, 8, [3], expect.any(Object));
  });

  test('an unknown tag is a 404 and nothing is written', async () => {
    prismaMock.ticketTag.findFirst.mockResolvedValue(null);
    await request(app()).post('/api/v1/tickets/901/tags').send({ name: 'nope' }).expect(404);
    expect(ticketServiceMock.setTags).not.toHaveBeenCalled();
  });
});

describe('PATCH status on a FreshService-born ticket (23 Sep 2026)', () => {
  beforeEach(() => {
    ticketServiceMock.getTicket.mockResolvedValue({ id: 901, workspaceId: 8, origin: 'freshservice', freshserviceTicketId: 222417n, status: 'Resolved', subject: 's', ccEmails: [], customFields: {} });
    fsStatusMock.changeFsBornStatus.mockResolvedValue({ changed: true });
  });

  test('without the client permission → 403 fs_status_write_not_enabled, nothing written', async () => {
    fsStatusMock.isFreshServiceBorn.mockResolvedValue(true);
    apiKey = { ...KEY, fsStatusWrite: false };
    const res = await request(app()).patch('/api/v1/tickets/901').send({ status: 'Resolved' }).expect(403);
    expect(res.body.code).toBe('fs_status_write_not_enabled');
    expect(fsStatusMock.changeFsBornStatus).not.toHaveBeenCalled();
    expect(ticketServiceMock.changeStatus).not.toHaveBeenCalled();
  });

  test('with the permission → written through the FreshService path with the reason and note', async () => {
    fsStatusMock.isFreshServiceBorn.mockResolvedValue(true);
    apiKey = { ...KEY, fsStatusWrite: true };
    await request(app()).patch('/api/v1/tickets/901').send({ status: 'Resolved', resolutionReason: 'other', resolutionNote: 'Reported done at the Kelowna check-in' }).expect(200);
    expect(fsStatusMock.changeFsBornStatus).toHaveBeenCalledWith(901, 8, 'Resolved', expect.objectContaining({ role: 'api' }), { resolutionReason: 'other', resolutionNote: 'Reported done at the Kelowna check-in' });
    expect(ticketServiceMock.changeStatus).not.toHaveBeenCalled();
  });

  test('a Ticket Pulse-born ticket keeps the old path, permission or not', async () => {
    fsStatusMock.isFreshServiceBorn.mockResolvedValue(false);
    apiKey = { ...KEY, fsStatusWrite: false };
    await request(app()).patch('/api/v1/tickets/901').send({ status: 'Pending' }).expect(200);
    expect(ticketServiceMock.changeStatus).toHaveBeenCalledWith(901, 8, 'Pending', expect.any(Object), { resolutionReason: null, resolutionNote: null });
    expect(fsStatusMock.changeFsBornStatus).not.toHaveBeenCalled();
  });
});

describe('POST /alert-occurrences (Sentinel, 24 Sep 2026)', () => {
  beforeEach(() => {
    ticketServiceMock.getTicket.mockResolvedValue({ id: 45790, workspaceId: 8, origin: 'ticketpulse', nativeNumber: 1700, displayRef: 'TP-1700', subject: '[Sentinel] FTP down', status: 'Open', priority: 2, ccEmails: [], customFields: {}, occurrenceCount: 3, lastOccurrenceAt: new Date('2026-09-24T17:00:00Z') });
  });

  test('created → 201 with action, ticket (incl. url + occurrence fields) and occurrence block', async () => {
    alertMock.record.mockResolvedValue({ action: 'created', ticketId: 45790, previousTicketId: null, occurrenceCount: 1, lastOccurrenceAt: '2026-09-24T17:00:00Z', priorityRaised: false });
    const res = await request(app()).post('/api/v1/alert-occurrences').send({ fingerprint: 'sentinel:abc12345', title: 'x', requesterEmail: 's@bgc.ca' }).expect(201);
    expect(res.body.action).toBe('created');
    expect(res.body.data).toMatchObject({ id: 45790, ref: 'TP-1700', occurrenceCount: 3 });
    expect(res.body.data.url).toMatch(/\/tickets\/45790$/);
    expect(res.body.occurrence).toEqual({ count: 1, lastSeenAt: '2026-09-24T17:00:00Z' });
  });

  test('occurrence / reopened / duplicate → 200', async () => {
    for (const action of ['occurrence', 'reopened', 'duplicate']) {
      alertMock.record.mockResolvedValue({ action, ticketId: 45790, previousTicketId: null, occurrenceCount: 4, lastOccurrenceAt: null, priorityRaised: action === 'occurrence' });
      const res = await request(app()).post('/api/v1/alert-occurrences').send({ fingerprint: 'sentinel:abc12345' }).expect(200);
      expect(res.body.action).toBe(action);
    }
  });

  test('a later ticket carries previousTicket with its ref and url', async () => {
    alertMock.record.mockResolvedValue({ action: 'created', ticketId: 45790, previousTicketId: 45001, occurrenceCount: 1, lastOccurrenceAt: null, priorityRaised: false });
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 45001, origin: 'ticketpulse', nativeNumber: 1600, freshserviceTicketId: null });
    const res = await request(app()).post('/api/v1/alert-occurrences').send({ fingerprint: 'sentinel:abc12345' }).expect(201);
    expect(res.body.previousTicket).toMatchObject({ id: 45001, ref: 'TP-1600' });
  });

  test('validation → 400 naming the field; Informational → 422 informational_not_ticketed', async () => {
    alertMock.record.mockRejectedValueOnce(Object.assign(new Error('fingerprint is required'), { validation: true, field: 'fingerprint', code: 'invalid_request' }));
    await request(app()).post('/api/v1/alert-occurrences').send({}).expect(400);
    alertMock.record.mockRejectedValueOnce(Object.assign(new Error('Informational alerts are not ticketed'), { validation: true, field: 'severity', code: 'informational_not_ticketed' }));
    const res = await request(app()).post('/api/v1/alert-occurrences').send({ severity: 'Informational' }).expect(422);
    expect(res.body.code).toBe('informational_not_ticketed');
  });
});

describe('ticket references (R9)', () => {
  test('GET lists; POST adds (list or single) and answers the list + counts', async () => {
    refsMock.listReferences.mockResolvedValue([{ id: 1, system: 'sentinel', incidentId: 'inc-1' }]);
    const list = await request(app()).get('/api/v1/tickets/901/references').expect(200);
    expect(list.body.data).toHaveLength(1);
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 901 });
    refsMock.addReferences.mockResolvedValue({ added: 1, skipped: 1 });
    const res = await request(app()).post('/api/v1/tickets/901/references').send({ references: [{ incidentId: 'inc-1', alertId: 'a1' }, { incidentId: 'inc-2' }] }).expect(200);
    expect(refsMock.addReferences).toHaveBeenCalledWith(901, 8, [expect.objectContaining({ externalId: 'inc-1' }), expect.objectContaining({ externalId: 'inc-2' })], expect.any(String));
    expect(res.body.meta).toEqual({ added: 1, skipped: 1 });
  });

  test('an empty body is a 400', async () => {
    await request(app()).post('/api/v1/tickets/901/references').send({}).expect(400);
  });
});
