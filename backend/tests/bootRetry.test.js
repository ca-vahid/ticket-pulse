import { describe, expect, test, jest } from '@jest/globals';
import { retryBoot, isTransientDbError, BOOT_RETRY_DELAYS_MS } from '../src/utils/bootRetry.js';

// 14 Sep 2026 07:21 UTC: the container booted while Azure PostgreSQL was
// restarting; initialize() failed once and the schedulers never started.
describe('boot retry — a database that is down at start-up is transient, not fatal', () => {
  test('recognises the errors a database restart produces', () => {
    const prismaInit = Object.assign(new Error("Can't reach database server at `ticket-pulse-pg.postgres.database.azure.com:5432`"), { name: 'PrismaClientInitializationError' });
    expect(isTransientDbError(prismaInit)).toBe(true);
    expect(isTransientDbError({ name: 'DatabaseError', message: 'Database error: Failed to initialize default settings', originalError: prismaInit })).toBe(true);
    expect(isTransientDbError(new Error('connect ECONNREFUSED 20.69.109.157:5432'))).toBe(true);
    expect(isTransientDbError(new Error('terminating connection due to administrator command'))).toBe(true);
    expect(isTransientDbError(new Error('the database system is starting up'))).toBe(true);
    expect(isTransientDbError(new Error('Unknown resolution reason "x"'))).toBe(false);
    expect(isTransientDbError(new TypeError('x is not a function'))).toBe(false);
  });

  test('retries a transient failure with the backoff schedule and succeeds when the database returns', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const onRetry = jest.fn();
    let calls = 0;
    const attempt = jest.fn(async () => {
      calls += 1;
      if (calls < 4) throw Object.assign(new Error("Can't reach database server"), { name: 'PrismaClientInitializationError' });
    });
    const ok = await retryBoot(attempt, { sleep, onRetry });
    expect(ok).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual(BOOT_RETRY_DELAYS_MS.slice(0, 3));
    expect(onRetry).toHaveBeenCalledTimes(3);
  });

  test('a non-transient error gives up immediately', async () => {
    const sleep = jest.fn();
    const onGiveUp = jest.fn();
    const err = new TypeError('boom');
    const ok = await retryBoot(async () => { throw err; }, { sleep, onGiveUp });
    expect(ok).toBe(false);
    expect(sleep).not.toHaveBeenCalled();
    expect(onGiveUp).toHaveBeenCalledWith(err, 1);
  });

  test('gives up after the schedule is exhausted', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const onGiveUp = jest.fn();
    const attempt = jest.fn(async () => { throw new Error('connect ECONNREFUSED 1.2.3.4:5432'); });
    const ok = await retryBoot(attempt, { sleep, onGiveUp, delays: [1, 2] });
    expect(ok).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(onGiveUp).toHaveBeenCalledWith(expect.any(Error), 3);
  });
});
