/**
 * One shared pace for background FreshService reads (6 Oct 2026).
 *
 * Two background jobs read FreshService ticket by ticket: the 15-minute
 * "is it deleted in FreshService?" check (syncService) and the 3-minute
 * comparison of Ticket Pulse tickets with their FreshService copies
 * (mirrorService.reconcile). The first was paced on 3 Oct; the second still
 * fired ~50 conversation reads in a few seconds. When the two landed in the
 * same minute FreshService answered 429 with a Retry-After of up to 24 s —
 * longer than the 15 s a person's request waits — and an agent opening a
 * ticket got errors (6 Oct, #245779).
 *
 * Both jobs now take their turn from the same slot: one call per
 * RECONCILE_MIN_GAP_MS across all of them, and each stops its batch whenever
 * the limiter says people are waiting.
 */
export const RECONCILE_MIN_GAP_MS = process.env.NODE_ENV === 'test' ? 0 : 1000;

let nextSlotAt = 0;

/** Wait for the next shared background slot. `sleep(ms)` is injected for tests. */
export async function reconcileSlot(sleep = (ms) => new Promise((r) => setTimeout(r, ms)), gapMs = RECONCILE_MIN_GAP_MS) {
  const now = Date.now();
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + gapMs;
  if (at > now) await sleep(at - now);
}

/** True when background reads should yield the FreshService budget to people. */
export function reconcileShouldYield(stats) {
  if (!stats) return false;
  if (stats.slowdownActive) return true;
  if ((stats.queueDepthByPriority?.high || 0) > 0) return true;
  const cap = Number(stats.maxRequestsPerMinute) || 0;
  return cap > 0 && Number(stats.requestsLastMinute || 0) >= cap * 0.6;
}

/** Test hook. */
export function resetReconcilePace() { nextSlotAt = 0; }
