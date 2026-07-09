import v8 from 'node:v8';
import logger from '../utils/logger.js';

/**
 * Leak-hunting instrumentation (Jul 9). Prod OOM-crashes every ~84 minutes
 * (FATAL: Reached heap limit) at a constant ~3.5 MB/min growth rate that is
 * traffic-independent — i.e. a background worker retains memory each tick.
 * v3.0.23 capped the request-facing caches, so the culprit is elsewhere.
 *
 * Modules register their internal collections here; the snapshot exposes each
 * size via /health and a 5-minute log line. Whichever counter climbs in step
 * with heapUsed is the leak. Registration is cheap (a name and a () => number)
 * — keep entries after the hunt; they make the next leak a 5-minute diagnosis.
 */
const gauges = new Map(); // name -> () => number

export function registerGauge(name, fn) {
  gauges.set(name, fn);
}

export function snapshot() {
  const mem = process.memoryUsage();
  const heap = v8.getHeapStatistics();
  const out = {
    rssMB: Math.round(mem.rss / 1024 / 1024),
    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
    externalMB: Math.round(mem.external / 1024 / 1024),
    arrayBuffersMB: Math.round(mem.arrayBuffers / 1024 / 1024),
    heapLimitMB: Math.round(heap.heap_size_limit / 1024 / 1024),
    nativeContexts: heap.number_of_native_contexts,
    detachedContexts: heap.number_of_detached_contexts,
    collections: {},
  };
  for (const [name, fn] of gauges) {
    try {
      out.collections[name] = fn();
    } catch {
      out.collections[name] = -1;
    }
  }
  return out;
}

let timer = null;
export function startMemoryDiagnostics({ intervalMs = 5 * 60 * 1000 } = {}) {
  if (timer) return;
  timer = setInterval(() => {
    try {
      const s = snapshot();
      logger.info(`[mem] heap=${s.heapUsedMB}MB/${s.heapLimitMB}MB rss=${s.rssMB}MB ext=${s.externalMB}MB ctx=${s.nativeContexts}/${s.detachedContexts} ${Object.entries(s.collections).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    } catch (err) {
      logger.warn(`[mem] snapshot failed: ${err.message}`);
    }
  }, intervalMs);
  timer.unref?.();
  logger.info('Memory diagnostics started (every 5m)');
}
