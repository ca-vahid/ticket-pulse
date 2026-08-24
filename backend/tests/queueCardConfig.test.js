import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Mega 08-23 Phase FC — admin-configurable quick filter cards.
 *  - zonedBoundaries: week/month/year starts cut on the WORKSPACE wall clock
 *  - buildListWhere: created_week/month/year + noise segment branches
 *  - getQueueStats: createdThisWeek/Month/Year counts (zoned floors)
 *  - PUT /api/tickets/queue-cards: exactly-6 / known-keys / no-dupes / admin
 *  - getMeta.queueCards: stored config resolved, absent/invalid → default 6
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  queueCardConfig: { findUnique: jest.fn(), upsert: jest.fn() },
  ticketFormConfig: { findUnique: jest.fn(), upsert: jest.fn(), delete: jest.fn() },
  userPreference: { findUnique: jest.fn(), upsert: jest.fn() },
  customFieldDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  ticket: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  competencyCategory: { findFirst: jest.fn(), findMany: jest.fn() },
  group: { findFirst: jest.fn(), findMany: jest.fn() },
  requester: { findUnique: jest.fn() },
  approvalCategory: { findMany: jest.fn().mockResolvedValue([]) },
  ticketTag: { findMany: jest.fn().mockResolvedValue([]) },
  categoryGroupLink: { findMany: jest.fn().mockResolvedValue([]) },
  ticketTypeDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  ticketStatusDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 7, name: 'Open', baseStatus: 'Open', sortOrder: 0, isSystem: true, isActive: true },
      { id: 2, workspaceId: 7, name: 'Pending', baseStatus: 'Pending', sortOrder: 1, isSystem: true, isActive: true },
      { id: 3, workspaceId: 7, name: 'Resolved', baseStatus: 'Resolved', sortOrder: 2, isSystem: true, isActive: true },
      { id: 4, workspaceId: 7, name: 'Closed', baseStatus: 'Closed', sortOrder: 3, isSystem: true, isActive: true },
    ]),
  },
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
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: { runPipeline: jest.fn() } }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { getUserProfile: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: {
    enqueueTicketCreate: jest.fn(), enqueueFieldSync: jest.fn(), enqueueThreadEntry: jest.fn(),
    reconcileTicket: jest.fn(), getClient: jest.fn(), getInteractiveClient: jest.fn(),
  },
}));
jest.unstable_mockModule('../src/services/ticketMergeService.js', () => ({ default: { mergedInto: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/scheduledTicketService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/middleware/workspace.js', () => ({
  requireWorkspace: (req, _res, next) => { req.workspaceId = 7; next(); },
}));

const { default: ticketsRouter } = await import('../src/routes/tickets.routes.js');
const { default: ticketService } = await import('../src/services/ticketService.js');
const { zonedStartOfMonth, zonedStartOfWeek, zonedStartOfYear } = await import('../src/utils/zonedBoundaries.js');
const { DEFAULT_QUEUE_CARDS, assertValidCards, normalizeStoredCards } = await import('../src/services/queueCardConfigService.js');

function buildApp(sessionUser = { email: 'Ada@X.io', name: 'Ada Admin', role: 'admin' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: sessionUser }; next(); });
  app.use('/api/tickets', ticketsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  });
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.technician.findFirst.mockResolvedValue(null); // admin needs no tech profile
  prismaMock.workspace.findUnique.mockResolvedValue({ id: 7, defaultTimezone: 'America/Los_Angeles', internalDomains: [] });
  prismaMock.queueCardConfig.findUnique.mockResolvedValue(null);
  prismaMock.queueCardConfig.upsert.mockImplementation(({ update, create }) => Promise.resolve({
    id: 1, workspaceId: 7, cards: update?.cards ?? create.cards,
  }));
  prismaMock.ticketFormConfig.findUnique.mockResolvedValue(null);
});

// ------------------------------------------------- zoned boundaries (FC2)

