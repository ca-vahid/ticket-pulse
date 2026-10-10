import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * GET /api/tickets/:id carries the Urgent response clock (plans/URGENT_RESPONSE_PLAN.md)
 * as `ticket.urgentClock`, next to `ticket.park`: only when the engine has an
 * active clock for the ticket, only asked for tickets that can have one (High
 * or Urgent, with an owner, not parked), and never at the cost of the page.
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  workspaceAccess: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  $queryRaw: jest.fn(),
};
const ticketServiceMock = { getTicket: jest.fn() };
const parkServiceMock = { activePark: jest.fn() };
const engineMock = { clockView: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/ticketParkService.js', () => ({
  default: parkServiceMock,
  parkView: (park) => (park ? { id: park.id, until: park.until } : null),
}));
jest.unstable_mockModule('../src/services/urgentResponse/urgentResponseService.js', () => ({ default: engineMock }));
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
  app.use((req, _res, next) => { req.session = { user: { email: 'ada@example.com', name: 'Ada Admin', role: 'admin' } }; next(); });
  app.use('/api/tickets', ticketsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, message: err.message, code: err.code });
  });
  return app;
}

const TICKET = { id: 42, workspaceId: 1, subject: 'VPN down', priority: 4, assignedTechId: 11, parkedUntil: null };
const CLOCK = {
  state: 'running', startedAt: '2026-10-12T16:00:00.000Z', notifyAt: '2026-10-12T16:15:00.000Z', moveAt: '2026-10-12T16:30:00.000Z',
  notifiedAt: null, notifyMinutes: 15, moveMinutes: 30,
};
const get = () => request(buildApp()).get('/api/tickets/42?reconcile=0');

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, nativeTicketingEnabled: true });
  prismaMock.workspaceAccess.findUnique.mockResolvedValue(null);
  prismaMock.workspaceAccess.findFirst.mockResolvedValue(null);
  ticketServiceMock.getTicket.mockResolvedValue({ ...TICKET });
  parkServiceMock.activePark.mockResolvedValue(null);
  engineMock.clockView.mockResolvedValue({ ...CLOCK });
});

describe('GET /api/tickets/:id — the urgent clock', () => {
  test('an Urgent ticket with an active clock carries it', async () => {
    const res = await get().expect(200);
    expect(res.body.data.urgentClock).toEqual(CLOCK);
    expect(engineMock.clockView).toHaveBeenCalledTimes(1);
    expect(engineMock.clockView).toHaveBeenCalledWith(42);
  });

  test('no active clock (Shadow, off, stopped): the field is absent, not null', async () => {
    engineMock.clockView.mockResolvedValue(null);
    const res = await get().expect(200);
    expect(res.body.data).toMatchObject({ id: 42, subject: 'VPN down' });
    expect('urgentClock' in res.body.data).toBe(false);
  });

  test.each([
    ['a Medium ticket', { priority: 2 }],
    ['a ticket with no priority', { priority: null }],
    ['an unassigned ticket', { assignedTechId: null }],
  ])('%s is never asked about', async (_label, over) => {
    ticketServiceMock.getTicket.mockResolvedValue({ ...TICKET, ...over });
    const res = await get().expect(200);
    expect(engineMock.clockView).not.toHaveBeenCalled();
    expect('urgentClock' in res.body.data).toBe(false);
  });

  test('a parked ticket shows its park and no clock', async () => {
    ticketServiceMock.getTicket.mockResolvedValue({ ...TICKET, parkedUntil: '2026-10-20T16:00:00.000Z' });
    parkServiceMock.activePark.mockResolvedValue({ id: 7, until: '2026-10-20T16:00:00.000Z' });
    const res = await get().expect(200);
    expect(res.body.data.park).toEqual({ id: 7, until: '2026-10-20T16:00:00.000Z' });
    expect(engineMock.clockView).not.toHaveBeenCalled();
    expect('urgentClock' in res.body.data).toBe(false);
  });

  test('a High ticket is asked about (the clock layer can cover High)', async () => {
    ticketServiceMock.getTicket.mockResolvedValue({ ...TICKET, priority: 3 });
    const res = await get().expect(200);
    expect(res.body.data.urgentClock).toMatchObject({ state: 'running' });
  });

  test('the engine failing (table missing, not written yet) never fails the page', async () => {
    engineMock.clockView.mockRejectedValue(new Error('relation "urgent_response_clocks" does not exist'));
    const broken = await get().expect(200);
    expect(broken.body.data).toMatchObject({ id: 42 });
    expect('urgentClock' in broken.body.data).toBe(false);

    delete engineMock.clockView;
    const missing = await get().expect(200);
    expect(missing.body.data).toMatchObject({ id: 42 });
    engineMock.clockView = jest.fn();
  });
});
