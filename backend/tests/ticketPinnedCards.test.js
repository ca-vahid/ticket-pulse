import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Custom Fields Activation Phase 1 — pinned workflow cards on tickets:
 * getTicket serialization (active cards only, contract shape), the dismiss
 * service (audited, idempotent), and the dismiss route wiring end-to-end
 * through the real tickets router + real ticketService.
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  competencyCategory: { findFirst: jest.fn(), findMany: jest.fn() },
  group: { findFirst: jest.fn(), findMany: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  requester: { findUnique: jest.fn() },
  ticketAssignmentEpisode: { create: jest.fn(), updateMany: jest.fn() },
  ticketThreadEntry: { create: jest.fn() },
  ticketActivity: { findMany: jest.fn() },
  ticketApproval: { findMany: jest.fn() },
  ticketAttachment: { findMany: jest.fn() },
  ticketPinnedCard: { findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  ticketTypeDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  ticketStatusDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 1, name: 'Open', baseStatus: 'Open', color: 'blue', sortOrder: 0, isSystem: true, isActive: true },
      { id: 2, workspaceId: 1, name: 'Pending', baseStatus: 'Pending', color: 'amber', sortOrder: 1, isSystem: true, isActive: true },
      { id: 3, workspaceId: 1, name: 'Resolved', baseStatus: 'Resolved', color: 'emerald', sortOrder: 2, isSystem: true, isActive: true },
      { id: 4, workspaceId: 1, name: 'Closed', baseStatus: 'Closed', color: 'slate', sortOrder: 3, isSystem: true, isActive: true },
    ]),
  },
  slaPolicy: { findFirst: jest.fn() },
  assignmentPipelineRun: { findFirst: jest.fn() },
  $queryRaw: jest.fn(),
};
const ticketActivityRepositoryMock = { create: jest.fn() };
const ticketThreadRepositoryMock = { listForTicket: jest.fn() };
const sseBroadcastMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: { evaluate: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: ticketActivityRepositoryMock }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: ticketThreadRepositoryMock }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketEvent: jest.fn(), emitTicketLifecycleNotifications: jest.fn() },
}));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: { findByEmail: jest.fn(), createNative: jest.fn() } }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: { sendEmail: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({
  default: {},
  sseManager: { broadcast: sseBroadcastMock },
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
// Router-only collaborators the pinned-card tests never exercise.
jest.unstable_mockModule('../src/services/scheduledTicketService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/middleware/workspace.js', () => ({
  requireWorkspace: (req, _res, next) => { req.workspaceId = 1; next(); },
}));

const { default: ticketService } = await import('../src/services/ticketService.js');
const { default: ticketsRouter } = await import('../src/routes/tickets.routes.js');

const actor = { email: 'ada@x.io', name: 'Ada Admin', role: 'admin' };

const CARD = {
  id: 41,
  ticketId: 100,
  kind: 'field_card',
  payload: { kind: 'field_card', v: 1, title: 'API intake', intro: null, accent: 'violet', fields: [], workflowId: 77, runId: 900, workflowName: 'Intake router' },
  workflowId: 77,
  createdAt: new Date('2026-08-06T10:00:00.000Z'),
  dismissedAt: null,
  dismissedBy: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  ticketActivityRepositoryMock.create.mockResolvedValue({});
  prismaMock.ticket.findFirst.mockResolvedValue({
    id: 100, workspaceId: 1, origin: 'ticketpulse', status: 'Open', assignedTechId: null,
    nativeNumber: 1042, freshserviceTicketId: null,
  });
  prismaMock.ticketPinnedCard.findFirst.mockResolvedValue({ ...CARD });
  prismaMock.ticketPinnedCard.update.mockImplementation(({ where, data }) => Promise.resolve({ ...CARD, ...data, id: where.id }));
});

// ------------------------------------------------------- getTicket serialization

describe('ticketService.getTicket pinnedCards serialization', () => {
  test('active pinned cards ship as {id, kind, payload, createdAt}; dismissed rows are excluded by the query', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({
      id: 100, workspaceId: 1, origin: 'ticketpulse', status: 'Open',
      nativeNumber: 1042, freshserviceTicketId: null, subject: 'VPN access problem',
      priority: 3, requester: null, tagLinks: [], pipelineRuns: [], assignmentEpisodes: [],
      createdAt: new Date('2026-08-01T10:00:00.000Z'), updatedAt: new Date('2026-08-06T10:00:00.000Z'),
      lastRealActivityAt: null, freshserviceUpdatedAt: null,
    });
    ticketThreadRepositoryMock.listForTicket.mockResolvedValue([]);
    prismaMock.ticketActivity.findMany.mockResolvedValue([]);
    prismaMock.ticketApproval.findMany.mockResolvedValue([]);
    prismaMock.ticketAttachment.findMany.mockResolvedValue([]);
    prismaMock.ticketPinnedCard.findMany.mockResolvedValue([
      { id: 41, kind: 'field_card', payload: CARD.payload, createdAt: CARD.createdAt },
    ]);
    prismaMock.$queryRaw.mockResolvedValue([]);
    prismaMock.workspace.findUnique.mockResolvedValue({ internalDomains: [] });

    const result = await ticketService.getTicket(100, 1);

    // Contract shape the frontend PinnedIntakeCard consumes.
    expect(result.pinnedCards).toEqual([
      { id: 41, kind: 'field_card', payload: CARD.payload, createdAt: CARD.createdAt },
    ]);
    // Active-only + select shape enforced at the query.
    expect(prismaMock.ticketPinnedCard.findMany).toHaveBeenCalledWith({
      where: { ticketId: 100, dismissedAt: null },
      orderBy: { id: 'asc' },
      select: { id: true, kind: true, payload: true, createdAt: true },
    });
  });
});

// ------------------------------------------------------------- dismiss (service)

describe('ticketService.dismissPinnedCard', () => {
  test('stamps dismissed_at/by, audits pinned_card_dismissed, broadcasts', async () => {
    const result = await ticketService.dismissPinnedCard(100, 1, 41, actor);

    expect(result).toEqual({ dismissed: true, cardId: 41 });
    expect(prismaMock.ticketPinnedCard.update).toHaveBeenCalledWith({
      where: { id: 41 },
      data: { dismissedAt: expect.any(Date), dismissedBy: 'ada@x.io' },
    });
    expect(ticketActivityRepositoryMock.create).toHaveBeenCalledWith(expect.objectContaining({
      ticketId: 100,
      activityType: 'pinned_card_dismissed',
      performedBy: 'Ada Admin',
      details: { cardId: 41, kind: 'field_card', workflowId: 77 },
    }));
    expect(sseBroadcastMock).toHaveBeenCalled();
  });

  test('is idempotent: dismissing an already-dismissed card is a no-op success', async () => {
    prismaMock.ticketPinnedCard.findFirst.mockResolvedValue({ ...CARD, dismissedAt: new Date() });

    const result = await ticketService.dismissPinnedCard(100, 1, 41, actor);

    expect(result).toEqual({ dismissed: true, alreadyDismissed: true, cardId: 41 });
    expect(prismaMock.ticketPinnedCard.update).not.toHaveBeenCalled();
    expect(ticketActivityRepositoryMock.create).not.toHaveBeenCalled();
  });

  test('unknown card or wrong ticket → NotFoundError', async () => {
    prismaMock.ticketPinnedCard.findFirst.mockResolvedValue(null);
    await expect(ticketService.dismissPinnedCard(100, 1, 999, actor)).rejects.toThrow(/pinned card not found/i);
  });
});

// --------------------------------------------------------------- dismiss (route)

describe('POST /:id/pinned-cards/:cardId/dismiss (route wiring)', () => {
  function buildApp() {
    const app = express();
    app.use(express.json());
    // Authenticated admin session (resolveTicketActor reads req.session.user).
    app.use((req, _res, next) => {
      req.session = { user: { email: 'ada@x.io', name: 'Ada Admin', role: 'admin' } };
      next();
    });
    app.use('/api/tickets', ticketsRouter);
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => {
      res.status(err.statusCode || 500).json({ success: false, message: err.message });
    });
    return app;
  }

  beforeEach(() => {
    prismaMock.technician.findFirst.mockResolvedValue(null); // admin needs no tech profile
  });

  test('dismisses through the real router + service and returns the result', async () => {
    const res = await request(buildApp())
      .post('/api/tickets/100/pinned-cards/41/dismiss')
      .expect(200);

    expect(res.body).toEqual({ success: true, data: { dismissed: true, cardId: 41 } });
    expect(prismaMock.ticketPinnedCard.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 41 } }));
    // Dismissal is attributed to the session actor.
    expect(prismaMock.ticketPinnedCard.update.mock.calls[0][0].data.dismissedBy).toBe('ada@x.io');
  });

  test('second dismiss over the route stays 200 (idempotent)', async () => {
    prismaMock.ticketPinnedCard.findFirst.mockResolvedValue({ ...CARD, dismissedAt: new Date() });
    const res = await request(buildApp())
      .post('/api/tickets/100/pinned-cards/41/dismiss')
      .expect(200);
    expect(res.body.data.alreadyDismissed).toBe(true);
  });

  test('unknown card → 404 problem response', async () => {
    prismaMock.ticketPinnedCard.findFirst.mockResolvedValue(null);
    const res = await request(buildApp())
      .post('/api/tickets/100/pinned-cards/999/dismiss')
      .expect(404);
    expect(res.body.message).toMatch(/pinned card not found/i);
  });
});
