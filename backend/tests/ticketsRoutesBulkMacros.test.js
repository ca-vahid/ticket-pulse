import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * POST /api/tickets/bulk-macros/preview|apply (QA 11-09 #9): one macro on a
 * bulk-bar selection. Same people as the single apply (any ticket actor —
 * agents included; readonly refused by the app-wide gate), behind the
 * native-ticketing switch like the ticket page's Macros menu.
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  workspaceAccess: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  $queryRaw: jest.fn(),
};
const macroMock = { previewMany: jest.fn(), applyMany: jest.fn(), list: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/ticketMacroService.js', () => ({ default: macroMock }));
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
jest.unstable_mockModule('../src/services/ticketMergeService.js', () => ({ default: { mergedInto: jest.fn().mockResolvedValue(null), merge: jest.fn() } }));
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

const admin = { email: 'ada@example.com', name: 'Ada Admin', role: 'admin' };

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.workspace.findUnique.mockResolvedValue({ id: 7, nativeTicketingEnabled: true });
  prismaMock.workspaceAccess.findUnique.mockResolvedValue(null);
  prismaMock.workspaceAccess.findFirst.mockResolvedValue(null);
  macroMock.previewMany.mockResolvedValue({ macro: { id: 31, name: 'Thank and close' }, tickets: [], summary: { total: 2 } });
  macroMock.applyMany.mockResolvedValue({
    macro: { id: 31, name: 'Thank and close' }, total: 2, applied: 1, failed: 1,
    results: [{ ticketId: 1, ref: 'TP-10', ok: true }, { ticketId: 2, ref: 'TP-11', ok: false, error: 'Reply to the requester: mailbox offline' }],
  });
});

describe('POST /api/tickets/bulk-macros/*', () => {
  test('preview hands the body to the service with the workspace and the actor', async () => {
    const res = await request(buildApp(admin)).post('/api/tickets/bulk-macros/preview').send({ macroId: 31, ticketIds: [1, 2] }).expect(200);
    expect(macroMock.previewMany).toHaveBeenCalledWith([1, 2], 7, 31, expect.objectContaining({ email: 'ada@example.com', kind: 'admin' }));
    expect(res.body.data.summary.total).toBe(2);
  });

  test('apply returns the per-ticket results as the service built them', async () => {
    const res = await request(buildApp(admin)).post('/api/tickets/bulk-macros/apply').send({ macroId: 31, ticketIds: [1, 2] }).expect(200);
    expect(macroMock.applyMany).toHaveBeenCalledWith([1, 2], 7, 31, expect.objectContaining({ email: 'ada@example.com' }));
    expect(res.body.data.results[1]).toEqual({ ticketId: 2, ref: 'TP-11', ok: false, error: 'Reply to the requester: mailbox offline' });
  });

  test('an agent (technician only) may apply, like the single apply', async () => {
    prismaMock.technician.findFirst.mockResolvedValue({ id: 9, name: 'Andy Agent' });
    await request(buildApp({ email: 'andy@example.com', name: 'Andy', role: 'agent' }))
      .post('/api/tickets/bulk-macros/apply').send({ macroId: 31, ticketIds: [1] }).expect(200);
    expect(macroMock.applyMany).toHaveBeenCalledWith([1], 7, 31, expect.objectContaining({ kind: 'agent', technicianId: 9 }));
  });

  test('someone with no access to the workspace is refused with 403', async () => {
    await request(buildApp({ email: 'stranger@example.com', name: 'Stranger', role: 'viewer' }))
      .post('/api/tickets/bulk-macros/apply').send({ macroId: 31, ticketIds: [1] }).expect(403);
    expect(macroMock.applyMany).not.toHaveBeenCalled();
  });

  test('a readonly member is refused by the app-wide gate', async () => {
    prismaMock.workspaceAccess.findUnique.mockResolvedValue({ role: 'readonly' });
    prismaMock.workspaceAccess.findFirst.mockResolvedValue({ role: 'readonly' });
    await request(buildApp({ email: 'olly@example.com', name: 'Olly', role: 'viewer' }, { withReadonlyGate: true }))
      .post('/api/tickets/bulk-macros/apply').send({ macroId: 31, ticketIds: [1] }).expect(403);
    expect(macroMock.applyMany).not.toHaveBeenCalled();
  });

  test('native ticketing off: refused, nothing runs', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({ id: 7, nativeTicketingEnabled: false });
    const res = await request(buildApp(admin)).post('/api/tickets/bulk-macros/apply').send({ macroId: 31, ticketIds: [1] }).expect(400);
    expect(res.body.message).toMatch(/Native ticketing is not enabled/);
    expect(macroMock.applyMany).not.toHaveBeenCalled();
  });

  test('the service cap surfaces as a 400 with its message', async () => {
    macroMock.applyMany.mockRejectedValue(new ValidationError('Apply a macro to up to 50 tickets at a time'));
    const res = await request(buildApp(admin)).post('/api/tickets/bulk-macros/apply').send({ macroId: 31, ticketIds: Array.from({ length: 51 }, (_, i) => i + 1) }).expect(400);
    expect(res.body.message).toMatch(/up to 50 tickets/);
  });
});
