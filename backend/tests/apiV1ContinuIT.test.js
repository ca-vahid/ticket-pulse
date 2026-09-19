import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';

/**
 * ContinuIT integration request (rev. 2, 15 Sep 2026; built 19 Sep):
 *  B1  dueBy on POST /tickets and PATCH /tickets/{id} for trusted-intake
 *      credentials, stored as a manual due date.
 *  C1  GET /agents with e-mail, active flag, FreshService id and office.
 *  C3/C4  GET /contacts filterable by location; e-mail is the join key.
 *  Go-live round (19 Sep, 3.9.54): B4 assignedTechEmail, C1 origin + groups[],
 *  C3 jobTitle, B6 categories description/isActive, C2 ids= batch read.
 */
const ticketServiceMock = { getTicket: jest.fn(), createTicket: jest.fn(), updateTicketFields: jest.fn(), changeStatus: jest.fn(), assignTicket: jest.fn(), listTickets: jest.fn() };
const technicianRepositoryMock = { getAll: jest.fn() };
const prismaMock = { requester: { findMany: jest.fn() }, technician: { findFirst: jest.fn() }, groupMember: { findMany: jest.fn().mockResolvedValue([]) }, competencyCategory: { findMany: jest.fn().mockResolvedValue([]) }, workspace: { findUnique: jest.fn().mockResolvedValue({ externalRefCustomFieldKey: null, apiResubmissionMatchEnabled: false, apiResubmissionMatchWindowDays: 30 }) } };
let apiKey;

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

const TRUSTED = { name: 'ContinuIT', keyPrefix: 'tpc_cont', mode: 'live', scopes: ['*'], oauthClientId: 12, trustedIntake: true };
const PLAIN = { ...TRUSTED, name: 'Some app', trustedIntake: false };
const TICKET = { id: 901, workspaceId: 8, origin: 'ticketpulse', nativeNumber: 12, subject: 'Office check-in — Calgary', status: 'Open', priority: 2, requester: { name: 'ContinuIT', email: 'continuit@bgc.ca' }, ccEmails: [], customFields: {}, displayRef: 'TP-12', dueBy: new Date('2026-09-26T17:00:00Z') };

beforeEach(() => {
  jest.clearAllMocks();
  apiKey = TRUSTED;
  ticketServiceMock.getTicket.mockResolvedValue(TICKET);
  ticketServiceMock.createTicket.mockResolvedValue(TICKET);
  ticketServiceMock.updateTicketFields.mockResolvedValue(TICKET);
});

describe('B1 — dueBy', () => {
  test('POST: a trusted-intake client may set the agreed due date and the owner; both reach createTicket', async () => {
    await request(app()).post('/api/v1/tickets').send({ subject: 'Office check-in — Calgary', requesterEmail: 'continuit@bgc.ca', dueBy: '2026-09-26T17:00:00Z', assignedTechId: 56 }).expect(201);
    expect(ticketServiceMock.createTicket).toHaveBeenCalledWith(8, expect.objectContaining({ dueBy: '2026-09-26T17:00:00Z', assignedTechId: 56 }), expect.objectContaining({ trustedIntake: true }), expect.any(Object));
  });

  test('POST: dueBy from a non-trusted client is 403 due_by_requires_trusted_intake and nothing is created', async () => {
    apiKey = PLAIN;
    const res = await request(app()).post('/api/v1/tickets').send({ subject: 'x', requesterEmail: 'a@b.ca', dueBy: '2026-09-26T17:00:00Z' }).expect(403);
    expect(res.body.code).toBe('due_by_requires_trusted_intake');
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
  });

  test('POST without dueBy from a non-trusted client is unaffected', async () => {
    apiKey = PLAIN;
    await request(app()).post('/api/v1/tickets').send({ subject: 'plain', requesterEmail: 'a@b.ca' }).expect(201);
  });

  test('PATCH: dueBy reaches updateTicketFields (which stamps it manual); null clears it', async () => {
    await request(app()).patch('/api/v1/tickets/901').send({ dueBy: '2026-09-30T17:00:00Z' }).expect(200);
    expect(ticketServiceMock.updateTicketFields).toHaveBeenCalledWith(901, 8, { dueBy: '2026-09-30T17:00:00Z' }, expect.any(Object));
    await request(app()).patch('/api/v1/tickets/901').send({ dueBy: null }).expect(200);
    expect(ticketServiceMock.updateTicketFields).toHaveBeenLastCalledWith(901, 8, { dueBy: null }, expect.any(Object));
  });

  test('PATCH: dueBy from a non-trusted client is 403 before any write', async () => {
    apiKey = PLAIN;
    const res = await request(app()).patch('/api/v1/tickets/901').send({ dueBy: '2026-09-30T17:00:00Z', priority: 1 }).expect(403);
    expect(res.body.code).toBe('due_by_requires_trusted_intake');
    expect(ticketServiceMock.updateTicketFields).not.toHaveBeenCalled();
  });

  test('createTicket stores a caller date as MANUAL and lets it beat the SLA clock', () => {
    const src = readFileSync(new URL('../src/services/ticketService.js', import.meta.url), 'utf8');
    expect(src).toContain("dueBy: z.string().datetime({ offset: true }).optional().nullable(),\n  impact:");
    expect(src).toContain("...(data.dueBy\n          ? { dueBy: new Date(data.dueBy), dueBySetBy: 'manual' }\n          : (slaDueDates.dueBy ? { dueBy: slaDueDates.dueBy, dueBySetBy: 'sla' } : {})),");
  });
});

