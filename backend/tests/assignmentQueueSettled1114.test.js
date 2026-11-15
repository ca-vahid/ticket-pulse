import { jest } from '@jest/globals';

/**
 * MEGA 11-14 Part B: the queue count and the run history leave settled
 * suggestions out by default; history shows them when asked for by name;
 * "Decided > Manually in FreshService" keeps showing them (the ticket got its
 * owner outside the pipeline); today's "Picked up in FreshService" still
 * counts them; the daily review never pulls a settled run into the day it
 * was settled.
 */

const prismaMock = {
  assignmentPipelineRun: {
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    groupBy: jest.fn().mockResolvedValue([]),
  },
  ticket: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
  ticketAssignmentEpisode: { findMany: jest.fn().mockResolvedValue([]) },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: repo } = await import('../src/services/assignmentRepository.js');
const { getTodayStats } = await import('../src/services/assignmentDailyStats.js');

const NOT_SETTLED = { OR: [{ decision: null }, { decision: { not: 'settled_elsewhere' } }] };
// The queue's item read is the findMany that hydrates the ticket (the stale-run sweep reads first).
const itemsCall = () => prismaMock.assignmentPipelineRun.findMany.mock.calls.find((c) => c[0].include?.ticket)[0];
const hasNotSettled = (where) => JSON.stringify(where).includes(JSON.stringify(NOT_SETTLED));

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([]);
  prismaMock.assignmentPipelineRun.count.mockResolvedValue(0);
});

describe('run history', () => {
  test('leaves settled runs out by default, NULL-safe (running / failed runs stay)', async () => {
    await repo.getPipelineRuns(2, { limit: 20 });
    const where = prismaMock.assignmentPipelineRun.findMany.mock.calls.at(-1)[0].where;
    expect(hasNotSettled(where)).toBe(true);
    expect(hasNotSettled(prismaMock.assignmentPipelineRun.count.mock.calls.at(-1)[0].where)).toBe(true);
  });

  test('shows them under their own name when asked for', async () => {
    await repo.getPipelineRuns(2, { decision: 'settled_elsewhere' });
    let where = prismaMock.assignmentPipelineRun.findMany.mock.calls.at(-1)[0].where;
    expect(hasNotSettled(where)).toBe(false);
    expect(JSON.stringify(where)).toContain('"decision":"settled_elsewhere"');

    await repo.getPipelineRuns(2, { decisions: ['approved', 'settled_elsewhere'] });
    where = prismaMock.assignmentPipelineRun.findMany.mock.calls.at(-1)[0].where;
    expect(hasNotSettled(where)).toBe(false);

    await repo.getPipelineRuns(2, { includeSettled: true, ticketStatus: 'deleted' });
    where = prismaMock.assignmentPipelineRun.findMany.mock.calls.at(-1)[0].where;
    expect(hasNotSettled(where)).toBe(false);
  });
});

describe('the review queue', () => {
  test('Awaiting decision and its count read pending reviews only', async () => {
    await repo.getPendingQueue(2, { assignmentStatus: 'unassigned', ticketStatus: 'active' });
    const itemsWhere = itemsCall().where;
    expect(JSON.stringify(itemsWhere)).toContain('"decision":"pending_review"');
    expect(JSON.stringify(itemsWhere)).not.toContain('settled_elsewhere');
    const allCount = prismaMock.assignmentPipelineRun.count.mock.calls[0][0].where;
    expect(allCount.decision).toBe('pending_review');
  });

  test('"Manually in FreshService" (outside_assigned) reads pending and settled runs whose ticket has an owner', async () => {
    await repo.getPendingQueue(2, { assignmentStatus: 'outside_assigned', ticketStatus: 'all' });
    const itemsWhere = itemsCall().where;
    expect(itemsWhere.decision).toEqual({ in: ['pending_review', 'settled_elsewhere'] });
    expect(itemsWhere.ticket.is.assignedTechId).toEqual({ not: null });
    const outsideCount = prismaMock.assignmentPipelineRun.count.mock.calls[2][0].where;
    expect(outsideCount.decision).toEqual({ in: ['pending_review', 'settled_elsewhere'] });
  });
});

describe('today\'s numbers', () => {
  test('"Picked up in FreshService" counts settled runs; only still-pending ones come off "needs review"', async () => {
    prismaMock.assignmentPipelineRun.groupBy.mockResolvedValue([
      { status: 'completed', decision: 'pending_review', _count: { _all: 4 } },
    ]);
    prismaMock.assignmentPipelineRun.count.mockImplementation(async ({ where }) => {
      if (where.decision?.in) return 9; // pending + settled with an owner
      if (where.decision === 'pending_review') return 1; // still pending with an owner
      return 0;
    });
    const stats = await getTodayStats(2, 'America/Vancouver');
    expect(stats.handledInFs).toBe(9);
    expect(stats.manualReviewRequired).toBe(3);
  });
});
