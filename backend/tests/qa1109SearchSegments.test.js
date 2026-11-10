import { jest } from '@jest/globals';

/**
 * QA 11-09:
 *  - #4 "Recently closed" (was "Recently resolved"): the `resolved` segment key
 *    stays for old links and still counts Resolved AND Closed bases.
 *  - #7 "All unresolved": the `unresolved` segment = every Open/Pending-base
 *    status, any assignee, parked included; its stats count matches.
 *  - #5 A bare ticket number finds that ticket whatever the list hides by
 *    default (a grouped copy carries is_noise — the root cause of the miss),
 *    but only for the in-app search (`exactRefAnyState: true`).
 */
const prismaMock = {
  workspace: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  customFieldDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  ticket: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  ticketLink: { findMany: jest.fn() },
  ticketStatusDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 7, name: 'Open', baseStatus: 'Open', sortOrder: 0, isSystem: true, isActive: true },
      { id: 2, workspaceId: 7, name: 'Pending', baseStatus: 'Pending', sortOrder: 1, isSystem: true, isActive: true },
      { id: 5, workspaceId: 7, name: 'Waiting on vendor', baseStatus: 'Pending', sortOrder: 2, isSystem: false, isActive: true },
      { id: 4, workspaceId: 7, name: 'Closed', baseStatus: 'Closed', sortOrder: 3, isSystem: true, isActive: true },
    ]),
  },
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
jest.unstable_mockModule('../src/services/scheduledTicketService.js', () => ({ default: {} }));

const { default: ticketService, ticketRefClauses } = await import('../src/services/ticketService.js');

beforeEach(() => {
  prismaMock.workspace.findUnique.mockResolvedValue({ id: 7, defaultTimezone: 'America/Vancouver' });
});

const flat = (where) => JSON.stringify(where, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));

describe('ticketRefClauses', () => {
  test('TP numbers, FreshService ids with or without #, and nothing else', () => {
    expect(ticketRefClauses('TP-11639')).toEqual([{ nativeNumber: 11639 }]);
    expect(ticketRefClauses(' tp11639 ')).toEqual([{ nativeNumber: 11639 }]);
    expect(ticketRefClauses('#232558')).toEqual([{ nativeNumber: 232558 }, { freshserviceTicketId: 232558n }]);
    expect(ticketRefClauses('printer 2')).toEqual([]);
    expect(ticketRefClauses('')).toEqual([]);
  });

  test('a number too big for a TP number is only a FreshService id (no Int overflow in the query)', () => {
    expect(ticketRefClauses('99999999999')).toEqual([{ freshserviceTicketId: 99999999999n }]);
    expect(ticketRefClauses('TP-99999999999')).toEqual([]);
  });
});

describe('Recently closed / All unresolved segments (QA 11-09 #4, #7)', () => {
  test('"resolved" (the Recently closed view) keeps its key and counts every Resolved- and Closed-base status', async () => {
    const where = await ticketService.buildListWhere(7, { segment: 'resolved' });
    expect(where.status).toEqual({ in: ['Closed'] });
  });

  test('"unresolved" is every Open/Pending-base status, any assignee, parked included', async () => {
    const where = await ticketService.buildListWhere(7, { segment: 'unresolved' });
    expect(where.status).toEqual({ in: ['Open', 'Pending', 'Waiting on vendor'] });
    expect(where.assignedTechId).toBeUndefined();
    expect(where.parkedUntil).toBeUndefined();
    expect(where.isNoise).toBe(false);
  });

  test('the stats scan counts "unresolved" the same way (no parked filter)', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ all: 9, unresolved: 4 }]);
    const out = await ticketService._queueCountsOneScan(7, {
      openNames: ['Open', 'Pending'], openBaseNames: ['Open'], resolvedNames: ['Closed'], closedNames: ['Closed'],
      now: new Date(), endOfDay: new Date(), weekStart: new Date(), monthStart: new Date(), yearStart: new Date(), weekAhead: new Date(),
    });
    expect(out.unresolved).toBe(4);
    const sql = prismaMock.$queryRaw.mock.calls.at(-1)[0].join('?');
    expect(sql).toContain('count(*) FILTER (WHERE NOT is_noise AND status = ANY(?))::int AS "unresolved"');
  });

  test('the per-count fallback returns unresolved too', async () => {
    prismaMock.ticket.count.mockResolvedValue(3);
    const out = await ticketService._queueCountsSeparate(7, {
      open: {}, visible: {}, openNames: ['Open', 'Pending'], openBaseNames: ['Open'], resolvedNames: ['Closed'], closedNames: ['Closed'],
      now: new Date(), endOfDay: new Date(), weekStart: new Date(), monthStart: new Date(), yearStart: new Date(), weekAhead: new Date(),
    });
    expect(out.unresolved).toBe(3);
    expect(prismaMock.ticket.count).toHaveBeenCalledWith({ where: { workspaceId: 7, isNoise: false, status: { in: ['Open', 'Pending'] } } });
  });
});

