import logger from '../utils/logger.js';

/**
 * Token-bucket rate limiter for FreshService API calls.
 *
 * Shared across all callsites via a single instance on FreshServiceClient.
 *
 * Rules:
 *  - Cap per-minute requests (default 110, well under FS's 140/min)
 *  - Enforce min delay between requests to dodge burst detection
 *  - Adapt based on `x-ratelimit-remaining` header (slow down near the edge)
 *  - Honor `Retry-After` header on 429
 */
export class FreshServiceRateLimiter {
  constructor({ maxRequestsPerMinute = 110, minDelayMs = 550, slowDelayMs = 1500 } = {}) {
    this.maxRequestsPerMinute = maxRequestsPerMinute;
    this.baseMinDelayMs = minDelayMs;
    this.minDelayMs = minDelayMs;
    this.slowDelayMs = slowDelayMs;
    this.recentRequests = []; // timestamps (ms)
    this.queue = [];
    this.processing = false;
    this.slowdownUntil = 0; // ms timestamp
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._drain().catch((e) => logger.error('Rate limiter drain error:', e));
    });
  }

  async _drain() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        await this._throttle();
        const { fn, resolve, reject } = this.queue.shift();
        this.recentRequests.push(Date.now());
        try {
          const result = await fn();
          resolve(result);
        } catch (err) {
          reject(err);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  async _throttle() {
    const now = Date.now();

    // Purge requests older than 60s
    this.recentRequests = this.recentRequests.filter((t) => now - t < 60000);

    // Honor explicit slowdown window (from 429 Retry-After)
    if (this.slowdownUntil > now) {
      await this._sleep(this.slowdownUntil - now);
      return this._throttle();
    }

    // If at per-minute cap, wait until oldest falls outside the window
    if (this.recentRequests.length >= this.maxRequestsPerMinute) {
      const oldest = this.recentRequests[0];
      const waitMs = 60000 - (now - oldest) + 100;
      logger.warn(`RateLimiter: per-minute cap reached (${this.recentRequests.length}), sleeping ${waitMs}ms`);
      await this._sleep(waitMs);
      return this._throttle();
    }

    // Min-delay between requests
    if (this.recentRequests.length > 0) {
      const last = this.recentRequests[this.recentRequests.length - 1];
      const since = now - last;
      if (since < this.minDelayMs) {
        await this._sleep(this.minDelayMs - since);
      }
    }
  }

  /**
   * Call after a successful response to adapt pacing.
   * Reads `x-ratelimit-remaining` / `x-ratelimit-total` and slows down if near edge.
   */
  onResponse(headers) {
    if (!headers) return;
    const remaining = parseInt(headers['x-ratelimit-remaining'], 10);
    const total = parseInt(headers['x-ratelimit-total'], 10);
    if (!Number.isNaN(remaining) && !Number.isNaN(total) && total > 0) {
      const ratio = remaining / total;
      if (ratio < 0.15) {
        // Very close to cap — slow way down
        this.minDelayMs = this.slowDelayMs;
      } else if (ratio < 0.3) {
        // Getting close — moderate slowdown
        this.minDelayMs = Math.max(this.baseMinDelayMs + 400, 900);
      } else {
        // Healthy — baseline
        this.minDelayMs = this.baseMinDelayMs;
      }
    }
  }

  /**
   * Call on a 429 response to respect Retry-After.
   * Applies a global slowdown so the whole queue waits.
   */
  on429(headers) {
    const retryAfterSec = parseInt(headers?.['retry-after'], 10);
    const waitSec = !Number.isNaN(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 10;
    this.slowdownUntil = Math.max(this.slowdownUntil, Date.now() + waitSec * 1000);
    // Also bump the min delay so subsequent calls are spaced out
    this.minDelayMs = this.slowDelayMs;
    logger.warn(`RateLimiter: 429 received, pausing queue for ${waitSec}s (Retry-After: ${retryAfterSec || 'default'})`);
  }

  getStats() {
    const now = Date.now();
    const live = this.recentRequests.filter((t) => now - t < 60000);
    return {
      requestsLastMinute: live.length,
      queueDepth: this.queue.length,
      minDelayMs: this.minDelayMs,
      slowdownActive: this.slowdownUntil > now,
    };
  }
}
