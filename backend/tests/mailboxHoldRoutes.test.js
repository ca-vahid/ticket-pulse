import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Phase RL (RL-4 / RL-7) — the hold-queue routes against the real tickets
 * router: staff gate (admin + agent yes, viewer no), list/attach/create/
 * discard delegate to mailboxHoldService, PATCH /mailboxes/:id accepts the
 * new policy fields, GET /mailboxes carries the Graph send-lane state, and
 * the Test endpoint passes the mailbox mode through for capability checks.
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  workspaceAccess: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  mailboxConnection: { findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  $queryRaw: jest.fn(),
};
const holdMock = {
  list: jest.fn(), count: jest.fn(), attach: jest.fn(), createTicket: jest.fn(), discard: jest.fn(),
};
const emailHealthMock = { getGraphSendLane: jest.fn() };
const graphMock = { isConfigured: jest.fn(() => true), testConnection: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/mailboxHoldService.js', () => ({
  default: holdMock, NEW_TICKET_POLICIES: ['create', 'replies_only', 'hold_unmatched'],
}));
jest.unstable_mockModule('../src/services/emailHealthService.js', () => ({ default: emailHealthMock }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: graphMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: { evaluate: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { listForTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketEvent: jest.fn(), emitTicketLifecycleNotifications: jest.fn() },
}));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: { findByEmail: jest.fn(), createNative: jest.fn() } }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: { sendEmail: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: { runPipeline: jest.fn() } }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { getUserProfile: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: { enqueueTicketCreate: jest.fn(), enqueueFieldSync: jest.fn(), enqueueThreadEntry: jest.fn(), getClient: jest.fn(), getInteractiveClient: jest.fn() },
}));
jest.unstable_mockModule('../src/services/ticketMergeService.js', () => ({ default: { mergedInto: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/scheduledTicketService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/middleware/workspace.js', () => ({
  requireWorkspace: (req, _res, next) => { req.workspaceId = 7; next(); },
}));

const { default: ticketsRouter } = await import('../src/routes/tickets.routes.js');

const AGENT = { email: 'ari@example.com', name: 'Ari Agent', role: 'agent' };
const ADMIN = { email: 'root@example.com', name: 'Root', role: 'admin' };
const VIEWER = { email: 'viewer@example.com', name: 'Viewer', role: 'user' };

function buildApp(sessionUser) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: sessionUser }; next(); });
  app.use('/api/tickets', ticketsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, message: err.message, code: err.code });
  });
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.workspaceAccess.findUnique.mockResolvedValue(null);
  prismaMock.workspaceAccess.findFirst.mockResolvedValue(null);
  prismaMock.workspace.findUnique.mockResolvedValue({ id: 7, nativeTicketingEnabled: true, defaultTimezone: 'America/Los_Angeles', internalDomains: [] });
  holdMock.list.mockResolvedValue([{ id: 501, reason: 'unknown_reference', status: 'held' }]);
  holdMock.count.mockResolvedValue(1);
  emailHealthMock.getGraphSendLane.mockResolvedValue(null);
});

function asAgent() {
  prismaMock.technician.findFirst.mockResolvedValue({ id: 3, name: 'Ari Agent' });
  return buildApp(AGENT);
}
function asViewer() {
  prismaMock.workspaceAccess.findUnique.mockResolvedValue({ role: 'viewer' });
  prismaMock.workspaceAccess.findFirst.mockResolvedValue({ role: 'viewer' });
  return buildApp(VIEWER);
}

describe('GET /api/tickets/mailboxes/held', () => {
  test('agents (technician profile) and admins can list; the response carries heldCount', async () => {
    const res = await request(asAgent()).get('/api/tickets/mailboxes/held?status=held').expect(200);
    expect(res.body).toEqual({ success: true, data: [{ id: 501, reason: 'unknown_reference', status: 'held' }], meta: { heldCount: 1 } });
    expect(holdMock.list).toHaveBeenCalledWith(7, { status: 'held' });

    await request(buildApp(ADMIN)).get('/api/tickets/mailboxes/held').expect(200);
  });

  test('a workspace viewer (no technician profile, non-admin) is refused', async () => {
    const res = await request(asViewer()).get('/api/tickets/mailboxes/held').expect(401);
    expect(res.body.message).toMatch(/Agent or admin access required/);
    expect(holdMock.list).not.toHaveBeenCalled();
  });

  test('non-held statuses still report the live held count', async () => {
    holdMock.list.mockResolvedValue([]);
    holdMock.count.mockResolvedValue(4);
    const res = await request(asAgent()).get('/api/tickets/mailboxes/held?status=discarded').expect(200);
    expect(res.body.meta).toEqual({ heldCount: 4 });
    expect(holdMock.count).toHaveBeenCalledWith(7, 'held');
  });
});

