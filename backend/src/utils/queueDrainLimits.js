/**
 * Bounds for the assignment queue-drain worker.
 *
 * Pure and dependency-free on purpose: assignmentPipelineService pulls in the
 * whole pipeline graph (LLM clients, FreshService, repositories), so a test
 * that only wants these numbers cannot import it without dragging all of that
 * into Jest — the same reason approvalTiers.js and fastSyncCron.js exist.
 *
 * Why a bound at all (hourly review, 18 Sep 2026): the worker executed 10
 * queued pipeline runs at once while Prisma's pool on this instance holds 9
 * connections (2 x CPU + 1) with a 10 s acquire timeout. Every run in flight
 * takes a connection for each read and write it makes, so one full batch could
 * exhaust the pool by itself and starve the sync sweeps beside it. A 25-run
 * Accounting backlog did exactly that at 08:02 and 08:04 PT: two ~1 s bursts of
 * P2024, a failed ticket update, a dropped fast-sync upsert, and one user
 * request that errored. mirrorService already bounds its own drain at 4.
 *
 * The batch size — how much work a tick gets through — is unchanged. Only the
 * parallelism narrows.
 */

/** Prisma's pool size on this instance, for documentation and tests. */
export const PRISMA_POOL_CONNECTION_LIMIT = 9;

const toPositiveInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/**
 * Cap a requested concurrency at the batch size — running more workers than the
 * batch holds buys nothing. A missing, zero, negative or non-numeric request is
 * treated as unset and falls back to the default rather than stalling the drain.
 */
export function computeDrainConcurrency({ maxPerTick, requested }) {
  const batch = toPositiveInt(maxPerTick, 10);
  const want = toPositiveInt(requested, 4);
  return Math.max(1, Math.min(batch, want));
}

export const QUEUE_DRAIN_MAX_PER_TICK = toPositiveInt(process.env.ASSIGNMENT_QUEUE_DRAIN_MAX_PER_TICK, 10);

export const QUEUE_DRAIN_CONCURRENCY = computeDrainConcurrency({
  maxPerTick: QUEUE_DRAIN_MAX_PER_TICK,
  requested: process.env.ASSIGNMENT_QUEUE_DRAIN_CONCURRENCY,
});

export default { PRISMA_POOL_CONNECTION_LIMIT, computeDrainConcurrency, QUEUE_DRAIN_MAX_PER_TICK, QUEUE_DRAIN_CONCURRENCY };
