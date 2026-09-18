import { jest, describe, expect, test } from '@jest/globals';

jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const { DbPoolWatchdog, isPoolTimeout } = await import('../src/services/dbPoolWatchdog.js');

const poolError = () => Object.assign(new Error('Timed out fetching a new connection from the connection pool. More info: http://pris.ly/d/connection-pool'), { code: 'P2024' });
const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

describe('DB pool watchdog (17 Sep 2026 wedge)', () => {
  test('recognises P2024 by code and by message', () => {
    expect(isPoolTimeout(poolError())).toBe(true);
    expect(isPoolTimeout(new Error('Timed out fetching a new connection from the connection pool'))).toBe(true);
    expect(isPoolTimeout(new Error('connect ECONNREFUSED'))).toBe(false);
    expect(isPoolTimeout(null)).toBe(false);
  });

  test('four consecutive pool timeouts → exit(1); a success in between resets', async () => {
    const exit = jest.fn();
    const prisma = { $queryRawUnsafe: jest.fn() };
    const wd = new DbPoolWatchdog({ prisma, failuresToExit: 4, exit, log, probeTimeoutMs: 1000 });
    prisma.$queryRawUnsafe.mockRejectedValueOnce(poolError()).mockRejectedValueOnce(poolError()).mockResolvedValueOnce([{ 1: 1 }]);
    expect(await wd.tick()).toBe(1);
    expect(await wd.tick()).toBe(2);
    expect(await wd.tick()).toBe(0);
    expect(exit).not.toHaveBeenCalled();
    prisma.$queryRawUnsafe.mockRejectedValue(poolError());
    await wd.tick(); await wd.tick(); await wd.tick();
    expect(exit).not.toHaveBeenCalled();
    await wd.tick();
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/wedged for 4 consecutive/));
  });

  test('a non-pool failure (DB down, network) is not counted', async () => {
    const exit = jest.fn();
    const prisma = { $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432')) };
    const wd = new DbPoolWatchdog({ prisma, failuresToExit: 2, exit, log, probeTimeoutMs: 1000 });
    for (let i = 0; i < 5; i++) expect(await wd.tick()).toBe(0);
    expect(exit).not.toHaveBeenCalled();
  });

  test('a probe that never answers counts as a pool timeout', async () => {
    const exit = jest.fn();
    const prisma = { $queryRawUnsafe: jest.fn(() => new Promise(() => {})) };
    const wd = new DbPoolWatchdog({ prisma, failuresToExit: 1, exit, log, probeTimeoutMs: 20 });
    await wd.tick();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
