import { formatDateLocal } from '../utils/dateHelpers';

// ---------------------------------------------------------------------------
// Cache Key Factory
// ---------------------------------------------------------------------------

function normalizeDateParam(date) {
  if (!date) return 'today';
  if (typeof date === 'string') return date;
  return formatDateLocal(date);
}

export const cacheKeys = {
  dailyDashboard: (tz, date) =>
    `dashboard:daily:tz=${tz}:date=${normalizeDateParam(date)}`,

  weeklyStats: (tz, weekStart) =>
    `dashboard:weekStats:tz=${tz}:weekStart=${normalizeDateParam(weekStart)}`,

  weeklyDashboard: (tz, weekStart) =>
    `dashboard:weekly:tz=${tz}:weekStart=${normalizeDateParam(weekStart)}`,

  monthlyDashboard: (tz, monthStart) =>
    `dashboard:monthly:tz=${tz}:monthStart=${normalizeDateParam(monthStart)}`,

  techDaily: (id, tz, date) =>
    `tech:daily:id=${id}:tz=${tz}:date=${normalizeDateParam(date)}`,

  techWeekly: (id, tz, weekStart) =>
    `tech:weekly:id=${id}:tz=${tz}:weekStart=${normalizeDateParam(weekStart)}`,

  techCSAT: (id) =>
    `tech:csat:id=${id}`,
};

// ---------------------------------------------------------------------------
// TTL Presets (milliseconds)
// ---------------------------------------------------------------------------

export const TTL = {
  TODAY:      30_000,
  TODAY_SOFT: 15_000,
  HIST:       5 * 60_000,
  HIST_SOFT:  2 * 60_000,
  TECH:       2 * 60_000,
  TECH_SOFT:  45_000,
  CSAT:       5 * 60_000,
  CSAT_SOFT:  2 * 60_000,
};

export function policyForDate(dateParam) {
  const isToday = !dateParam
    || dateParam === 'today'
    || (typeof dateParam === 'string' && dateParam === formatDateLocal(new Date()));
  return isToday
    ? { ttl: TTL.TODAY, softTtl: TTL.TODAY_SOFT }
    : { ttl: TTL.HIST, softTtl: TTL.HIST_SOFT };
}

export const TECH_POLICY   = { ttl: TTL.TECH, softTtl: TTL.TECH_SOFT };
export const CSAT_POLICY   = { ttl: TTL.CSAT, softTtl: TTL.CSAT_SOFT };

// ---------------------------------------------------------------------------
// DataCache — race-safe, LRU, stale-while-revalidate, request-deduped
// ---------------------------------------------------------------------------

const MAX_ENTRIES = 100;

let _globalSeq = 0;

