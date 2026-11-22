import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * 22 Nov 2026 — the v1 API keeps a ticket's first message.
 *
 * 4.4.03 moved the original e-mail kept beside a thread entry into its own
 * table, and ticketService.getTicket maps every thread entry through
 * withoutOriginalBody (utils/inlineAnswers.js), which strips
 * rawPayload.fullBodyHtml / fullBodyText. Integrations read the opening
 * message as the `original_email` entry of GET /api/v1/tickets/:id/conversations;
 * it must still be there, with its body text, after that mapping.
 *
 * The REAL ticketService.getTicket runs here over mocked Prisma rows (harness
 * from ticketPinnedCards.test.js), behind the REAL /api/v1 router (key auth
 * stubbed, as in apiV1ReadNoReconcile.test.js). Without the mapping, the
 * "getTicket's thread carries no full body" assertions fail.
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  competencyCategory: { findFirst: jest.fn(), findMany: jest.fn() },
  group: { findFirst: jest.fn(), findMany: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  requester: { findUnique: jest.fn() },
  ticketThreadEntry: { create: jest.fn() },
  ticketActivity: { findMany: jest.fn() },
  ticketApproval: { findMany: jest.fn() },
  ticketAttachment: { findMany: jest.fn() },
  ticketPinnedCard: { findMany: jest.fn() },
  ticketTypeDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  ticketStatusDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 5, name: 'Open', baseStatus: 'Open', color: 'blue', sortOrder: 0, isSystem: true, isActive: true },
      { id: 2, workspaceId: 5, name: 'Closed', baseStatus: 'Closed', color: 'slate', sortOrder: 1, isSystem: true, isActive: true },
    ]),
  },
  apiRequestLog: { create: jest.fn(async () => ({})) },
  $queryRaw: jest.fn(),
};
const ticketThreadRepositoryMock = { listForTicket: jest.fn() };
let apiKey;

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: { evaluate: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: ticketThreadRepositoryMock }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketEvent: jest.fn(), emitTicketLifecycleNotifications: jest.fn() },
}));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: { findByEmail: jest.fn(), createNative: jest.fn() } }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: { sendEmail: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: { runPipeline: jest.fn() } }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { getUserProfile: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: {
    enqueueTicketCreate: jest.fn(), enqueueFieldSync: jest.fn(), enqueueThreadEntry: jest.fn(),
    reconcileTicket: jest.fn(), getClient: jest.fn(), getInteractiveClient: jest.fn(),
  },
}));
jest.unstable_mockModule('../src/services/ticketMergeService.js', () => ({ default: { mergedInto: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/ticketLinkService.js', () => ({
  default: { relationsSummary: jest.fn().mockResolvedValue({ mergedInto: null, parent: null, childCount: 0 }) },
}));
// /api/v1: key auth stubbed (its own tests pin it).
jest.unstable_mockModule('../src/middleware/apiKeyAuth.js', () => ({
  requireApiKey: () => (req, _res, next) => { req.workspaceId = 5; req.apiKey = apiKey; next(); },
  apiRequestContext: (_req, _res, next) => next(),
  clientIp: () => '127.0.0.1',
}));
jest.unstable_mockModule('../src/services/oauthClientService.js', () => ({ verifyClientCredentials: jest.fn(), issueAccessToken: jest.fn() }));
jest.unstable_mockModule('../src/services/apiRateLimitService.js', () => ({ default: { hit: jest.fn().mockResolvedValue({ allowed: true, reset: 0 }) } }));
jest.unstable_mockModule('../src/middleware/apiIdempotency.js', () => ({ withIdempotency: (_req, _res, next) => next() }));

const { default: ticketService } = await import('../src/services/ticketService.js');
const { default: apiV1Routes } = await import('../src/routes/apiV1.routes.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', apiV1Routes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ success: false, message: err.message, code: err.code }));
  return app;
}

const OPENING_TEXT = 'Hello, my laptop will not start since this morning. Can someone help?';
const REPLY_FULL_HTML = '<html><body><p>It still does not start.</p><blockquote>Thanks Eli, I am on it.</blockquote></body></html>';

const TICKET_ROW = {
  id: 901, workspaceId: 5, origin: 'ticketpulse', status: 'Open', nativeNumber: 1042, freshserviceTicketId: null,
  subject: 'Laptop will not start', priority: 2, ticketType: 'Incident',
  requester: { id: 40, name: 'Eli Park', email: 'eli.park@example.com', unattended: false },
  tagLinks: [], pipelineRuns: [], assignmentEpisodes: [],
  createdAt: new Date('2026-11-20T17:00:00.000Z'), updatedAt: new Date('2026-11-20T18:00:00.000Z'),
  lastRealActivityAt: null, freshserviceUpdatedAt: null,
};

