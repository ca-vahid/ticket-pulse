import prisma from './prisma.js';
import logger from '../utils/logger.js';

/**
 * Durable fixed-window rate limiter for the public API. Counts live in Postgres
 * (`api_rate_windows`) so limits hold across instances and survive restarts —
 * unlike the previous in-memory per-process bucket. One 60s window per bucket
 * (a bucket is a key id or a client IP); atomic upsert-increment per request.
 */

const WINDOW_SEC = 60;

/**
 * @returns {{ allowed:boolean, count:number, remaining:number, limit:number, reset:number }}
 *   reset is a unix-seconds timestamp of the window end.
 */
export async function hit(bucketKey, limit) {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowEpoch = Math.floor(nowSec / WINDOW_SEC);
  const reset = (windowEpoch + 1) * WINDOW_SEC;
  try {
    const row = await prisma.apiRateWindow.upsert({
      where: { bucketKey_windowEpoch: { bucketKey, windowEpoch } },
      create: { bucketKey, windowEpoch, count: 1 },
      update: { count: { increment: 1 } },
    });
    return { allowed: row.count <= limit, count: row.count, remaining: Math.max(0, limit - row.count), limit, reset };
  } catch (err) {
    // Never let the limiter take down the API — fail open, logged.
    logger.debug(`Rate limiter degraded (fail-open): ${err.message}`);
    return { allowed: true, count: 0, remaining: limit, limit, reset };
  }
}

/** Drop windows older than a few minutes (called by the maintenance sweep). */
export async function sweep() {
  const cutoff = Math.floor(Date.now() / 1000 / WINDOW_SEC) - 5;
  try {
    const { count } = await prisma.apiRateWindow.deleteMany({ where: { windowEpoch: { lt: cutoff } } });
    return count;
  } catch (err) {
    logger.debug(`Rate window sweep failed: ${err.message}`);
    return 0;
  }
}

export default { hit, sweep };