describe('a typed ticket number always finds the ticket (QA 11-09 #5)', () => {
  test('root cause: without the in-app flag, a grouped copy (is_noise) is filtered out', async () => {
    const where = await ticketService.buildListWhere(7, { q: 'TP-11639' });
    expect(where.isNoise).toBe(false);
    expect(where.status).toEqual({ notIn: ['Deleted', 'Spam'] });
  });

  test('with the flag: the number passes the noise and Deleted/Spam defaults; other matches do not', async () => {
    const where = await ticketService.buildListWhere(7, { q: 'TP-11639', exactRefAnyState: true });
    expect(where.isNoise).toBeUndefined();
    expect(where.status).toBeUndefined();
    const text = flat(where.AND);
    expect(text).toContain(flat({ OR: [{ isNoise: false }, { OR: [{ nativeNumber: 11639 }] }] }));
    expect(text).toContain(flat({ OR: [{ status: { notIn: ['Deleted', 'Spam'] } }, { OR: [{ nativeNumber: 11639 }] }] }));
  });

  test('the flag only works as a real boolean: ?exactRefAnyState=true from a URL changes nothing', async () => {
    const where = await ticketService.buildListWhere(7, { q: 'TP-11639', exactRefAnyState: 'true' });
    expect(where.isNoise).toBe(false);
  });

  test('a text search keeps hiding noise even with the flag', async () => {
    const where = await ticketService.buildListWhere(7, { q: 'monitor flicker', exactRefAnyState: true });
    expect(where.isNoise).toBe(false);
    expect(where.status).toEqual({ notIn: ['Deleted', 'Spam'] });
  });

  test('the date window lets the number through too', async () => {
    const where = await ticketService.buildListWhere(7, { q: '#232558', createdWithin: '7d', exactRefAnyState: true });
    const windowClause = where.AND.find((c) => c.OR?.some((o) => o.createdAt));
    expect(flat(windowClause)).toContain('"freshserviceTicketId":"232558n"');
  });

  test('a filter the person picked still applies', async () => {
    const where = await ticketService.buildListWhere(7, { q: 'TP-11639', status: 'Open', exactRefAnyState: true });
    expect(where.status).toEqual({ in: ['Open'] });
  });

  test('the Noise view is unchanged', async () => {
    const where = await ticketService.buildListWhere(7, { q: 'TP-11639', noise: 'only', exactRefAnyState: true });
    expect(where.isNoise).toBe(true);
  });
});

describe('"Combined into" on list rows (QA 11-09 #5)', () => {
  test('a grouping link and a merge link become the row hint; another workspace is never named', async () => {
    prismaMock.ticketLink.findMany.mockResolvedValueOnce([
      { id: 9, ticketId: 119898, kind: 'duplicate_of', relatedTicket: { id: 119897, workspaceId: 7, origin: 'ticketpulse', nativeNumber: 11638, freshserviceTicketId: null } },
      { id: 8, ticketId: 500, kind: 'merged_into', relatedTicket: { id: 501, workspaceId: 7, origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 247001n } },
      { id: 7, ticketId: 600, kind: 'duplicate_of', relatedTicket: { id: 601, workspaceId: 2, origin: 'ticketpulse', nativeNumber: 9, freshserviceTicketId: null } },
    ]);
    const map = await ticketService._combinedIntoByTicket([119898, 500, 600], 7);
    expect(map.get(119898)).toEqual({ id: 119897, displayRef: 'TP-11638', kind: 'combined' });
    expect(map.get(500)).toEqual({ id: 501, displayRef: '#247001', kind: 'merged' });
    expect(map.has(600)).toBe(false);
  });

  test('a failed lookup is an empty map, never an error', async () => {
    prismaMock.ticketLink.findMany.mockRejectedValueOnce(new Error('pool timeout'));
    expect((await ticketService._combinedIntoByTicket([1], 7)).size).toBe(0);
  });
});