describe('POST /api/tickets/mailboxes/held/:id/{attach,create,discard}', () => {
  test('attach requires a ticketId and forwards the actor + workspace scope', async () => {
    await request(asAgent()).post('/api/tickets/mailboxes/held/501/attach').send({}).expect(400);
    holdMock.attach.mockResolvedValue({ held: { id: 501, status: 'attached' }, ticket: { id: 42, displayRef: 'TP-1204' } });
    const res = await request(asAgent()).post('/api/tickets/mailboxes/held/501/attach').send({ ticketId: 42 }).expect(200);
    expect(res.body.data.ticket).toEqual({ id: 42, displayRef: 'TP-1204' });
    expect(holdMock.attach).toHaveBeenCalledWith(501, 42, expect.objectContaining({ email: 'ari@example.com', technicianId: 3 }), { workspaceId: 7 });
  });

  test('create passes the optional requesterEmail; 201 with the ticket', async () => {
    holdMock.createTicket.mockResolvedValue({ held: { id: 501, status: 'created' }, ticket: { id: 700, displayRef: 'TP-1300' } });
    const res = await request(buildApp(ADMIN)).post('/api/tickets/mailboxes/held/501/create').send({ requesterEmail: 'alvina@vendor.example' }).expect(201);
    expect(res.body.data.ticket.displayRef).toBe('TP-1300');
    expect(holdMock.createTicket).toHaveBeenCalledWith(501, expect.objectContaining({ requesterEmail: 'alvina@vendor.example', workspaceId: 7 }));
  });

  test('discard resolves the row; service validation errors surface as 400', async () => {
    holdMock.discard.mockResolvedValue({ id: 501, status: 'discarded' });
    const ok = await request(asAgent()).post('/api/tickets/mailboxes/held/501/discard').expect(200);
    expect(ok.body.data.status).toBe('discarded');
    const { ValidationError } = await import('../src/utils/errors.js');
    holdMock.discard.mockRejectedValue(new ValidationError('This message was already attached'));
    const bad = await request(asAgent()).post('/api/tickets/mailboxes/held/501/discard').expect(400);
    expect(bad.body.message).toMatch(/already attached/);
  });

  test('viewers cannot mutate the queue', async () => {
    await request(asViewer()).post('/api/tickets/mailboxes/held/501/discard').expect(401);
    expect(holdMock.discard).not.toHaveBeenCalled();
  });
});

describe('mailbox connection routes (RL-2 / RL-4 / RL-7)', () => {
  test('PATCH /mailboxes/:id accepts newTicketPolicy + agentCcIntake and rejects an unknown policy', async () => {
    prismaMock.mailboxConnection.findFirst.mockResolvedValue({ id: 11, workspaceId: 7, mode: 'both' });
    prismaMock.mailboxConnection.update.mockImplementation(({ data }) => Promise.resolve({ id: 11, workspaceId: 7, mode: 'both', isEnabled: true, ...data }));

    const res = await request(buildApp(ADMIN)).patch('/api/tickets/mailboxes/11').send({ newTicketPolicy: 'replies_only', agentCcIntake: false }).expect(200);
    expect(prismaMock.mailboxConnection.update).toHaveBeenCalledWith({ where: { id: 11 }, data: { newTicketPolicy: 'replies_only', agentCcIntake: false } });
    expect(res.body.data).toMatchObject({ newTicketPolicy: 'replies_only', agentCcIntake: false });

    const bad = await request(buildApp(ADMIN)).patch('/api/tickets/mailboxes/11').send({ newTicketPolicy: 'yolo' }).expect(400);
    expect(bad.body.message).toMatch(/newTicketPolicy must be one of create, replies_only, hold_unmatched/);
  });

  test('GET /mailboxes carries the Graph send-lane state in meta', async () => {
    prismaMock.mailboxConnection.findMany.mockResolvedValue([{ id: 11, workspaceId: 7, address: 'patickets@bgcengineering.ca', mode: 'both', isEnabled: true, clientState: 'secret', deltaLink: 'x' }]);
    emailHealthMock.getGraphSendLane.mockResolvedValue({ status: 'not_granted', errorClass: 'permission_denied', permissionGrantText: 'Grant Mail.ReadWrite (application) to Ticket Pulse Backend …' });
    const res = await request(buildApp(ADMIN)).get('/api/tickets/mailboxes').expect(200);
    expect(res.body.meta.sendLane.status).toBe('not_granted');
    expect(res.body.data[0]).not.toHaveProperty('clientState');
    expect(emailHealthMock.getGraphSendLane).toHaveBeenCalledWith(7);
  });

  test('POST /mailboxes/:id/test passes the mailbox mode so the check proves SEND capability', async () => {
    prismaMock.mailboxConnection.findFirst.mockResolvedValue({ id: 11, workspaceId: 7, address: 'patickets@bgcengineering.ca', mode: 'both' });
    graphMock.testConnection.mockResolvedValue({ success: false, message: 'cannot SEND', canRead: true, canSend: false, canThread: false, roles: ['Mail.Read'] });
    const res = await request(buildApp(ADMIN)).post('/api/tickets/mailboxes/11/test').expect(200);
    expect(graphMock.testConnection).toHaveBeenCalledWith('patickets@bgcengineering.ca', { mode: 'both' });
    expect(res.body.data).toMatchObject({ canRead: true, canSend: false, canThread: false, roles: ['Mail.Read'] });
  });
});
