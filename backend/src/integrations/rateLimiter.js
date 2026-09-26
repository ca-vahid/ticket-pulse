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
 *  - Self-tuning cap (25 Sep 2026): the Enterprise plan allows 500 requests a
 *    minute account-wide, with per-operation sub-limits (list tickets 140,
 *    view/create/update ticket 160). The old fixed 110 used a fifth of it.
 *    The cap starts at `maxRequestsPerMinute`, drops 20% on every 429 (never
 *    below `floorPerMinute`), and after 10 quiet minutes climbs 10/min at a
 *    time back towards `ceilingPerMinute`. Per-operation caps (`classCaps`,
 *    keyed by the request's opClass) keep each sub-limit under FreshService's.
 */
export class FreshServiceRateLimiter {
  constructor({
    maxRequestsPerMinute = 120,
    minDelayMs = 550,
    maxConcurrent = 3,
    highBurstLimit = 5,
    ceilingPerMinute = null,
    floorPerMinute = null,
    classCaps = {},
  } = {}) {
    this.maxRequestsPerMinute = maxRequestsPerMinute;
    this.ceilingPerMinute = ceilingPerMinute || maxRequestsPerMinute;
    this.floorPerMinute = Math.min(floorPerMinute || maxRequestsPerMinute, maxRequestsPerMinute);
    this.classCaps = { ...classCaps };
    this.classLaunches = {};   // opClass -> [launch timestamps, last 60 s]
    this.lastThrottleAt = 0;
    this.lastRaiseAt = 0;
    this.throttles = 0;        // 429s seen (total)
    this.throttlesSinceSummary = 0;
    this.lastSummaryAt = Date.now();
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
    this.queueTimeouts = 0;   // total requests rejected for exceeding maxWaitMs
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  _totalQueueDepth() {
    return this.queues.high.length + this.queues.normal.length + this.queues.low.length;
  }

  /** Is another request of this operation class allowed in the current minute? */
  _classOpen(opClass, now = Date.now()) {
    const cap = opClass ? this.classCaps[opClass] : null;
    if (!cap) return true;
    const recent = (this.classLaunches[opClass] || []).filter((t) => now - t < 60000);
    this.classLaunches[opClass] = recent;
    return recent.length < cap;
  }

  /** First item in a queue whose operation class still has room (expired ones count as eligible — they are dropped). */
  _takeEligible(queue, now) {
    const idx = queue.findIndex((it) => it.expired || this._classOpen(it.opClass, now));
    if (idx < 0) return null;
    return queue.splice(idx, 1)[0];
  }

  _dequeueNext() {
    const now = Date.now();
    const hasHigh = this.queues.high.length > 0;
    const hasNormal = this.queues.normal.length > 0;
    const hasLow = this.queues.low.length > 0;

    if (hasHigh && (this.highBurstCount < this.highBurstLimit || (!hasNormal && !hasLow))) {
      const item = this._takeEligible(this.queues.high, now);
      if (item) {
        this.highBurstCount++;
        return item;
      }
    }

    if (hasNormal) {
      const item = this._takeEligible(this.queues.normal, now);
      if (item) {
        this.highBurstCount = 0;
        return item;
      }
    }

    if (hasLow) {
      const item = this._takeEligible(this.queues.low, now);
      if (item) {
        this.highBurstCount = 0;
        return item;
      }
    }

    // High items skipped for the burst limit still go when nothing else can.
    if (hasHigh) {
      const item = this._takeEligible(this.queues.high, now);
      if (item) return item;
    }
    return null;
  }

  /**
   * options.maxWaitMs — bound how long the request may sit in the queue
   * BEFORE launching. If it can't launch in time it is rejected with a
   * FS_QUEUE_TIMEOUT error and the underlying fn is never called, so the
   * caller knows for certain nothing reached FreshService. Used by
   * interactive (user-facing) calls so a busy sync queue produces a fast,
   * honest "busy, try again" instead of a request that hangs past the
   * hosting platform's ~230s connection kill.
   */
  async enqueue(fn, options = {}) {
    return new Promise((resolve, reject) => {
      const priority = normalizePriority(options.priority);
      const item = {
        fn,
        resolve,
        reject,
        priority,
        source: options.source || null,
        opClass: options.opClass || null,
        expired: false,
        expireTimer: null,
      };
      const maxWaitMs = Number(options.maxWaitMs);
      if (Number.isFinite(maxWaitMs) && maxWaitMs > 0) {
        item.expireTimer = setTimeout(() => {
          item.expired = true;
          this.queueTimeouts++;
          const err = new Error(
            `FreshService request timed out after ${Math.round(maxWaitMs / 1000)}s waiting in the rate-limit queue (${this._totalQueueDepth()} queued, ${this.inFlight} in-flight) — the request was never sent`,
          );
          err.code = 'FS_QUEUE_TIMEOUT';
          logger.warn(`RateLimiter: queue-wait timeout for ${item.source || 'unknown'} request`, this.getStats());
          reject(err);
        }, maxWaitMs);
        // Don't let a pending timer hold the process open.
        if (typeof item.expireTimer.unref === 'function') item.expireTimer.unref();
      }
      this.queues[priority].push(item);
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

        // Still have an item? (someone could have drained us, or every queued
        // request is of an operation class that is at its per-minute cap)
        const item = this._dequeueNext();
        if (!item) {
          if (this._totalQueueDepth() === 0) break;
          await this._sleep(250);
          continue;
        }

        // Queue-wait timeout already rejected this one — drop it without
        // burning a launch slot.
        if (item.expired) continue;
        if (item.expireTimer) clearTimeout(item.expireTimer);

        const now = Date.now();
        this.recentLaunches.push(now);
        if (item.opClass) (this.classLaunches[item.opClass] ||= []).push(now);
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
      this._retune(now);

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

  /**
   * Climb back towards the ceiling after 10 minutes without a 429, 10/min at a
   * time; log a one-line summary an hour so the review can watch the cap.
   */
  _retune(now = Date.now()) {
    if (this.maxRequestsPerMinute < this.ceilingPerMinute
      && now - this.lastThrottleAt >= 10 * 60 * 1000
      && now - this.lastRaiseAt >= 60 * 1000) {
      this.maxRequestsPerMinute = Math.min(this.ceilingPerMinute, this.maxRequestsPerMinute + 10);
      this.lastRaiseAt = now;
    }
    if (now - this.lastSummaryAt >= 60 * 60 * 1000) {
      logger.info(`RateLimiter: cap ${this.maxRequestsPerMinute}/min (floor ${this.floorPerMinute}, ceiling ${this.ceilingPerMinute}), 429s this hour ${this.throttlesSinceSummary}, queue timeouts total ${this.queueTimeouts}, launched last minute ${this.recentLaunches.length}`);
      this.lastSummaryAt = now;
      this.throttlesSinceSummary = 0;
    }
  }

  /** Observational hook — kept for diagnostics but no longer adjusts pacing. */
  onResponse(_headers) { /* intentionally empty: per-endpoint sub-limits made this misleading */ }

  /** Pause the queue when we actually hit a 429. */
  on429(headers) {
    const retryAfterSec = parseInt(headers?.['retry-after'], 10);
    const waitSec = !Number.isNaN(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 10;
    const now = Date.now();
    this.slowdownUntil = Math.max(this.slowdownUntil, now + waitSec * 1000);
    this.throttles += 1;
    this.throttlesSinceSummary += 1;
    // One cut per burst of 429s: several in-flight calls can bounce at once.
    if (now - this.lastThrottleAt > 5000) {
      this.maxRequestsPerMinute = Math.max(this.floorPerMinute, Math.floor(this.maxRequestsPerMinute * 0.8));
    }
    this.lastThrottleAt = now;
    logger.warn(`RateLimiter: 429 — pausing queue for ${waitSec}s (Retry-After: ${retryAfterSec || 'default'}), ${this._totalQueueDepth()} queued, ${this.inFlight} in-flight; cap now ${this.maxRequestsPerMinute}/min`);
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
      ceilingPerMinute: this.ceilingPerMinute,
      floorPerMinute: this.floorPerMinute,
      throttles: this.throttles,
      maxConcurrent: this.maxConcurrent,
      minDelayMs: this.minDelayMs,
      highBurstLimit: this.highBurstLimit,
      slowdownActive: this.slowdownUntil > now,
      slowdownMsLeft: Math.max(0, this.slowdownUntil - now),
      queueTimeouts: this.queueTimeouts,
    };
  }
}