describe('C1 — GET /agents', () => {
  test('a membership lookup failure degrades to groups: [] instead of failing the call', async () => {
    technicianRepositoryMock.getAll.mockResolvedValue([{ id: 56, name: 'S', email: 's@bgc.ca', isActive: true, freshserviceId: null, location: null, photoUrl: null }]);
    prismaMock.groupMember.findMany.mockRejectedValue(new Error('relation missing'));
    const res = await request(app()).get('/api/v1/agents').expect(200);
    expect(res.body.data[0].groups).toEqual([]);
  });

  test('carries e-mail, active flag, FreshService id as a string, and the office; ?active=true narrows', async () => {
    technicianRepositoryMock.getAll.mockResolvedValue([
      { id: 56, name: 'Soheil Nasiri', email: 'snasiri@bgc.ca', isActive: true, freshserviceId: 1002090111n, location: 'Vancouver', photoUrl: null },
      { id: 57, name: 'Old Agent', email: 'old@bgc.ca', isActive: false, freshserviceId: null, location: null, photoUrl: null, origin: 'local' },
    ]);
    prismaMock.groupMember.findMany.mockResolvedValue([
      { technicianId: 56, group: { id: 12, name: 'IT Operations', origin: 'freshservice', freshserviceId: 1000210021n } },
      { technicianId: 56, group: { id: 3458, name: 'Field IT', origin: 'local', freshserviceId: null } },
    ]);
    const all = await request(app()).get('/api/v1/agents').expect(200);
    expect(all.body.data).toEqual([
      { id: 56, name: 'Soheil Nasiri', email: 'snasiri@bgc.ca', isActive: true, freshserviceId: '1002090111', location: 'Vancouver', photoUrl: null, origin: 'freshservice', groups: [{ id: 12, name: 'IT Operations', origin: 'freshservice', freshserviceId: '1000210021' }, { id: 3458, name: 'Field IT', origin: 'local', freshserviceId: null }] },
      { id: 57, name: 'Old Agent', email: 'old@bgc.ca', isActive: false, freshserviceId: null, location: null, photoUrl: null, origin: 'local', groups: [] },
    ]);
    const active = await request(app()).get('/api/v1/agents?active=true').expect(200);
    expect(active.body.data.map((a) => a.id)).toEqual([56]);
    const alias = await request(app()).get('/api/v1/agents?includeInactive=false').expect(200);
    expect(alias.body.data.map((a) => a.id)).toEqual([56]);
  });
});

describe('C3 / C4 — GET /contacts', () => {
  beforeEach(() => prismaMock.requester.findMany.mockResolvedValue([{ id: 3, name: 'Dana Richard', email: 'drichard@bgc.ca', phone: null, department: null, entraDepartment: 'Geo', jobTitle: null, entraJobTitle: 'Site Lead', entraOfficeLocation: 'Calgary', unattended: false }]));

  test('location filters on the Entra office, case-insensitively; e-mail is an exact lookup', async () => {
    const res = await request(app()).get('/api/v1/contacts?location=calgary&email=DRichard@bgc.ca&limit=1000').expect(200);
    const args = prismaMock.requester.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ workspaceId: 8, entraOfficeLocation: { contains: 'calgary', mode: 'insensitive' }, email: { equals: 'drichard@bgc.ca', mode: 'insensitive' } });
    expect(args.take).toBe(500); // capped
    expect(res.body.data[0]).toMatchObject({ email: 'drichard@bgc.ca', location: 'Calgary', department: 'Geo', jobTitle: 'Site Lead' });
  });

  test('no filters → the old behaviour (100 rows, name order)', async () => {
    await request(app()).get('/api/v1/contacts').expect(200);
    const args = prismaMock.requester.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ workspaceId: 8 });
    expect(args.take).toBe(100);
  });
});

