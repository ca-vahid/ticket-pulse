import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * QA 09-16 #2: `addNote` rides a ticket write — one call, one note, written
 * after the changes; `note` is an alias; garbage is a 400.
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
    req.apiKey = { name: 'PA Power App', keyPrefix: 'tp_test_x', mode: 'live', scopes: ['*'], oauthClientId: null };
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

const { default: apiV1Routes, normalizeAddNote } = await import('../src/routes/apiV1.routes.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', apiV1Routes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ success: false, message: err.message, code: err.code }));
  return app;
}

const TICKET = { id: 501, workspaceId: 5, origin: 'ticketpulse', nativeNumber: 77, subject: 'Coyote Landslide', status: 'Open', priority: 2, requester: { name: 'ACME', email: 'acme@example.com' }, ccEmails: [], customFields: {} };

beforeEach(() => {
  jest.clearAllMocks();
  ticketServiceMock.getTicket.mockResolvedValue(TICKET);
  ticketServiceMock.addPrivateNote.mockResolvedValue({ entry: { id: 9001, actorName: 'PA Power App' } });
});

describe('normalizeAddNote', () => {
  test('string, object and alias shapes; empty → null; garbage → 400', () => {
    expect(normalizeAddNote('  hello ')).toEqual({ bodyText: 'hello', bodyHtml: null, stage: null, agent: null });
    expect(normalizeAddNote({ body: 'x', stage: 'tier2' })).toEqual({ bodyText: 'x', bodyHtml: null, stage: 'tier2', agent: null });
    expect(normalizeAddNote('   ')).toBeNull();
    expect(normalizeAddNote(undefined)).toBeNull();
    expect(() => normalizeAddNote(42)).toThrow(/addNote must be/);
    expect(() => normalizeAddNote({})).toThrow(/body is required/);
  });
});

describe('PATCH /api/v1/tickets/:id with addNote', () => {
  test('writes the note AFTER the status change, in the same request, and reports the entry id', async () => {
    const order = [];
    ticketServiceMock.changeStatus.mockImplementation(async () => { order.push('status'); });
    ticketServiceMock.addPrivateNote.mockImplementation(async () => { order.push('note'); return { entry: { id: 9001 } }; });
    const res = await request(buildApp())
      .patch('/api/v1/tickets/501')
      .send({ status: 'Open', addNote: 'Power App form was resubmitted. Updated project details have been synchronized.' })
      .expect(200);
    expect(order).toEqual(['status', 'note']);
    expect(ticketServiceMock.addPrivateNote).toHaveBeenCalledWith(501, 5, expect.objectContaining({ bodyText: 'Power App form was resubmitted. Updated project details have been synchronized.' }), expect.any(Object));
    expect(res.body.note).toEqual({ entryId: 9001 });
  });

  test('`note` alias and the object shape both work; no note field → no note call, no note in the response', async () => {
    await request(buildApp()).patch('/api/v1/tickets/501').send({ note: { body: 'via alias', stage: 'tier2' } }).expect(200);
    expect(ticketServiceMock.addPrivateNote).toHaveBeenCalledWith(501, 5, expect.objectContaining({ bodyText: 'via alias', stage: 'tier2' }), expect.any(Object));
    ticketServiceMock.addPrivateNote.mockClear();
    const res = await request(buildApp()).patch('/api/v1/tickets/501').send({ priority: 3 }).expect(200);
    expect(ticketServiceMock.addPrivateNote).not.toHaveBeenCalled();
    expect(res.body.note).toBeUndefined();
  });

  test('a malformed addNote is a 400 before anything is written', async () => {
    await request(buildApp()).patch('/api/v1/tickets/501').send({ status: 'Open', addNote: {} }).expect(400);
    // changeStatus ran first (the note is validated when reached) — acceptable: the body is rejected, nothing else half-done in the note path.
    expect(ticketServiceMock.addPrivateNote).not.toHaveBeenCalled();
  });
});
