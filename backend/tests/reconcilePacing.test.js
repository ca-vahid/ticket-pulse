import { jest } from '@jest/globals';

/**
 * 3 Oct 2026: at a 15-minute recheck the per-workspace reconcile loops burst
 * to ~100 FreshService calls a minute while a 429 had cut the account cap to
 * 134/min, and a person's request timed out in the queue. Reconcile now
 * yields whenever the limiter is busy and picks up the rest next cycle.
 */

const findMany = jest.fn();
const update = jest.fn().mockResolvedValue({});
jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: { ticket: { findMany, update }, assignmentPipelineRun: { updateMany: jest.fn() } },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: syncService, reconcileShouldYield } = await import('../src/services/syncService.js');

const quiet = { requestsLastMinute: 10, maxRequestsPerMinute: 200, queueDepthByPriority: { high: 0 }, slowdownActive: false };

describe('reconcileShouldYield', () => {
  test('quiet limiter → keep going', () => {
    expect(reconcileShouldYield(quiet)).toBe(false);
    expect(reconcileShouldYield(null)).toBe(false);
  });
  test('a person waiting, a 429 slowdown, or 60% of the minute used → yield', () => {
    expect(reconcileShouldYield({ ...quiet, queueDepthByPriority: { high: 1 } })).toBe(true);
    expect(reconcileShouldYield({ ...quiet, slowdownActive: true })).toBe(true);
    expect(reconcileShouldYield({ ...quiet, requestsLastMinute: 120 })).toBe(true);
    expect(reconcileShouldYield({ ...quiet, requestsLastMinute: 119 })).toBe(false);
  });
});

describe('_reconcileTicketStatuses pacing', () => {
  const tickets = [1, 2, 3].map((i) => ({ id: i, freshserviceTicketId: String(1000 + i), subject: `T${i}`, status: 'Open', assignedTechId: null }));
  let stats;
  let client;
  beforeEach(() => {
    jest.clearAllMocks();
    findMany.mockResolvedValue(tickets);
    stats = { ...quiet };
    client = {
      limiter: { getStats: () => stats },
      fetchTicketSafe: jest.fn(async (id) => ({ id, status: 2, deleted: false, spam: false })),
    };
    syncService._initializeClient = jest.fn().mockResolvedValue(client);
    syncService._touchReconciled = jest.fn().mockResolvedValue();
  });

  test('a quiet limiter checks the whole batch', async () => {
    await syncService._reconcileTicketStatuses(1);
    expect(client.fetchTicketSafe).toHaveBeenCalledTimes(3);
  });

  test('a person waiting in the queue stops the batch before any call', async () => {
    stats = { ...quiet, queueDepthByPriority: { high: 2 } };
    await syncService._reconcileTicketStatuses(1);
    expect(client.fetchTicketSafe).not.toHaveBeenCalled();
  });

  test('the limiter getting busy mid-batch stops the rest', async () => {
    client.fetchTicketSafe = jest.fn(async (id) => {
      stats = { ...quiet, slowdownActive: true }; // a 429 arrives after the first call
      return { id, status: 2, deleted: false, spam: false };
    });
    await syncService._reconcileTicketStatuses(1);
    expect(client.fetchTicketSafe).toHaveBeenCalledTimes(1);
  });
});
