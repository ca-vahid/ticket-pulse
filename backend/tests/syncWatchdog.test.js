import { jest } from '@jest/globals';

/**
 * Regression tests for the 2026-07-07 sync outage:
 *  1. A hung run held the in-memory workspace lock for 64 minutes and every
 *     scheduled tick skipped silently — the lock must go stale and be taken
 *     over after SYNC_LOCK_STALE_MS.
 *  2. On resume, the incremental watermark was computed from a completed
 *     vacation-tracker log instead of the last completed TICKET sync, so the
 *     outage window was never re-fetched — getLatestSuccessful must only
 *     consider syncType 'full'.
 */

const prismaMock = {
  syncLog: {
    findFirst: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    create: jest.fn(),
    update: jest.fn(),
    groupBy: jest.fn(),
  },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: syncLogRepository } = await import('../src/services/syncLogRepository.js');

beforeEach(() => {
  prismaMock.syncLog.findFirst.mockReset();
  prismaMock.syncLog.updateMany.mockClear();
  prismaMock.syncLog.groupBy.mockReset();
});

describe('getLatestSuccessful watermark source', () => {
  test('only considers completed TICKET syncs (syncType full), newest COMPLETION first', async () => {
    // Phase SH: order by completedAt, not startedAt — overlapping runs
    // (watchdog takeover, manual "Sync now") complete out of order, and the
    // startedAt ordering could return an older completion, making sync health
    // report a stale age right after a successful sync.
    prismaMock.syncLog.findFirst.mockResolvedValue({ id: 1 });
    await syncLogRepository.getLatestSuccessful(1);
    expect(prismaMock.syncLog.findFirst).toHaveBeenCalledWith({
      where: { status: 'completed', syncType: 'full', workspaceId: 1 },
      orderBy: { completedAt: 'desc' },
    });
  });
});

describe('getRunningSince — in-flight run detection (sync health)', () => {
  test('one grouped query over started full-sync rows, mapped per workspace', async () => {
    const startedAt = new Date('2026-08-15T18:00:00Z');
    prismaMock.syncLog.groupBy.mockResolvedValue([
      { workspaceId: 2, _max: { startedAt } },
      { workspaceId: 3, _max: { startedAt: null } },
    ]);
    const result = await syncLogRepository.getRunningSince([1, 2, 3]);
    expect(prismaMock.syncLog.groupBy).toHaveBeenCalledWith({
      by: ['workspaceId'],
      where: { status: 'started', syncType: 'full', workspaceId: { in: [1, 2, 3] } },
      _max: { startedAt: true },
    });
    expect(result.get(2)).toBe(startedAt);
    expect(result.has(3)).toBe(false); // null max rows are dropped
    expect(result.has(1)).toBe(false); // nothing running
  });

  test('empty input and DB errors both degrade to an empty map (never throws)', async () => {
    expect((await syncLogRepository.getRunningSince([])).size).toBe(0);
    expect(prismaMock.syncLog.groupBy).not.toHaveBeenCalled();
    prismaMock.syncLog.groupBy.mockRejectedValueOnce(new Error('boom'));
    expect((await syncLogRepository.getRunningSince([1])).size).toBe(0);
  });
});

describe('failStaleStarted', () => {
  test('marks old started rows failed with an explanatory message', async () => {
    const count = await syncLogRepository.failStaleStarted(1, 30 * 60 * 1000);
    expect(count).toBe(1);
    const arg = prismaMock.syncLog.updateMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({ workspaceId: 1, status: 'started' });
    expect(arg.where.startedAt.lt).toBeInstanceOf(Date);
    expect(arg.data.status).toBe('failed');
  });

  test('swallows database errors (hygiene must never break a sync)', async () => {
    prismaMock.syncLog.updateMany.mockRejectedValueOnce(new Error('boom'));
    await expect(syncLogRepository.failStaleStarted(1)).resolves.toBe(0);
  });
});
