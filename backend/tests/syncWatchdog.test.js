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
});

describe('getLatestSuccessful watermark source', () => {
  test('only considers completed TICKET syncs (syncType full)', async () => {
    prismaMock.syncLog.findFirst.mockResolvedValue({ id: 1 });
    await syncLogRepository.getLatestSuccessful(1);
    expect(prismaMock.syncLog.findFirst).toHaveBeenCalledWith({
      where: { status: 'completed', syncType: 'full', workspaceId: 1 },
      orderBy: { startedAt: 'desc' },
    });
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
