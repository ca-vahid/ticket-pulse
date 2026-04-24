import logger from '../utils/logger.js';

const PRIORITIES = ['high', 'normal', 'low'];
const DEFAULT_PRIORITY = 'normal';

function normalizePriority(priority) {
  return PRIORITIES.includes(priority) ? priority : DEFAULT_PRIORITY;
}

/**
 * Token-bucket rate limiter for FreshService API calls.
 *
 * Shared per-process singleton via FreshServiceClient.
 *
 * Design:
 *  - Caps requests per 60-second sliding window
 *  - Enforces a min-delay between LAUNCH times (not completions) so we can
 *    have multiple requests in flight at once (concurrency)
 *  - Honors Retry-After on 429 via a global pause
 *  - Does NOT adapt based on x-ratelimit-remaining because that header is
 *    per-endpoint on Freshworks and caused a death spiral with /activities
 */
export class FreshServiceRateLimiter {
  constructor({
    maxRequestsPerMinute = 120,
    minDelayMs = 550,
    maxConcurrent = 3,
    highBurstLimit = 5,
  } = {}) {
    this.maxRequestsPerMinute = maxRequestsPerMinute;
    this.minDelayMs = minDelayMs;
    this.maxConcurrent = maxConcurrent;
    this.highBurstLimit = Math.max(1, highBurstLimit);
    this.recentLaunches = []; // timestamps when requests were launched
    this.inFlight = 0;        // currently in-flight requests
    this.queues = {
      high: [],
      normal: [],
      low: [],
    };                        // priority -> [{ fn, resolve, reject, priority, source }]
    this.highBurstCount = 0;
    this.processing = false;
    this.slowdownUntil = 0;   // ms timestamp for 429 Retry-After pause
    this.lastLaunchAt = 0;
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  _totalQueueDepth() {
    return this.queues.high.length + this.queues.normal.length + this.queues.low.length;
  }

  _dequeueNext() {
    const hasHigh = this.queues.high.length > 0;
    const hasNormal = this.queues.normal.length > 0;
    const hasLow = this.queues.low.length > 0;

    if (hasHigh && (this.highBurstCount < this.highBurstLimit || (!hasNormal && !hasLow))) {
      this.highBurstCount++;
      return this.queues.high.shift();
    }

    if (hasNormal) {
      this.highBurstCount = 0;
      return this.queues.normal.shift();
    }

    if (hasLow) {
      this.highBurstCount = 0;
      return this.queues.low.shift();
    }

    return null;
  }

  async enqueue(fn, options = {}) {
    return new Promise((resolve, reject) => {
      const priority = normalizePriority(options.priority);
      this.queues[priority].push({
        fn,
        resolve,
        reject,
        priority,
        source: options.source || null,
      });
      this._pump().catch((e) => logger.error('RateLimiter pump error:', e));
    });
  }

  /**
   * Continuously try to launch queued requests. Multiple launches can be
   * in-flight at once (up to maxConcurrent), but launches are spaced by
   * minDelayMs to stay under the per-minute cap and avoid burst detection.
   */
  async _pump() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this._totalQueueDepth() > 0) {
        // Block here until we're allowed to launch the next request
        await this._waitForLaunchWindow();

        // Still have an item? (someone could have drained us)
        const item = this._dequeueNext();
        if (!item) break;

        const now = Date.now();
        this.recentLaunches.push(now);
        this.lastLaunchAt = now;
        this.inFlight++;

        // Fire-and-manage: don't await here so the next iteration can launch
        // another request concurrently.
        item.fn()
          .then((result) => item.resolve(result))
          .catch((err) => item.reject(err))
          .finally(() => {
            this.inFlight--;
            // Poke the pump in case it was parked waiting on concurrency cap
            if (this._totalQueueDepth() > 0 && !this.processing) {
              this._pump().catch((e) => logger.error('RateLimiter pump error:', e));
            }
          });
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Sleep until we're permitted to launch the next request:
   *  - Not inside a 429 Retry-After window
   *  - Under maxConcurrent in-flight
   *  - Under maxRequestsPerMinute in the sliding window
   *  - At least minDelayMs since last launch
   */
  async _waitForLaunchWindow() {
    // Loop until all gates pass (each gate may sleep once)
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const now = Date.now();

      // Purge launches older than 60s
      this.recentLaunches = this.recentLaunches.filter((t) => now - t < 60000);

      // Gate 1: 429 pause
      if (this.slowdownUntil > now) {
        await this._sleep(this.slowdownUntil - now);
        continue;
      }

      // Gate 2: concurrency cap
      if (this.inFlight >= this.maxConcurrent) {
        // Short wait then re-check — an in-flight request should finish shortly
        await this._sleep(50);
        continue;
      }

      // Gate 3: per-minute cap
      if (this.recentLaunches.length >= this.maxRequestsPerMinute) {
        const oldest = this.recentLaunches[0];
        const waitMs = 60000 - (now - oldest) + 50;
        logger.debug(`RateLimiter: per-minute cap reached (${this.recentLaunches.length}/${this.maxRequestsPerMinute}), sleeping ${waitMs}ms`);
        await this._sleep(waitMs);
        continue;
      }

      // Gate 4: min-delay since last launch
      const since = now - this.lastLaunchAt;
      if (since < this.minDelayMs) {
        await this._sleep(this.minDelayMs - since);
        continue;
      }

      // All gates pass
      return;
    }
  }

  /** Observational hook — kept for diagnostics but no longer adjusts pacing. */
  onResponse(_headers) { /* intentionally empty: per-endpoint sub-limits made this misleading */ }

  /** Pause the queue when we actually hit a 429. */
  on429(headers) {
    const retryAfterSec = parseInt(headers?.['retry-after'], 10);
    const waitSec = !Number.isNaN(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 10;
    this.slowdownUntil = Math.max(this.slowdownUntil, Date.now() + waitSec * 1000);
    logger.warn(`RateLimiter: 429 — pausing queue for ${waitSec}s (Retry-After: ${retryAfterSec || 'default'}), ${this._totalQueueDepth()} queued, ${this.inFlight} in-flight`);
  }

  getStats() {
    const now = Date.now();
    const live = this.recentLaunches.filter((t) => now - t < 60000);
    const queueDepthByPriority = {
      high: this.queues.high.length,
      normal: this.queues.normal.length,
      low: this.queues.low.length,
    };
    return {
      requestsLastMinute: live.length,
      inFlight: this.inFlight,
      queueDepth: this._totalQueueDepth(),
      queueDepthByPriority,
      maxRequestsPerMinute: this.maxRequestsPerMinute,
      maxConcurrent: this.maxConcurrent,
      minDelayMs: this.minDelayMs,
      highBurstLimit: this.highBurstLimit,
      slowdownActive: this.slowdownUntil > now,
      slowdownMsLeft: Math.max(0, this.slowdownUntil - now),
    };
  }
}
