import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Composer drafts on the server + composer writing help (12 Nov 2026), through
 * the real tickets router.
 *  - a draft belongs to the signed-in person (never the body) and one ticket
 *  - a row from another workspace is not shown
 *  - compose-assist hands only the text, the subject and a first name on
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn() },
  userPreference: { findUnique: jest.fn(), upsert: jest.fn() },
  ticketDraft: { findUnique: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
  // Router-level collaborators (unused by these tests but imported transitively).
  ticket: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  competencyCategory: { findFirst: jest.fn(), findMany: jest.fn() },
  group: { findFirst: jest.fn(), findMany: jest.fn() },
  requester: { findUnique: jest.fn() },
  ticketTypeDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  ticketStatusDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  slaPolicy: { findFirst: jest.fn() },
  workspaceAccess: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  $queryRaw: jest.fn(),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: { evaluate: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { listForTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketEvent: jest.fn(), emitTicketLifecycleNotifications: jest.fn() },
}));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: { findByEmail: jest.fn(), createNative: jest.fn() } }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: { sendEmail: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({
  default: {},
  sseManager: { broadcast: jest.fn() },
}));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({
  default: { runPipeline: jest.fn() },
}));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({
  default: { getUserProfile: jest.fn().mockResolvedValue(null) },
}));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: {
    enqueueTicketCreate: jest.fn(), enqueueFieldSync: jest.fn(), enqueueThreadEntry: jest.fn(),
    reconcileTicket: jest.fn(), getClient: jest.fn(), getInteractiveClient: jest.fn(),
  },
}));
jest.unstable_mockModule('../src/services/ticketMergeService.js', () => ({
  default: { mergedInto: jest.fn().mockResolvedValue(null) },
}));
jest.unstable_mockModule('../src/services/scheduledTicketService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/middleware/workspace.js', () => ({
  requireWorkspace: (req, _res, next) => { req.workspaceId = 7; next(); },
}));

const assistMock = { assist: jest.fn() };
jest.unstable_mockModule('../src/services/composerAssistService.js', () => ({ default: assistMock }));

const { default: ticketsRouter } = await import('../src/routes/tickets.routes.js');

function buildApp(sessionUser = { email: 'Ada@X.io', name: 'Ada Admin', role: 'admin' }) {
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use((req, _res, next) => { req.session = { user: sessionUser }; next(); });
  app.use('/api/tickets', ticketsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  });
  return app;
}

const OWNER = { ticketId_ownerEmail: { ticketId: 42, ownerEmail: 'ada@x.io' } };

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.ticket.findFirst.mockResolvedValue({ id: 42, subject: 'Laptop will not wake', requester: { name: 'Priya Raman' } });
  prismaMock.ticketDraft.findUnique.mockResolvedValue(null);
  prismaMock.ticketDraft.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.ticketDraft.upsert.mockImplementation(({ create }) => Promise.resolve({ ...create, id: 1, updatedAt: new Date('2026-11-12T20:00:00Z') }));
});

describe('composer drafts on the server', () => {
  test('no draft → data null (200, so an old page can tell it from a missing route)', async () => {
    const res = await request(buildApp()).get('/api/tickets/42/draft').expect(200);
    expect(res.body).toEqual({ success: true, data: null });
    expect(prismaMock.ticketDraft.findUnique).toHaveBeenCalledWith({ where: OWNER });
  });

  test('the owner gets their draft back; a row from another workspace is not shown', async () => {
    prismaMock.ticketDraft.findUnique.mockResolvedValue({ workspaceId: 7, mode: 'note', bodyHtml: '<p>hi</p>', cc: ['b@x.io'], updatedAt: new Date('2026-11-12T20:00:00Z') });
    const res = await request(buildApp()).get('/api/tickets/42/draft').expect(200);
    expect(res.body.data).toEqual({ mode: 'note', body: '<p>hi</p>', cc: ['b@x.io'], updatedAt: '2026-11-12T20:00:00.000Z' });
    prismaMock.ticketDraft.findUnique.mockResolvedValue({ workspaceId: 8, mode: 'note', bodyHtml: '<p>hi</p>', cc: null, updatedAt: new Date() });
    const other = await request(buildApp()).get('/api/tickets/42/draft').expect(200);
    expect(other.body.data).toBeNull();
  });

  test('saving: owner from the session, workspace from the scope, an owner in the body is ignored', async () => {
    const res = await request(buildApp()).put('/api/tickets/42/draft')
      .send({ mode: 'reply', body: '<p>Hello Priya</p>', cc: ['b@x.io', 7, 'c@x.io'], ownerEmail: 'someone@else.io', workspaceId: 99 }).expect(200);
    expect(prismaMock.ticket.findFirst).toHaveBeenCalledWith({ where: { id: 42, workspaceId: 7 }, select: { id: true } });
    const call = prismaMock.ticketDraft.upsert.mock.calls[0][0];
    expect(call.where).toEqual(OWNER);
    expect(call.create).toEqual({ workspaceId: 7, ticketId: 42, ownerEmail: 'ada@x.io', mode: 'reply', bodyHtml: '<p>Hello Priya</p>', cc: ['b@x.io', 'c@x.io'] });
    expect(res.body.data.body).toBe('<p>Hello Priya</p>');
  });

  test('refused: empty, too large, a ticket outside the workspace', async () => {
    await request(buildApp()).put('/api/tickets/42/draft').send({ mode: 'reply', body: '   ' }).expect(400);
    await request(buildApp()).put('/api/tickets/42/draft').send({ mode: 'reply', body: 'x'.repeat(300 * 1024 + 1) }).expect(400);
    prismaMock.ticket.findFirst.mockResolvedValue(null);
    await request(buildApp()).put('/api/tickets/42/draft').send({ mode: 'reply', body: '<p>x</p>' }).expect(404);
    expect(prismaMock.ticketDraft.upsert).not.toHaveBeenCalled();
  });

  test('clearing removes only this person\'s row for this ticket in this workspace', async () => {
    await request(buildApp()).delete('/api/tickets/42/draft').expect(200);
    expect(prismaMock.ticketDraft.deleteMany).toHaveBeenCalledWith({ where: { ticketId: 42, ownerEmail: 'ada@x.io', workspaceId: 7 } });
  });
});

describe('POST /api/tickets/:id/compose-assist', () => {
  test('hands on the text, the subject and the requester name; the actor comes from the session', async () => {
    assistMock.assist.mockResolvedValue({ text: 'Better.', action: 'improve' });
    const res = await request(buildApp()).post('/api/tickets/42/compose-assist').send({ action: 'improve', text: 'beter', actorEmail: 'x@y.z' }).expect(200);
    expect(res.body.data.text).toBe('Better.');
    expect(assistMock.assist).toHaveBeenCalledWith({ workspaceId: 7, actorEmail: 'ada@x.io', action: 'improve', text: 'beter', subject: 'Laptop will not wake', firstName: 'Priya Raman' });
  });

  test('a ticket outside the workspace → 404, the AI is never called', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(null);
    await request(buildApp()).post('/api/tickets/42/compose-assist').send({ action: 'improve', text: 'beter' }).expect(404);
    expect(assistMock.assist).not.toHaveBeenCalled();
  });
});
