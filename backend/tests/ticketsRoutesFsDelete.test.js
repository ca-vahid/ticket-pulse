import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * POST /api/tickets/:id/fs-delete (2 Oct 2026): "Delete in FreshService" for
 * FS-born tickets. Reviewer/admin only (same people as the TP delete); NOT
 * behind the native-ticketing flag; readonly and plain members get 403.
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  workspaceAccess: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  $queryRaw: jest.fn(),
};
const ticketServiceMock = { deleteFsTicketInFreshService: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
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
const { blockReadonlyWrites } = await import('../src/middleware/auth.js');
const { ValidationError } = await import('../src/utils/errors.js');

function buildApp(sessionUser, { withReadonlyGate = false } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: sessionUser }; next(); });
  if (withReadonlyGate) {
    app.use('/api', (req, _res, next) => { req.headers['x-workspace-id'] = '7'; next(); }, blockReadonlyWrites);
  }
  app.use('/api/tickets', ticketsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, message: err.message, code: err.code });
  });
  return app;
}

function memberRole(role) {
  prismaMock.workspaceAccess.findUnique.mockResolvedValue({ role });
  prismaMock.workspaceAccess.findFirst.mockResolvedValue({ role });
}

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.technician.findFirst.mockResolvedValue(null);
  // Native ticketing OFF: the route must still work (FS-born tickets exist everywhere).
  prismaMock.workspace.findUnique.mockResolvedValue({ id: 7, nativeTicketingEnabled: false });
  prismaMock.workspaceAccess.findUnique.mockResolvedValue(null);
  prismaMock.workspaceAccess.findFirst.mockResolvedValue(null);
  ticketServiceMock.deleteFsTicketInFreshService.mockResolvedValue({ id: 42, status: 'Deleted', deleted: true });
});

describe('POST /api/tickets/:id/fs-delete', () => {
  test('a global admin deletes it — works with native ticketing off', async () => {
    const res = await request(buildApp({ email: 'ada@example.com', name: 'Ada Admin', role: 'admin' }))
      .post('/api/tickets/42/fs-delete').expect(200);
    expect(res.body.data.status).toBe('Deleted');
    expect(ticketServiceMock.deleteFsTicketInFreshService).toHaveBeenCalledWith(42, 7, expect.objectContaining({ email: 'ada@example.com', kind: 'admin' }));
  });

  test('a workspace reviewer may delete', async () => {
    memberRole('reviewer');
    await request(buildApp({ email: 'rae@example.com', name: 'Rae', role: 'viewer' }))
      .post('/api/tickets/42/fs-delete').expect(200);
    expect(ticketServiceMock.deleteFsTicketInFreshService).toHaveBeenCalled();
  });

  test('a plain member is refused with 403 and nothing is called', async () => {
    memberRole('viewer');
    const res = await request(buildApp({ email: 'vic@example.com', name: 'Vic', role: 'viewer' }))
      .post('/api/tickets/42/fs-delete').expect(403);
    expect(res.body.message).toMatch(/reviewer or admin/);
    expect(ticketServiceMock.deleteFsTicketInFreshService).not.toHaveBeenCalled();
  });

  test('an agent (technician only, no membership) is refused with 403', async () => {
    prismaMock.technician.findFirst.mockResolvedValue({ id: 9, name: 'Andy Agent' });
    await request(buildApp({ email: 'andy@example.com', name: 'Andy', role: 'agent' }))
      .post('/api/tickets/42/fs-delete').expect(403);
    expect(ticketServiceMock.deleteFsTicketInFreshService).not.toHaveBeenCalled();
  });

  test('a readonly member is refused with 403 (never 401) — by the app-wide gate and by the route', async () => {
    memberRole('readonly');
    const user = { email: 'olly@example.com', name: 'Olly Observer', role: 'viewer' };
    const gated = await request(buildApp(user, { withReadonlyGate: true })).post('/api/tickets/42/fs-delete');
    expect(gated.status).toBe(403);
    const direct = await request(buildApp(user)).post('/api/tickets/42/fs-delete');
    expect(direct.status).toBe(403);
    expect(ticketServiceMock.deleteFsTicketInFreshService).not.toHaveBeenCalled();
  });

  test('a service refusal (TP-born ticket) surfaces as 400 with its message', async () => {
    ticketServiceMock.deleteFsTicketInFreshService.mockRejectedValue(new ValidationError('This is a Ticket Pulse ticket — use "Delete ticket" instead; it removes the FreshService copy too.'));
    const res = await request(buildApp({ email: 'ada@example.com', name: 'Ada Admin', role: 'admin' }))
      .post('/api/tickets/42/fs-delete').expect(400);
    expect(res.body.message).toMatch(/Delete ticket/);
  });

  test('an invalid id is a 400', async () => {
    await request(buildApp({ email: 'ada@example.com', name: 'Ada Admin', role: 'admin' }))
      .post('/api/tickets/abc/fs-delete').expect(400);
    expect(ticketServiceMock.deleteFsTicketInFreshService).not.toHaveBeenCalled();
  });
});

describe('POST /api/tickets/bulk-delete', () => {
  const admin = { email: 'ada@example.com', name: 'Ada Admin', role: 'admin' };
  beforeEach(() => {
    ticketServiceMock.bulkDeleteTickets = jest.fn().mockResolvedValue([
      { id: 1, ref: 'TP-10', origin: 'ticketpulse', ok: true },
      { id: 2, ref: '#2002', origin: 'freshservice', ok: false, error: 'FreshService refused the delete — locked.' },
    ]);
  });

  test('admin: passes the de-duplicated ids in order and returns per-ticket results + counts', async () => {
    const res = await request(buildApp(admin)).post('/api/tickets/bulk-delete').send({ ids: [1, '2', 1, 'x', -3] }).expect(200);
    expect(ticketServiceMock.bulkDeleteTickets).toHaveBeenCalledWith([1, 2], 7, expect.objectContaining({ email: 'ada@example.com' }));
    expect(res.body.data).toEqual({
      deleted: 1,
      failed: 1,
      results: [
        { id: 1, ref: 'TP-10', origin: 'ticketpulse', ok: true },
        { id: 2, ref: '#2002', origin: 'freshservice', ok: false, error: 'FreshService refused the delete — locked.' },
      ],
    });
  });

  test('more than 25 ids is refused with a clear message', async () => {
    const ids = Array.from({ length: 26 }, (_, i) => i + 1);
    const res = await request(buildApp(admin)).post('/api/tickets/bulk-delete').send({ ids }).expect(400);
    expect(res.body.message).toMatch(/up to 25 tickets/);
    expect(ticketServiceMock.bulkDeleteTickets).not.toHaveBeenCalled();
  });

  test('an empty list is a 400', async () => {
    await request(buildApp(admin)).post('/api/tickets/bulk-delete').send({ ids: [] }).expect(400);
  });

  test('plain members and readonly get 403', async () => {
    memberRole('viewer');
    await request(buildApp({ email: 'vic@example.com', name: 'Vic', role: 'viewer' })).post('/api/tickets/bulk-delete').send({ ids: [1] }).expect(403);
    memberRole('readonly');
    const user = { email: 'olly@example.com', name: 'Olly', role: 'viewer' };
    await request(buildApp(user, { withReadonlyGate: true })).post('/api/tickets/bulk-delete').send({ ids: [1] }).expect(403);
    await request(buildApp(user)).post('/api/tickets/bulk-delete').send({ ids: [1] }).expect(403);
    expect(ticketServiceMock.bulkDeleteTickets).not.toHaveBeenCalled();
  });
});