describe('zonedBoundaries — calendar starts on the workspace wall clock', () => {
  // 2026-08-23T02:00:00Z = Sat Aug 22, 19:00 PDT.
  const now = new Date('2026-08-23T02:00:00Z');

  test('week starts Monday 00:00 in the workspace zone (not server/UTC)', () => {
    expect(zonedStartOfWeek(now, 'America/Los_Angeles').toISOString()).toBe('2026-08-17T07:00:00.000Z');
    // UTC would already be Sunday Aug 23 — a UTC cut would misfile the whole evening.
    expect(zonedStartOfWeek(now, 'UTC').toISOString()).toBe('2026-08-17T00:00:00.000Z');
  });

  test('month starts on the 1st 00:00 zone-local (DST-aware offset)', () => {
    expect(zonedStartOfMonth(now, 'America/Los_Angeles').toISOString()).toBe('2026-08-01T07:00:00.000Z');
  });

  test('year starts Jan 1 00:00 zone-local — winter offset (PST, not PDT)', () => {
    expect(zonedStartOfYear(now, 'America/Los_Angeles').toISOString()).toBe('2026-01-01T08:00:00.000Z');
  });

  test('a zone ahead of UTC can already be in the NEXT week', () => {
    // 2026-08-23T15:00:00Z = Mon Aug 24 01:00 in Sydney (AEST, UTC+10).
    const sydneyNow = new Date('2026-08-23T15:00:00Z');
    expect(zonedStartOfWeek(sydneyNow, 'Australia/Sydney').toISOString()).toBe('2026-08-23T14:00:00.000Z');
  });
});

// ---------------------------------------------- segment where-clauses (FC2)

describe('buildListWhere — created_* and noise segments', () => {
  const createdClause = (where) => (where.AND || []).find((c) => c.createdAt)?.createdAt;

  test.each([
    ['created_week', zonedStartOfWeek],
    ['created_month', zonedStartOfMonth],
    ['created_year', zonedStartOfYear],
  ])('%s → createdAt >= the zoned boundary, AND-composed, default status scope kept', async (segment, boundaryFn) => {
    const where = await ticketService.buildListWhere(7, { segment });
    const clause = createdClause(where);
    expect(clause).toBeDefined();
    expect(clause.gte.toISOString()).toBe(boundaryFn(new Date(), 'America/Los_Angeles').toISOString());
    // Counts creations, not open work: any non-Deleted/Spam status.
    expect(where.status).toEqual({ notIn: ['Deleted', 'Spam'] });
    expect(where.isNoise).toBe(false);
  });

  test('created segments use the WORKSPACE timezone', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({ id: 7, defaultTimezone: 'UTC', internalDomains: [] });
    const where = await ticketService.buildListWhere(8, { segment: 'created_week' });
    expect(createdClause(where).gte.toISOString()).toBe(zonedStartOfWeek(new Date(), 'UTC').toISOString());
  });

  test('created segment composes with an explicit createdFrom facet instead of clobbering it', async () => {
    const where = await ticketService.buildListWhere(7, { segment: 'created_month', createdFrom: '2026-01-01' });
    expect(where.createdAt).toEqual({ gte: new Date('2026-01-01') });
    expect(createdClause(where)).toBeDefined();
  });

  test('noise segment flips isNoise true with an any-status scope (matches the noise count)', async () => {
    const where = await ticketService.buildListWhere(7, { segment: 'noise' });
    expect(where.isNoise).toBe(true);
    expect(where.status).toBeUndefined();
  });
});

// --------------------------------------------------- stats counts (FC2)

describe('getQueueStats — createdThisWeek/Month/Year', () => {
  test('returns the three new keys, counting non-noise non-Deleted/Spam rows past the zoned floor', async () => {
    prismaMock.ticket.count.mockResolvedValue(0);
    prismaMock.ticket.groupBy.mockResolvedValue([]);
    prismaMock.$queryRaw.mockResolvedValue([]);

    const stats = await ticketService.getQueueStats(7);
    expect(stats).toEqual(expect.objectContaining({ createdThisWeek: 0, createdThisMonth: 0, createdThisYear: 0 }));

    const createdWheres = prismaMock.ticket.count.mock.calls
      .map((c) => c[0].where)
      .filter((w) => w.createdAt?.gte);
    expect(createdWheres).toHaveLength(3);
    const expected = [
      zonedStartOfWeek(new Date(), 'America/Los_Angeles'),
      zonedStartOfMonth(new Date(), 'America/Los_Angeles'),
      zonedStartOfYear(new Date(), 'America/Los_Angeles'),
    ].map((d) => d.toISOString()).sort();
    expect(createdWheres.map((w) => w.createdAt.gte.toISOString()).sort()).toEqual(expected);
    for (const w of createdWheres) {
      expect(w).toEqual(expect.objectContaining({ workspaceId: 7, isNoise: false, status: { notIn: ['Deleted', 'Spam'] } }));
    }
  });
});

// -------------------------------------------------- validation + route (FC3)