class DataCache {
  constructor() {
    this._store = new Map();          // key → CacheEntry
    this._accessOrder = [];           // LRU tracker (most-recent last)
    this._listeners = new Set();      // change listeners
    this._stats = { hit: 0, miss: 0, stale: 0, prefetchHit: 0, prefetchWaste: 0 };
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Get cached data or fetch it. Returns { data, seq, isStale }.
   * If stale data exists, returns it immediately and revalidates in background.
   */
  async getOrFetch(key, fetchFn, { ttl, softTtl } = {}) {
    const now = Date.now();
    const entry = this._store.get(key);

    // Fresh hit
    if (entry?.data && now < entry.softExpiresAt) {
      this._touch(key);
      this._stats.hit++;
      return { data: entry.data, seq: entry.seq, isStale: false };
    }

    // Stale hit — return old data, revalidate in background
    if (entry?.data && now < entry.expiresAt) {
      this._touch(key);
      this._stats.stale++;
      if (!entry.promise) {
        entry.promise = this._doFetch(key, fetchFn, ttl, softTtl);
      }
      return { data: entry.data, seq: entry.seq, isStale: true };
    }

    // Expired or missing — must fetch
    // Dedupe: if a fetch is already in-flight, piggyback on it
    if (entry?.promise) {
      const data = await entry.promise;
      const latest = this._store.get(key);
      return { data: latest?.data ?? data, seq: latest?.seq ?? 0, isStale: false };
    }

    this._stats.miss++;
    const promise = this._doFetch(key, fetchFn, ttl, softTtl);
    this._setPromise(key, promise);
    const data = await promise;
    const latest = this._store.get(key);
    return { data: latest?.data ?? data, seq: latest?.seq ?? 0, isStale: false };
  }

  /**
   * Non-blocking cache warm. Resolves silently; errors are swallowed.
   */
  prefetch(key, fetchFn, { ttl, softTtl } = {}) {
    const now = Date.now();
    const entry = this._store.get(key);
    if (entry?.data && now < entry.softExpiresAt) {
      return; // already fresh
    }
    if (entry?.promise) {
      return; // already in-flight
    }
    this._doFetch(key, fetchFn, ttl, softTtl).catch(() => {});
  }

  /**
   * Peek at cached data without triggering a fetch. Returns data or null.
   */
  peek(key) {
    const entry = this._store.get(key);
    if (!entry?.data) return null;
    if (Date.now() > entry.expiresAt) return null;
    return entry.data;
  }

  /**
   * Invalidate entries whose key satisfies the predicate.
   */
  invalidateByPredicate(predFn) {
    const keysToDelete = [];
    for (const key of this._store.keys()) {
      if (predFn(key)) keysToDelete.push(key);
    }
    keysToDelete.forEach(k => this._store.delete(k));
    this._accessOrder = this._accessOrder.filter(k => !keysToDelete.includes(k));
    if (keysToDelete.length > 0) this._notify();
  }

  /**
   * Invalidate specific keys.
   */
  invalidateByKeys(keys) {
    let any = false;
    for (const k of keys) {
      if (this._store.delete(k)) any = true;
    }
    if (any) {
      this._accessOrder = this._accessOrder.filter(k => this._store.has(k));
      this._notify();
    }
  }

  /**
   * Clear entire cache.
   */
  clear() {
    this._store.clear();
    this._accessOrder = [];
    this._notify();
  }

  /**
   * Subscribe to cache changes (invalidations). Returns unsubscribe fn.
   */
  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  get stats() {
    return { ...this._stats };
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  async _doFetch(key, fetchFn, ttl = TTL.HIST, softTtl = TTL.HIST_SOFT) {
    const promise = fetchFn();
    this._setPromise(key, promise);
    try {
      const data = await promise;
      const now = Date.now();
      const seq = ++_globalSeq;
      this._store.set(key, {
        data,
        fetchedAt: now,
        expiresAt: now + ttl,
        softExpiresAt: now + softTtl,
        promise: null,
        seq,
      });
      this._touch(key);
      this._evictIfNeeded();
      return data;
    } catch (err) {
      // On error, clear the in-flight promise so next call retries
      const entry = this._store.get(key);
      if (entry) entry.promise = null;
      throw err;
    }
  }

  _setPromise(key, promise) {
    const entry = this._store.get(key);
    if (entry) {
      entry.promise = promise;
    } else {
      this._store.set(key, {
        data: null,
        fetchedAt: 0,
        expiresAt: 0,
        softExpiresAt: 0,
        promise,
        seq: 0,
      });
      this._touch(key);
    }
  }

  _touch(key) {
    const idx = this._accessOrder.indexOf(key);
    if (idx !== -1) this._accessOrder.splice(idx, 1);
    this._accessOrder.push(key);
  }

  _evictIfNeeded() {
    while (this._store.size > MAX_ENTRIES && this._accessOrder.length > 0) {
      const oldest = this._accessOrder.shift();
      this._store.delete(oldest);
    }
  }

  _notify() {
    for (const fn of this._listeners) {
      try { fn(); } catch (_) { /* listener error ignored */ }
    }
  }
}

// Singleton instance shared across the app
export const dataCache = new DataCache();
