import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Simorgh IT read-search (6 Nov 2026): the SOC agents check IT change records
 * before calling admin activity benign. Full-text search gains list filters, a
 * cursor, snippet, matchedIn and url; a credential can carry read limits
 * (hidden categories, no private notes) that Ticket Pulse enforces itself.
 * (Harness copied from apiV1Search.test.js.)
 */
const ticketServiceMock = { getTicket: jest.fn(), createTicket: jest.fn(), updateTicketFields: jest.fn(), changeStatus: jest.fn(), assignTicket: jest.fn(), listTickets: jest.fn(), setTags: jest.fn(), buildListWhere: jest.fn() };
const technicianRepositoryMock = { getAll: jest.fn() };
const prismaMock = { requester: { findMany: jest.fn() }, technician: { findFirst: jest.fn(), findMany: jest.fn() }, groupMember: { findMany: jest.fn().mockResolvedValue([]) }, competencyCategory: { findMany: jest.fn().mockResolvedValue([]) }, workspace: { findUnique: jest.fn().mockResolvedValue({ externalRefCustomFieldKey: null, apiResubmissionMatchEnabled: false, apiResubmissionMatchWindowDays: 30 }) } };
let apiKey;

prismaMock.$queryRawUnsafe = jest.fn();
prismaMock.ticketTag = { findFirst: jest.fn(), create: jest.fn() };
prismaMock.ticketTagLink = { findMany: jest.fn() };
prismaMock.ticket = { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() };
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

const KEY = { name: 'Simorgh', keyPrefix: 'tpc_simo', mode: 'live', scopes: ['*'], oauthClientId: 10, trustedIntake: true, structureOwnTicketsOnly: true };
const LIMITED = { ...KEY, readExcludeCategoryIds: [10, 133], readPrivateNotes: false };
const LONG = `${'Routine maintenance window for the core switch. '.repeat(10)}The PIM activation for Global Administrator was approved for the Entra app URL change. ${'Rollback plan attached. '.repeat(10)}`;

const ticketsById = {
  3: { id: 3, subject: 'Change: Entra app redirect URL', status: 'Closed', ticketType: 'Change' },
  1: { id: 1, subject: 'PIM activation request', status: 'Resolved', ticketType: 'Service Request' },
};

beforeEach(() => {
  jest.clearAllMocks();
  apiKey = KEY;
  prismaMock.$queryRawUnsafe.mockResolvedValue([{ id: 3, bucket: 3 }, { id: 1, bucket: 2 }, { id: 7, bucket: 1 }]);
  ticketServiceMock.buildListWhere.mockResolvedValue({ workspaceId: 8, status: { notIn: ['Deleted', 'Spam'] } });
  prismaMock.ticket.findMany.mockImplementation(async ({ select }) => (select.descriptionText
    ? [{ id: 3, descriptionText: LONG }, { id: 1, descriptionText: 'Short note.' }]
    : [{ id: 3 }, { id: 1 }]));
  ticketServiceMock.listTickets.mockImplementation(async (_ws, { ids }) => ({ items: (ids || []).map((id) => ticketsById[id]).filter(Boolean) }));
});

