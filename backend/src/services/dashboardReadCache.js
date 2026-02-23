import logger from '../utils/logger.js';

const DEFAULT_TTL_MS = 10_000; // 10 seconds

const store = new Map();
const _stats = { hit: 0, miss: 0, invalidations: 0 };

function makeKey(req) {
  const path = req.baseUrl + req.path;
  const params = JSON.stringify(req.query);
  return `${path}:${params}`;
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

    _stats.miss++;
    logger.debug(`[ReadCache] MISS ${key}`);

    const originalJson = res.json.bind(res);
    res.json = (data) => {
      store.set(key, { data, expiresAt: Date.now() + ttlMs });
      return originalJson(data);
    };
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
  if (size > 0) logger.debug(`[ReadCache] Cleared ${size} entries`);
}

export function getReadCacheStats() {
  return { ..._stats, size: store.size };
}
