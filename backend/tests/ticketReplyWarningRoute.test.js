import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * 22 Nov 2026 — GET /api/tickets/:id/reply-warning: does the requester read
 * replies? Drives a quiet warning above the reply composer. `kind` is
 * 'unattended' (the requester flag behind 4.3.97's guards), 'machine_sender'
 * (on this workspace's no-reply list, machineSenderService) or null. An agent
 * (no workspace_access row) asks it too; it never refuses anything and a list
 * that cannot be read means "reads replies". (Harness from urgentClockTicketRoute.test.js.)
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  workspaceAccess: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  $queryRaw: jest.fn(),
};
const machineSenderMock = { machineSenderMatch: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/machineSenderService.js', () => ({ ...machineSenderMock, default: machineSenderMock }));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({
  default: { getAccessRole: jest.fn(async () => null), hasActiveTechnician: jest.fn(async () => true) },
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: { getTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketParkService.js', () => ({ default: { activePark: jest.fn() }, parkView: () => null }));
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
  requireWorkspace: (req, _res, next) => { req.workspaceId = 1; next(); },
}));

const { default: ticketsRouter } = await import('../src/routes/tickets.routes.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  // An agent: global role 'agent', no workspace_access row, an active technician here.
  app.use((req, _res, next) => { req.session = { user: { email: 'dana.fox@example.com', name: 'Dana Fox', role: 'agent' } }; next(); });
  app.use('/api/tickets', ticketsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, message: err.message, code: err.code });
  });
  return app;
}

const withRequester = (requester) => prismaMock.ticket.findFirst.mockResolvedValue({ requester });
const get = (id = 42) => request(buildApp()).get(`/api/tickets/${id}/reply-warning`);

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.technician.findFirst.mockResolvedValue({ id: 12, name: 'Dana Fox' });
  machineSenderMock.machineSenderMatch.mockResolvedValue(null);
});

describe('GET /api/tickets/:id/reply-warning', () => {
  test('a machine sender on the no-reply list → machine_sender, with the entry it matched', async () => {
    withRequester({ email: 'noreply@alerts.example.com', unattended: false });
    machineSenderMock.machineSenderMatch.mockResolvedValue('noreply');
    const res = await get().expect(200);
    expect(res.body.data).toEqual({ kind: 'machine_sender', unattended: false, machineSender: 'noreply' });
    expect(machineSenderMock.machineSenderMatch).toHaveBeenCalledWith(1, 'noreply@alerts.example.com');
    const where = prismaMock.ticket.findFirst.mock.calls[0][0].where;
    expect(where).toEqual({ id: 42, workspaceId: 1 });
  });

  test('an unattended requester → unattended (the list is not even asked)', async () => {
    withRequester({ email: 'soc-alerts@example.com', unattended: true });
    const res = await get().expect(200);
    expect(res.body.data).toEqual({ kind: 'unattended', unattended: true, machineSender: null });
    expect(machineSenderMock.machineSenderMatch).not.toHaveBeenCalled();
  });

  test('a person who reads mail → no warning', async () => {
    withRequester({ email: 'eli.park@example.com', unattended: false });
    const res = await get().expect(200);
    expect(res.body.data).toEqual({ kind: null, unattended: false, machineSender: null });
  });

  test('no requester e-mail → no warning, and the list is not asked', async () => {
    withRequester(null);
    const res = await get().expect(200);
    expect(res.body.data.kind).toBeNull();
    expect(machineSenderMock.machineSenderMatch).not.toHaveBeenCalled();
  });

  test('a list that cannot be read never fails the composer: no warning', async () => {
    withRequester({ email: 'noreply@alerts.example.com', unattended: false });
    machineSenderMock.machineSenderMatch.mockRejectedValue(new Error('db down'));
    const res = await get().expect(200);
    expect(res.body.data.kind).toBeNull();
  });

  test('a ticket of another workspace answers 404', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(null);
    await get(77).expect(404);
  });

  test('a bad id is a 400', async () => {
    await request(buildApp()).get('/api/tickets/abc/reply-warning').expect(400);
  });
});