describe('GET /search/tickets?in= with filters, cursor, snippet and url', () => {
  test('list filters narrow the ranked pool; items say where they matched and carry a snippet', async () => {
    const res = await request(app()).get('/api/v1/search/tickets?q=PIM%20activation&in=subject,description&type=Change,Service%20Request&status=Resolved,Closed&createdFrom=2026-10-01').expect(200);
    expect(res.body.data.items.map((t) => t.id)).toEqual([3, 1]);
    expect(res.body.data.items[0].matchedIn).toBe('subject');
    expect(res.body.data.items[1].matchedIn).toBe('description');
    expect(res.body.data.items[0].snippet).toContain('PIM activation');
    expect(res.body.data.items[0].snippet.length).toBeLessThanOrEqual(302);
    expect(res.body.data.items[1].snippet).toBe('Short note.');
    expect(res.body.data.items[0]).toHaveProperty('url');
    expect(res.body.data.pagination).toEqual({ limit: 25, count: 2, next_cursor: null, truncated: false });
    const [ws, query] = ticketServiceMock.buildListWhere.mock.calls[0];
    expect(ws).toBe(8);
    expect(query).toMatchObject({ type: 'Change,Service Request', status: 'Resolved,Closed', createdFrom: '2026-10-01' });
    expect(query).not.toHaveProperty('q');
    expect(query).not.toHaveProperty('in');
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][0]).toContain('LIMIT 500');
  });

  test('the cursor walks the filtered ranking', async () => {
    const first = await request(app()).get('/api/v1/search/tickets?q=PIM&in=subject&limit=1').expect(200);
    expect(first.body.data.items.map((t) => t.id)).toEqual([3]);
    const cursor = first.body.data.pagination.next_cursor;
    expect(cursor).toBeTruthy();
    const second = await request(app()).get(`/api/v1/search/tickets?q=PIM&in=subject&limit=1&cursor=${cursor}`).expect(200);
    expect(second.body.data.items.map((t) => t.id)).toEqual([1]);
    expect(second.body.data.pagination.next_cursor).toBeNull();
  });

  test('a cursor this search did not hand out is a 400', async () => {
    await request(app()).get('/api/v1/search/tickets?q=PIM&in=subject&cursor=bm9wZQ').expect(400);
  });

  test('requesterEmail and assigneeEmail resolve to ids; no match means no tickets', async () => {
    prismaMock.requester.findMany.mockResolvedValue([{ id: 55 }]);
    prismaMock.technician.findMany.mockResolvedValue([{ id: 9 }]);
    await request(app()).get('/api/v1/search/tickets?q=PIM&in=subject&requesterEmail=PAM@bgc.ca&assigneeEmail=agent@bgc.ca').expect(200);
    expect(prismaMock.requester.findMany.mock.calls[0][0].where).toEqual({ OR: [{ email: { equals: 'pam@bgc.ca', mode: 'insensitive' } }] });
    expect(ticketServiceMock.buildListWhere.mock.calls[0][1]).toMatchObject({ requesterId: '55', assignedTechId: '9' });

    jest.clearAllMocks();
    prismaMock.requester.findMany.mockResolvedValue([]);
    const res = await request(app()).get('/api/v1/tickets?requesterEmail=nobody@bgc.ca').expect(200);
    expect(res.body.data.items).toEqual([]);
    expect(ticketServiceMock.listTickets).not.toHaveBeenCalled();
  });
});

