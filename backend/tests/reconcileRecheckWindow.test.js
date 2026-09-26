import { jest } from '@jest/globals';

/**
 * FreshService budget, lever 2 (Vahid, 25 Sep 2026): the open-ticket reconcile
 * re-read every open FS ticket every few minutes (60–78 of the old 110 calls a
 * minute) only to catch deletions and silent reassignments. Each open ticket
 * is now re-checked at most once an hour.
 */

const findMany = jest.fn().mockResolvedValue([]);
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: { ticket: { findMany } } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: syncService, RECONCILE_RECHECK_MS } = await import('../src/services/syncService.js');

test('only tickets never checked, or last checked over an hour ago, are candidates', async () => {
  const before = Date.now();
  await syncService._reconcileTicketStatuses(1);
  expect(RECONCILE_RECHECK_MS).toBe(60 * 60 * 1000);
  const where = findMany.mock.calls[0][0].where;
  expect(where).toMatchObject({ workspaceId: 1, origin: 'freshservice' });
  expect(where.OR).toEqual([
    { lastReconciledAt: null },
    { lastReconciledAt: { lt: expect.any(Date) } },
  ]);
  const cutoff = where.OR[1].lastReconciledAt.lt.getTime();
  expect(before - cutoff).toBeGreaterThanOrEqual(RECONCILE_RECHECK_MS - 1000);
  expect(before - cutoff).toBeLessThanOrEqual(RECONCILE_RECHECK_MS + 1000);
});
