import { jest } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Hourly review, 18 Sep 2026 — the assignment queue-drain worker ran 10 pipeline
 * runs at once against a Prisma pool that holds 9 connections, so one full batch
 * could exhaust the pool on its own. A 25-run Accounting backlog did exactly
 * that at 08:02 and 08:04 PT: two ~1 s bursts of P2024, a failed ticket update,
 * a dropped fast-sync upsert, and one user request that errored.
 *
 * The batch size (throughput per tick) is unchanged; only the parallelism is
 * bounded, and it must stay under the pool.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const readPipelineSource = () => readFile(resolve(HERE, '../src/services/assignmentPipelineService.js'), 'utf8');

const {
  PRISMA_POOL_CONNECTION_LIMIT,
  QUEUE_DRAIN_CONCURRENCY,
  QUEUE_DRAIN_MAX_PER_TICK,
  computeDrainConcurrency,
} = await import('../src/utils/queueDrainLimits.js');

describe('assignment queue-drain bounds', () => {
  test('the default concurrency stays below the Prisma pool, so a drain cannot starve it', () => {
    expect(QUEUE_DRAIN_CONCURRENCY).toBe(4);
    expect(QUEUE_DRAIN_CONCURRENCY).toBeLessThan(PRISMA_POOL_CONNECTION_LIMIT);
  });

  test('throughput per tick is unchanged — only the parallelism narrowed', () => {
    expect(QUEUE_DRAIN_MAX_PER_TICK).toBe(10);
  });

  test('a requested concurrency is capped at the batch size', () => {
    expect(computeDrainConcurrency({ maxPerTick: 10, requested: 50 })).toBe(10);
    expect(computeDrainConcurrency({ maxPerTick: 3, requested: 8 })).toBe(3);
    expect(computeDrainConcurrency({ maxPerTick: 10, requested: 6 })).toBe(6);
    expect(computeDrainConcurrency({ maxPerTick: 10, requested: 1 })).toBe(1);
  });

  test('a nonsensical override (0, negative) is treated as unset, not as "stop draining"', () => {
    expect(computeDrainConcurrency({ maxPerTick: 10, requested: 0 })).toBe(4);
    expect(computeDrainConcurrency({ maxPerTick: 10, requested: -5 })).toBe(4);
  });

  test('garbage input falls back to the safe defaults rather than 0 or NaN', () => {
    expect(computeDrainConcurrency({ maxPerTick: undefined, requested: undefined })).toBe(4);
    expect(computeDrainConcurrency({ maxPerTick: 'abc', requested: 'xyz' })).toBe(4);
    expect(computeDrainConcurrency({ maxPerTick: 10, requested: 2.7 })).toBe(2);
  });
});

describe('assignment queue-drain worker wiring', () => {
  test('the worker no longer hard-codes a batch of 10 run in parallel', async () => {
    const src = await readPipelineSource();
    expect(src).not.toMatch(/drainQueuedRuns\(ws\.id,\s*10,\s*10\)/);
    expect(src).toMatch(/drainQueuedRuns\(ws\.id,\s*QUEUE_DRAIN_MAX_PER_TICK,\s*QUEUE_DRAIN_CONCURRENCY\)/);
  });

  test('drainQueuedRuns defaults to the bounded constants, so every caller is capped', async () => {
    const src = await readPipelineSource();
    expect(src).toMatch(
      /async drainQueuedRuns\(workspaceId, maxPerTick = QUEUE_DRAIN_MAX_PER_TICK, concurrency = QUEUE_DRAIN_CONCURRENCY\)/,
    );
    expect(src).toMatch(/from '\.\.\/utils\/queueDrainLimits\.js'/);
  });
});