describe('read limits on the credential', () => {
  test('hidden categories reach every list query, and a caller cannot set or clear them', async () => {
    apiKey = LIMITED;
    ticketServiceMock.listTickets.mockResolvedValue({ items: [], nextCursor: null, pageSize: 25, total: 0 });
    await request(app()).get('/api/v1/tickets?excludeCategoryIds=999').expect(200);
    expect(ticketServiceMock.listTickets.mock.calls[0][1].excludeCategoryIds).toEqual([10, 133]);

    apiKey = KEY;
    jest.clearAllMocks();
    ticketServiceMock.listTickets.mockResolvedValue({ items: [], nextCursor: null, pageSize: 25, total: 0 });
    await request(app()).get('/api/v1/tickets?excludeCategoryIds=999').expect(200);
    expect(ticketServiceMock.listTickets.mock.calls[0][1]).not.toHaveProperty('excludeCategoryIds');
  });

  test('full-text search applies them to the pool', async () => {
    apiKey = LIMITED;
    await request(app()).get('/api/v1/search/tickets?q=PIM&in=subject').expect(200);
    expect(ticketServiceMock.buildListWhere.mock.calls[0][1].excludeCategoryIds).toEqual([10, 133]);
  });

  test('a ticket in a hidden category answers 404 like a missing one, on reads and writes', async () => {
    apiKey = LIMITED;
    prismaMock.ticket.findFirst.mockResolvedValue({ internalCategoryId: 132, internalSubcategoryId: 10 });
    await request(app()).get('/api/v1/tickets/901').expect(404);
    await request(app()).patch('/api/v1/tickets/901').send({ priority: 3 }).expect(404);
    expect(ticketServiceMock.getTicket).not.toHaveBeenCalled();
    expect(ticketServiceMock.updateTicketFields).not.toHaveBeenCalled();
  });

  test('a ticket outside them reads normally', async () => {
    apiKey = LIMITED;
    prismaMock.ticket.findFirst.mockResolvedValue({ internalCategoryId: 132, internalSubcategoryId: 2 });
    ticketServiceMock.getTicket.mockResolvedValue({ id: 901, subject: 'Offboarding: J. Doe', thread: [] });
    await request(app()).get('/api/v1/tickets/901').expect(200);
  });

  test('private notes off: conversations and conversation search are public only', async () => {
    apiKey = LIMITED;
    prismaMock.ticket.findFirst.mockResolvedValue({ internalCategoryId: 52, internalSubcategoryId: 22 });
    ticketServiceMock.getTicket.mockResolvedValue({ id: 901, thread: [
      { id: 1, eventType: 'reply', bodyText: 'Done, MFA reset.', isPrivate: false },
      { id: 2, eventType: 'note', bodyText: 'Approved by the CFO by phone.', isPrivate: true },
    ] });
    const res = await request(app()).get('/api/v1/tickets/901/conversations').expect(200);
    expect(res.body.data.map((e) => e.id)).toEqual([1]);
    await request(app()).get('/api/v1/search/tickets?q=CFO&in=conversations').expect(200);
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][0]).toContain('e.is_private IS NOT TRUE');
  });

  test('private notes on (the default): the full thread, and conversation search unchanged', async () => {
    ticketServiceMock.getTicket.mockResolvedValue({ id: 901, thread: [
      { id: 1, eventType: 'reply', bodyText: 'Done.', isPrivate: false },
      { id: 2, eventType: 'note', bodyText: 'Approved by phone.', isPrivate: true },
    ] });
    const res = await request(app()).get('/api/v1/tickets/901/conversations').expect(200);
    expect(res.body.data.map((e) => e.id)).toEqual([1, 2]);
    await request(app()).get('/api/v1/search/tickets?q=phone&in=conversations').expect(200);
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][0]).not.toContain('is_private');
    expect(prismaMock.ticket.findFirst).not.toHaveBeenCalled();
  });

  test('similar-search hits in a hidden category are dropped', async () => {
    apiKey = LIMITED;
    similarMock.search.mockResolvedValue({ results: { text: [{ id: 45790, score: 0.8 }, { id: 45791, score: 0.7 }] }, meta: {} });
    prismaMock.ticket.findMany.mockResolvedValue([{ id: 45790 }]);
    const res = await request(app()).post('/api/v1/search/similar').send({ text: 'new hire laptop for Calgary' }).expect(200);
    expect(res.body.data.map((h) => h.id)).toEqual([45791]);
  });
});

describe('searchSnippet', () => {
  test('centres on the first query word and marks cut ends', async () => {
    const { searchSnippet } = await import('../src/routes/apiV1.routes.js');
    const s = searchSnippet(LONG, 'pim');
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s).toContain('PIM activation');
    expect(searchSnippet('', 'x')).toBeNull();
    expect(searchSnippet('  a   b  ', 'zz')).toBe('a b');
  });
});

describe('requester queries', () => {
  test('never filter requesters by workspace (the model has no such column; Prisma refuses the query)', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../src/routes/apiV1.routes.js', import.meta.url), 'utf8');
    const calls = src.match(/prisma\.requester\.find(?:Many|First)\(\{[^\n]*/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).not.toMatch(/workspaceId/);
    const contactsWhere = src.slice(src.indexOf("router.get('/contacts', S"), src.indexOf("router.get('/contacts/:id'"));
    expect(contactsWhere).not.toMatch(/workspaceId/);
  });
});
