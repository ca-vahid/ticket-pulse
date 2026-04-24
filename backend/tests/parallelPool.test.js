import { jest } from '@jest/globals';
import { runJobsInPool } from '../src/utils/parallelPool.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('runJobsInPool', () => {
  test('processes every job once when all succeed', async () => {
    const jobs = [1, 2, 3, 4, 5, 6, 7];
    const seen = [];
    await runJobsInPool(jobs, async (j) => { seen.push(j); }, { poolSize: 3 });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test('respects pool size — never exceeds in-flight cap', async () => {
    const jobs = Array.from({ length: 20 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;
    await runJobsInPool(
      jobs,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await wait(10);
        inFlight -= 1;
      },
      { poolSize: 4 },
    );
    expect(peak).toBeLessThanOrEqual(4);
    // With 20 jobs at 10ms each and pool=4, peak should actually hit 4
    expect(peak).toBe(4);
  });

  test('runs in parallel — total time is jobs/poolSize * job latency, not jobs * latency', async () => {
    const jobs = Array.from({ length: 8 }, (_, i) => i);
    const start = Date.now();
    await runJobsInPool(jobs, async () => { await wait(40); }, { poolSize: 4 });
    const elapsed = Date.now() - start;
    // 8 jobs / 4 workers * 40ms = 80ms expected; allow generous slack for CI
    expect(elapsed).toBeLessThan(8 * 40); // strictly faster than sequential
    expect(elapsed).toBeGreaterThanOrEqual(70);
  });

  test('one failing job does not block siblings (default error handling swallows)', async () => {
    const jobs = [1, 2, 3, 4, 5];
    const seen = [];
    await runJobsInPool(
      jobs,
      async (j) => {
        if (j === 3) throw new Error('boom');
        seen.push(j);
      },
      { poolSize: 2 },
    );
    expect(seen.sort()).toEqual([1, 2, 4, 5]);
  });

  test('onError callback receives non-cancellation errors with their job', async () => {
    const errors = [];
    await runJobsInPool(
      [1, 2, 3],
      async (j) => { if (j === 2) throw new Error(`fail-${j}`); },
      {
        poolSize: 2,
        onError: (err, job) => errors.push({ msg: err.message, job }),
      },
    );
    expect(errors).toEqual([{ msg: 'fail-2', job: 2 }]);
  });

  test('cancellation error stops the pool and propagates to caller', async () => {
    const jobs = Array.from({ length: 20 }, (_, i) => i);
    let processed = 0;
    class CancelError extends Error {
      constructor() { super('cancel'); this.name = 'CancelError'; }
    }
    const isCancellationError = (err) => err instanceof CancelError;

    await expect(
      runJobsInPool(
        jobs,
        async (j) => {
          processed += 1;
          // Throw cancellation on the 3rd job
          if (j === 2) throw new CancelError();
          await wait(5);
        },
        { poolSize: 2, isCancellationError },
      ),
    ).rejects.toBeInstanceOf(CancelError);

    // Some jobs may already have started before cancellation propagated,
    // but we should never have processed all 20.
    expect(processed).toBeLessThan(20);
  });

  test('cancellation re-throws even if onError is provided', async () => {
    const onError = jest.fn();
    class CancelError extends Error {
      constructor() { super('cancel'); }
    }
    await expect(
      runJobsInPool(
        [1, 2, 3],
        async () => { throw new CancelError(); },
        {
          poolSize: 1,
          isCancellationError: () => true,
          onError,
        },
      ),
    ).rejects.toBeInstanceOf(CancelError);
    // onError should NOT be called for cancellation — only for normal failures
    expect(onError).not.toHaveBeenCalled();
  });

  test('empty jobs array resolves immediately', async () => {
    const runner = jest.fn();
    await expect(runJobsInPool([], runner)).resolves.toBeUndefined();
    expect(runner).not.toHaveBeenCalled();
  });

  test('non-array input is treated as empty (defensive)', async () => {
    await expect(runJobsInPool(null, async () => {})).resolves.toBeUndefined();
    await expect(runJobsInPool(undefined, async () => {})).resolves.toBeUndefined();
  });

  test('pool size larger than job count is clamped to job count', async () => {
    const seen = [];
    await runJobsInPool([1, 2], async (j) => { seen.push(j); }, { poolSize: 100 });
    expect(seen.sort()).toEqual([1, 2]);
  });

  test('pool size of 1 is effectively sequential', async () => {
    const order = [];
    await runJobsInPool(
      [1, 2, 3, 4],
      async (j) => {
        order.push(`start-${j}`);
        await wait(5);
        order.push(`end-${j}`);
      },
      { poolSize: 1 },
    );
    // With poolSize=1, jobs are strictly serial
    expect(order).toEqual([
      'start-1', 'end-1',
      'start-2', 'end-2',
      'start-3', 'end-3',
      'start-4', 'end-4',
    ]);
  });

  test('errors thrown from onError itself are swallowed (does not break the pool)', async () => {
    await expect(
      runJobsInPool(
        [1, 2, 3],
        async () => { throw new Error('job-fail'); },
        {
          poolSize: 2,
          onError: () => { throw new Error('handler-fail'); },
        },
      ),
    ).resolves.toBeUndefined();
  });
});