describe('queue-card validation', () => {
  test('exactly 6 keys required', () => {
    expect(() => assertValidCards(DEFAULT_QUEUE_CARDS.slice(0, 5))).toThrow(/exactly 6/);
    expect(() => assertValidCards([...DEFAULT_QUEUE_CARDS, 'noise'])).toThrow(/exactly 6/);
  });

  test('unknown keys rejected', () => {
    expect(() => assertValidCards(['all', 'open', 'awaiting', 'due_today', 'overdue', 'bogus'])).toThrow(/Unknown card key/);
  });

  test('duplicates rejected', () => {
    expect(() => assertValidCards(['all', 'all', 'awaiting', 'due_today', 'overdue', 'resolved'])).toThrow(/duplicates/);
  });

  test('normalizeStoredCards falls back to the default 6 on garbage', () => {
    expect(normalizeStoredCards(null)).toEqual(DEFAULT_QUEUE_CARDS);
    expect(normalizeStoredCards(['all'])).toEqual(DEFAULT_QUEUE_CARDS);
    expect(normalizeStoredCards(['all', 'open', 'awaiting', 'due_today', 'overdue', 'created_month']))
      .toEqual(['all', 'open', 'awaiting', 'due_today', 'overdue', 'created_month']);
  });
});

describe('PUT /api/tickets/queue-cards', () => {
  const VALID = ['all', 'open', 'awaiting', 'created_month', 'overdue', 'resolved'];

  test('admin sets a valid 6-card config (upsert stamped with the actor)', async () => {
    const res = await request(buildApp()).put('/api/tickets/queue-cards').send({ cards: VALID }).expect(200);
    expect(res.body).toEqual({ success: true, data: { cards: VALID } });
    expect(prismaMock.queueCardConfig.upsert).toHaveBeenCalledWith({
      where: { workspaceId: 7 },
      update: { cards: VALID, updatedBy: 'ada@x.io' },
      create: { workspaceId: 7, cards: VALID, updatedBy: 'ada@x.io' },
    });
  });

  test.each([
    [{ cards: VALID.slice(0, 5) }, /exactly 6/],
    [{ cards: [...VALID.slice(0, 5), 'nope'] }, /Unknown card key/],
    [{ cards: ['all', 'all', 'open', 'awaiting', 'overdue', 'resolved'] }, /duplicates/],
    [{}, /must be an array/],
  ])('invalid payload %j → 400, nothing written', async (body, message) => {
    const res = await request(buildApp()).put('/api/tickets/queue-cards').send(body).expect(400);
    expect(res.body.message).toMatch(message);
    expect(prismaMock.queueCardConfig.upsert).not.toHaveBeenCalled();
  });

  test('non-admin members are rejected (same gate as sibling ticket-ops routes)', async () => {
    prismaMock.workspaceAccess.findUnique.mockResolvedValue({ role: 'viewer' });
    prismaMock.workspaceAccess.findFirst.mockResolvedValue({ role: 'viewer' });
    const app = buildApp({ email: 'viewer@x.io', name: 'Vera Viewer', role: 'user' });
    const res = await request(app).put('/api/tickets/queue-cards').send({ cards: VALID }).expect(401);
    expect(res.body.message).toMatch(/admin/i);
    expect(prismaMock.queueCardConfig.upsert).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------- meta delivery (FC3)

describe('getMeta.queueCards', () => {
  beforeEach(() => {
    prismaMock.workspace.findUnique.mockResolvedValue({ id: 7, name: 'IT', isActive: true, nativeTicketingEnabled: true, defaultTimezone: 'America/Los_Angeles' });
    prismaMock.group.findMany.mockResolvedValue([]);
    prismaMock.technician.findMany.mockResolvedValue([]);
    prismaMock.competencyCategory.findMany.mockResolvedValue([]);
    prismaMock.ticket.groupBy.mockResolvedValue([]);
    prismaMock.ticket.count.mockResolvedValue(0);
  });

  test('absent row → today\'s exact default 6 (zero behavior change)', async () => {
    const meta = await ticketService.getMeta(7);
    expect(meta.queueCards).toEqual(['all', 'open', 'awaiting', 'due_today', 'overdue', 'resolved']);
  });

  test('stored config is delivered as-is', async () => {
    prismaMock.queueCardConfig.findUnique.mockResolvedValue({ cards: ['all', 'created_week', 'created_month', 'created_year', 'overdue', 'resolved'] });
    const meta = await ticketService.getMeta(7);
    expect(meta.queueCards).toEqual(['all', 'created_week', 'created_month', 'created_year', 'overdue', 'resolved']);
  });

  test('a stored config that no longer validates falls back to the defaults', async () => {
    prismaMock.queueCardConfig.findUnique.mockResolvedValue({ cards: ['all', 'open', 'gone_key', 'due_today', 'overdue', 'resolved'] });
    const meta = await ticketService.getMeta(7);
    expect(meta.queueCards).toEqual(DEFAULT_QUEUE_CARDS);
  });
});
