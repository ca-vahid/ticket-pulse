import logger from '../utils/logger.js';

const DEFAULT_TTL_MS = 10_000; // 10 seconds
const MAX_ENTRIES = 200;

const store = new Map();
import { registerGauge } from './memoryDiagnostics.js';
registerGauge('dashboardRead.store', () => store.size);
const _stats = { hit: 0, miss: 0, invalidations: 0, evictions: 0, coalesced: 0 };
// key -> array of waiter callbacks for a request currently computing that key.
const inflight = new Map();

// Expired entries were only ever *skipped* on read, never removed — under
// real traffic (per-tech and per-date dashboard endpoints produce a steady
// stream of distinct keys holding multi-hundred-KB payloads) the map grew
// without bound and took the heap with it: prod reached 1.4GB heap within
// five minutes of boot (QA 07-08 slowness report). A periodic sweep plus a
// hard cap keeps this cache an actual cache.
function sweepExpired() {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.expiresAt) {
      store.delete(key);
      _stats.evictions++;
    }
  }
}
setInterval(sweepExpired, 30_000).unref();

function enforceCap() {
  if (store.size <= MAX_ENTRIES) return;
  sweepExpired();
  // Still over cap: drop oldest-inserted entries (Map preserves insertion order).
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
    _stats.evictions++;
  }
}

function makeKey(req) {
  const path = req.baseUrl + req.path;
  const params = JSON.stringify(req.query);
  const wsId = req.workspaceId || req.headers['x-workspace-id'] || '0';
  return `ws${wsId}:${path}:${params}`;
}

function isExpired(entry) {
  return Date.now() > entry.expiresAt;
}

/**
 * Express middleware factory for short-lived read caching on GET endpoints.
 * @param {number} ttlMs - Cache TTL in milliseconds (default 10s)
 */
export function readCache(ttlMs = DEFAULT_TTL_MS) {
  return (req, res, next) => {
    if (req.method !== 'GET') return next();

    const key = makeKey(req);
    const entry = store.get(key);

    if (entry && !isExpired(entry)) {
      _stats.hit++;
      logger.debug(`[ReadCache] HIT ${key}`);
      return res.json(entry.data);
    }

    // In-flight de-dup (QA 09-25): an identical request already computing
    // this key — the page, its prefetch, a second tab — waits for that one
    // instead of running the same heavy queries again. If the leader fails
    // (error status or no JSON body) each waiter falls through and computes
    // on its own.
    const pending = inflight.get(key);
    if (pending) {
      _stats.coalesced++;
      logger.debug(`[ReadCache] COALESCE ${key}`);
      pending.push((result) => {
        if (result) return res.status(result.status).json(result.data);
        return next();
      });
      return undefined;
    }

    _stats.miss++;
    logger.debug(`[ReadCache] MISS ${key}`);

    const waiters = [];
    inflight.set(key, waiters);
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (inflight.get(key) === waiters) inflight.delete(key);
      for (const wake of waiters.splice(0)) {
        try { wake(result); } catch (err) { logger.debug(`[ReadCache] waiter failed: ${err.message}`); }
      }
    };

    const originalJson = res.json.bind(res);
    res.json = (data) => {
      // Only successful bodies are cached/shared — a 4xx/5xx must not be
      // replayed to other callers for the whole TTL.
      const ok = res.statusCode < 400;
      if (ok) {
        store.set(key, { data, expiresAt: Date.now() + ttlMs });
        enforceCap();
      }
      settle(ok ? { status: res.statusCode, data } : null);
      return originalJson(data);
    };
    // Leader ended without res.json (stream, redirect, aborted socket).
    res.on('close', () => settle(null));
    res.on('finish', () => settle(null));
    next();
  };
}

/**
 * Invalidate cache entries whose key matches a predicate.
 */
export function invalidateReadCache(predFn) {
  let count = 0;
  for (const key of store.keys()) {
    if (predFn(key)) {
      store.delete(key);
      count++;
    }
  }
  // Requests arriving after an invalidation must not join a computation that
  // started before it (the leader still answers its own waiters).
  for (const key of inflight.keys()) {
    if (predFn(key)) inflight.delete(key);
  }
  if (count > 0) {
    _stats.invalidations += count;
    logger.debug(`[ReadCache] Invalidated ${count} entries`);
  }
}

/**
 * Clear entire read cache.
 */
export function clearReadCache() {
  const size = store.size;
  store.clear();
  inflight.clear();
  if (size > 0) logger.debug(`[ReadCache] Cleared ${size} entries`);
}

export function getReadCacheStats() {
  return { ..._stats, size: store.size };
}
