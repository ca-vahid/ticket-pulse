import { jest, describe, expect, test, beforeEach } from '@jest/globals';
import { readFileSync } from 'node:fs';

/**
 * 18 Sep 2026 — FS 243099 / 243100 (Accounting) failed to save for half an hour
 * (a NUL byte), the sync windows moved on, and they stayed missing after the fix
 * shipped: nothing re-fetches a ticket that FreshService does not consider
 * updated. A failed save is now remembered and retried by id.
 */

const store = new Map();
const settingsMock = {
  get: jest.fn(async (key) => (store.has(key) ? store.get(key) : null)),
  set: jest.fn(async (key, value) => { store.set(key, String(value)); }),
};
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));

const {
  recordFailedUpsert, clearFailedUpsert, listFailedUpserts, retryFailedUpserts,
  MAX_TRACKED_PER_WORKSPACE, MAX_RETRIES_PER_CYCLE,
} = await import('../src/services/syncFailedUpsertRegistry.js');

const NUL_ERROR = Object.assign(new Error('Failed to upsert ticket'), { cause: new Error('invalid byte sequence for encoding "UTF8": 0x00') });

beforeEach(() => {
  store.clear();
  jest.clearAllMocks();
});

describe('recording', () => {
  test('a failed save is remembered per workspace, with the underlying cause', async () => {
    await recordFailedUpsert(2, 243099n, NUL_ERROR, new Date('2026-09-18T20:25:29Z'));
    expect(await listFailedUpserts(2)).toEqual([{
      freshserviceTicketId: '243099', firstFailedAt: '2026-09-18T20:25:29.000Z', lastFailedAt: '2026-09-18T20:25:29.000Z',
      attempts: 1, error: expect.stringContaining('0x00'),
    }]);
    expect(await listFailedUpserts(1)).toEqual([]);
    expect(store.has('sync_failed_upserts_ws2')).toBe(true);
  });

  test('the FIRST failure is an error line (the review greps for it); the 60 repeats are not', async () => {
    await recordFailedUpsert(2, 243099, NUL_ERROR);
    await recordFailedUpsert(2, 243099, NUL_ERROR);
    await recordFailedUpsert(2, 243099, NUL_ERROR);
    expect(loggerMock.error).toHaveBeenCalledTimes(1);
    expect(loggerMock.error.mock.calls[0][0]).toMatch(/243099.*could not be saved.*retried/);
    expect((await listFailedUpserts(2))[0].attempts).toBe(3);
  });

  test('firstFailedAt is kept across repeats; lastFailedAt moves', async () => {
    await recordFailedUpsert(2, 243099, NUL_ERROR, new Date('2026-09-18T20:25:00Z'));
    await recordFailedUpsert(2, 243099, NUL_ERROR, new Date('2026-09-18T20:54:00Z'));
    const [entry] = await listFailedUpserts(2);
    expect(entry.firstFailedAt).toBe('2026-09-18T20:25:00.000Z');
    expect(entry.lastFailedAt).toBe('2026-09-18T20:54:00.000Z');
  });

  test('the list is bounded, and overflowing it is loud', async () => {
    for (let i = 0; i < MAX_TRACKED_PER_WORKSPACE; i += 1) await recordFailedUpsert(2, 1000 + i, NUL_ERROR);
    loggerMock.error.mockClear();
    expect(await recordFailedUpsert(2, 9999, NUL_ERROR)).toBe(false);
    expect((await listFailedUpserts(2)).length).toBe(MAX_TRACKED_PER_WORKSPACE);
    expect(loggerMock.error.mock.calls[0][0]).toMatch(/retry list is full.*NOT being tracked/);
  });

  test('garbage ids and a broken store never throw', async () => {
    expect(await recordFailedUpsert(2, 'TP-12', NUL_ERROR)).toBe(false);
    expect(await recordFailedUpsert(null, 5, NUL_ERROR)).toBe(false);
    settingsMock.get.mockRejectedValueOnce(new Error('db down'));
    expect(await recordFailedUpsert(2, 5, NUL_ERROR)).toBe(false);
    store.set('sync_failed_upserts_ws2', '{not json');
    expect(await listFailedUpserts(2)).toEqual([]);
  });
});