describe('B4 — assignedTechEmail', () => {
  test('POST: the owner by e-mail is resolved to assignedTechId (case-insensitive, active only) and is not reported as ignored', async () => {
    prismaMock.technician.findFirst.mockResolvedValue({ id: 56 });
    const res = await request(app()).post('/api/v1/tickets').send({ subject: 'x', requesterEmail: 'continuit@bgc.ca', assignedTechEmail: 'SNasiri@bgc.ca' }).expect(201);
    expect(prismaMock.technician.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: 8, isActive: true, email: { equals: 'snasiri@bgc.ca', mode: 'insensitive' } } }));
    expect(ticketServiceMock.createTicket).toHaveBeenCalledWith(8, expect.objectContaining({ assignedTechId: 56 }), expect.any(Object), expect.any(Object));
    expect(res.body.meta?.ignoredFields || []).not.toContain('assignedTechEmail');
  });

  test('POST: an unknown e-mail is 400 unknown_agent_email and nothing is created', async () => {
    prismaMock.technician.findFirst.mockResolvedValue(null);
    const res = await request(app()).post('/api/v1/tickets').send({ subject: 'x', requesterEmail: 'continuit@bgc.ca', assignedTechEmail: 'nobody@bgc.ca' }).expect(400);
    expect(res.body.code).toBe('unknown_agent_email');
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
  });

  test('POST: assignedTechId wins when both are sent — no lookup', async () => {
    await request(app()).post('/api/v1/tickets').send({ subject: 'x', requesterEmail: 'continuit@bgc.ca', assignedTechId: 9, assignedTechEmail: 'other@bgc.ca' }).expect(201);
    expect(prismaMock.technician.findFirst).not.toHaveBeenCalled();
    expect(ticketServiceMock.createTicket).toHaveBeenCalledWith(8, expect.objectContaining({ assignedTechId: 9 }), expect.any(Object), expect.any(Object));
  });

  test('PATCH: reassign by e-mail reaches assignTicket with the resolved id; "" unassigns', async () => {
    prismaMock.technician.findFirst.mockResolvedValue({ id: 56 });
    await request(app()).patch('/api/v1/tickets/901').send({ assignedTechEmail: 'snasiri@bgc.ca' }).expect(200);
    expect(ticketServiceMock.assignTicket).toHaveBeenCalledWith(901, 8, 56, expect.any(Object));
    await request(app()).patch('/api/v1/tickets/901').send({ assignedTechEmail: '' }).expect(200);
    expect(ticketServiceMock.assignTicket).toHaveBeenLastCalledWith(901, 8, null, expect.any(Object));
  });
});

describe('B6 — GET /categories', () => {
  test('rows carry description + isActive; inactive rows only with ?includeInactive=true', async () => {
    prismaMock.competencyCategory.findMany.mockResolvedValue([{ id: 1, name: 'Hardware', parentId: null, description: 'Laptops, docks, peripherals', isActive: true }]);
    const res = await request(app()).get('/api/v1/categories').expect(200);
    expect(res.body.data[0]).toEqual({ id: 1, name: 'Hardware', parentId: null, description: 'Laptops, docks, peripherals', isActive: true });
    expect(prismaMock.competencyCategory.findMany.mock.calls[0][0].where).toEqual({ workspaceId: 8, isActive: true });
    await request(app()).get('/api/v1/categories?includeInactive=true').expect(200);
    expect(prismaMock.competencyCategory.findMany.mock.calls[1][0].where).toEqual({ workspaceId: 8 });
  });
});

describe('C2 — GET /tickets?ids=', () => {
  test('ids (numbers or TP-refs, comma-separated) become an integer list for the service', async () => {
    ticketServiceMock.listTickets.mockResolvedValue({ items: [], total: 0, pageSize: 25, nextCursor: null });
    await request(app()).get('/api/v1/tickets?ids=1601,TP-1602,junk,%201603').expect(200);
    expect(ticketServiceMock.listTickets).toHaveBeenCalledWith(8, expect.objectContaining({ ids: [1601, 1602, 1603] }));
  });
});