const entry = (over) => ({
  ticketId: 901, workspaceId: 5, actorFreshserviceId: null, actorEmail: null, incoming: false, isPrivate: false,
  visibility: 'public', source: 'email_inbound', rawPayload: null, bodyHtml: null, ...over,
});
// As stored: the opening e-mail with its text, an agent reply, and a requester
// reply whose raw_payload still carries the full original body (a row written
// before the 21 Nov move), and a private note.
const STORED_THREAD = [
  entry({ id: 1, eventType: 'original_email', actorName: 'Eli Park', actorEmail: 'eli.park@example.com', authorType: 'requester', incoming: true, bodyText: OPENING_TEXT, content: OPENING_TEXT, bodyHtml: `<p>${OPENING_TEXT}</p>`, occurredAt: new Date('2026-11-20T17:00:00.000Z') }),
  entry({ id: 2, eventType: 'reply', actorName: 'Dana Fox', authorType: 'agent', source: 'ticketpulse', bodyText: 'Thanks Eli, I am on it.', content: 'Thanks Eli, I am on it.', occurredAt: new Date('2026-11-20T17:20:00.000Z') }),
  entry({ id: 3, eventType: 'reply', actorName: 'Eli Park', actorEmail: 'eli.park@example.com', authorType: 'requester', incoming: true, bodyText: 'It still does not start.', content: 'It still does not start.', occurredAt: new Date('2026-11-20T18:00:00.000Z'), rawPayload: { fullBodyHtml: REPLY_FULL_HTML, fullBodyText: 'It still does not start.\n> Thanks Eli, I am on it.', cc: [] } }),
  entry({ id: 4, eventType: 'note', actorName: 'Dana Fox', authorType: 'agent', source: 'ticketpulse', isPrivate: true, visibility: 'private', bodyText: 'Probably the battery.', content: 'Probably the battery.', occurredAt: new Date('2026-11-20T18:05:00.000Z') }),
];

const KEY = { name: 'Example integration', keyPrefix: 'tp_live_x', mode: 'live', scopes: ['*'], oauthClientId: null };

beforeEach(() => {
  jest.clearAllMocks();
  apiKey = KEY;
  prismaMock.ticket.findFirst.mockResolvedValue({ ...TICKET_ROW });
  ticketThreadRepositoryMock.listForTicket.mockImplementation(async () => STORED_THREAD.map((e) => ({ ...e, rawPayload: e.rawPayload ? { ...e.rawPayload } : null })));
  prismaMock.ticketActivity.findMany.mockResolvedValue([]);
  prismaMock.ticketApproval.findMany.mockResolvedValue([]);
  prismaMock.ticketAttachment.findMany.mockResolvedValue([]);
  prismaMock.ticketPinnedCard.findMany.mockResolvedValue([]);
  prismaMock.technician.findMany.mockResolvedValue([]);
  prismaMock.$queryRaw.mockResolvedValue([]);
  prismaMock.workspace.findUnique.mockResolvedValue({ internalDomains: [] });
});

describe('the real getTicket thread mapping', () => {
  test('keeps the original_email entry with its text', async () => {
    const ticket = await ticketService.getTicket(901, 5, { reconcile: false });
    const opening = ticket.thread.find((e) => e.eventType === 'original_email');
    expect(opening).toMatchObject({ id: 1, bodyText: OPENING_TEXT, isPrivate: false });
  });

  test('ships no full original body: the reply carries only hasOriginalEmail', async () => {
    const ticket = await ticketService.getTicket(901, 5, { reconcile: false });
    const reply = ticket.thread.find((e) => e.id === 3);
    expect(reply.rawPayload).toEqual({ cc: [], hasOriginalEmail: true });
    expect(JSON.stringify(ticket.thread)).not.toContain('fullBodyHtml');
    expect(JSON.stringify(ticket.thread)).not.toContain('<blockquote>');
  });
});

describe('GET /api/v1/tickets/:id/conversations over the real getTicket', () => {
  test('the original_email entry comes first, with its body text', async () => {
    const res = await request(buildApp()).get('/api/v1/tickets/901/conversations').expect(200);
    expect(res.body.data[0]).toMatchObject({ id: 1, type: 'original_email', author: 'Eli Park', authorType: 'requester', isPrivate: false, body: OPENING_TEXT });
    expect(res.body.data.map((e) => e.type)).toEqual(['original_email', 'reply', 'reply', 'note']);
  });

  test('an opening message with only `content` (older rows) is still listed', async () => {
    ticketThreadRepositoryMock.listForTicket.mockResolvedValue([{ ...STORED_THREAD[0], bodyText: null }, STORED_THREAD[1]]);
    const res = await request(buildApp()).get('/api/v1/tickets/901/conversations').expect(200);
    expect(res.body.data[0]).toMatchObject({ type: 'original_email', body: OPENING_TEXT });
  });

  test('a credential with private notes off still gets the opening message', async () => {
    apiKey = { ...KEY, readPrivateNotes: false };
    const res = await request(buildApp()).get('/api/v1/tickets/901/conversations').expect(200);
    expect(res.body.data.map((e) => e.type)).toEqual(['original_email', 'reply', 'reply']);
    expect(res.body.data[0].body).toBe(OPENING_TEXT);
  });

  test('GET /api/v1/tickets/:id lists it in `conversations` too', async () => {
    const res = await request(buildApp()).get('/api/v1/tickets/901').expect(200);
    expect(res.body.data.conversations[0]).toMatchObject({ type: 'original_email', body: OPENING_TEXT });
  });
});