describe('retrying', () => {
  test('a ticket that saves is forgotten; one that still fails stays, with one more attempt', async () => {
    await recordFailedUpsert(2, 243099, NUL_ERROR, new Date('2026-09-18T20:25:00Z'));
    await recordFailedUpsert(2, 243100, NUL_ERROR, new Date('2026-09-18T20:26:00Z'));
    const retry = jest.fn(async (id) => { if (id === '243100') throw new Error('still broken'); return 'saved'; });

    const summary = await retryFailedUpserts(2, retry, { now: new Date('2026-09-18T21:00:00Z') });
    expect(summary).toEqual({ tried: 2, saved: 1, gone: 0, stillFailing: 1, givenUp: 0 });
    const left = await listFailedUpserts(2);
    expect(left.map((e) => e.freshserviceTicketId)).toEqual(['243100']);
    expect(left[0]).toMatchObject({ attempts: 2, error: 'still broken', firstFailedAt: '2026-09-18T20:26:00.000Z' });
  });

  test('a ticket that no longer exists in FreshService is dropped, not retried forever', async () => {
    await recordFailedUpsert(2, 243099, NUL_ERROR);
    const summary = await retryFailedUpserts(2, async () => 'gone');
    expect(summary.gone).toBe(1);
    expect(await listFailedUpserts(2)).toEqual([]);
  });

  test('nothing tracked → the retry function is never called and nothing is written', async () => {
    const retry = jest.fn();
    expect((await retryFailedUpserts(2, retry)).tried).toBe(0);
    expect(retry).not.toHaveBeenCalled();
    expect(settingsMock.set).not.toHaveBeenCalled();
  });

  test('a few per cycle, least recently tried first', async () => {
    for (let i = 0; i < MAX_RETRIES_PER_CYCLE + 3; i += 1) {
      await recordFailedUpsert(2, 100 + i, NUL_ERROR, new Date(Date.UTC(2026, 8, 18, 20, i)));
    }
    const tried = [];
    const summary = await retryFailedUpserts(2, async (id) => { tried.push(id); throw new Error('no'); }, { now: new Date('2026-09-18T21:00:00Z') });
    expect(summary.tried).toBe(MAX_RETRIES_PER_CYCLE);
    expect(tried).toEqual(['100', '101', '102', '103', '104']);
    // The ones just tried move to the back; the next cycle reaches the rest.
    const next = [];
    await retryFailedUpserts(2, async (id) => { next.push(id); throw new Error('no'); }, { now: new Date('2026-09-18T21:05:00Z') });
    expect(next.slice(0, 3)).toEqual(['105', '106', '107']);
  });

  test('after seven days it gives up — loudly — instead of retrying for ever', async () => {
    await recordFailedUpsert(2, 243099, NUL_ERROR, new Date('2026-09-10T00:00:00Z'));
    loggerMock.error.mockClear();
    const retry = jest.fn();
    const summary = await retryFailedUpserts(2, retry, { now: new Date('2026-09-18T00:00:00Z') });
    expect(summary.givenUp).toBe(1);
    expect(retry).not.toHaveBeenCalled();
    expect(loggerMock.error.mock.calls[0][0]).toMatch(/giving up.*243099.*NOT in Ticket Pulse/);
    expect(await listFailedUpserts(2)).toEqual([]);
  });

  test('clearing something that is not tracked is a no-op', async () => {
    expect(await clearFailedUpsert(2, 1)).toBe(false);
    expect(settingsMock.set).not.toHaveBeenCalled();
  });
});

describe('the sync is wired to it', () => {
  const src = readFileSync(new URL('../src/services/syncService.js', import.meta.url), 'utf8');

  test('both places that swallow a failed save record it', () => {
    expect(src.match(/await recordFailedUpsert\(/g)).toHaveLength(2);
    const scheduled = src.slice(src.indexOf('async _upsertTickets(tickets)'));
    expect(scheduled.slice(0, scheduled.indexOf('return syncedCount'))).toContain('recordFailedUpsert(ticket.workspaceId, ticket.freshserviceTicketId, error)');
    const fast = src.slice(src.indexOf("'Assignment fast sync: failed to upsert ticket'"));
    expect(fast.slice(0, 400)).toContain('recordFailedUpsert(workspaceId, ticket.freshserviceTicketId, error)');
  });

  test('the scheduled sync retries right after saving its own batch, and the retry cannot throw', () => {
    const at = src.indexOf('const ticketsSynced = await this._upsertTickets(preparedTickets);');
    expect(src.slice(at, at + 500)).toContain('await this._retryFailedUpserts(workspaceId);');
    const method = src.slice(src.indexOf('async _retryFailedUpserts(workspaceId)'));
    const body = method.slice(0, method.indexOf('Batch upsert tickets to database'));
    expect(body).toMatch(/try \{[\s\S]*\} catch \(error\) \{[\s\S]*return null;/);
    expect(body).toContain("source: 'failed_upsert_retry'");
    // No notification workflows and no assignment run from a retry: the ordinary
    // poller picks the ticket up once it exists.
    expect(body).not.toContain('allowNotificationWorkflows');
  });
});
