import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { sweep as sweepRateWindows } from './apiRateLimitService.js';

/**
 * Periodic housekeeping for the public API: expire idempotency-key replays,
 * drop stale rate-limit windows, and trim old webhook-delivery + request-log
 * rows so those tables stay bounded.
 */

const SWEEP_MS = 5 * 60 * 1000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const ALERT_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CHANNEL_HEALTH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

async function sweep() {
  const now = Date.now();
  try {
    await prisma.apiIdempotencyKey.deleteMany({ where: { createdAt: { lt: new Date(now - IDEMPOTENCY_TTL_MS) } } });
    await sweepRateWindows();
    // Only prune terminal deliveries; keep pending ones regardless of age.
    await prisma.webhookDelivery.deleteMany({ where: { status: { in: ['success', 'dead'] }, createdAt: { lt: new Date(now - DELIVERY_RETENTION_MS) } } });
    await prisma.apiRequestLog.deleteMany({ where: { createdAt: { lt: new Date(now - REQUEST_LOG_RETENTION_MS) } } });
    // Prune only SENT agent-alert events (pending ones are the dedup memory and
    // must survive); trim the per-send channel-health telemetry by age.
    await prisma.agentAlertEvent.deleteMany({ where: { sentAt: { not: null, lt: new Date(now - ALERT_EVENT_RETENTION_MS) } } });
    await prisma.notificationChannelHealthEvent.deleteMany({ where: { createdAt: { lt: new Date(now - CHANNEL_HEALTH_RETENTION_MS) } } });
  } catch (err) {
    logger.debug(`API maintenance sweep failed (non-fatal): ${err.message}`);
  }
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => { sweep().catch(() => {}); }, SWEEP_MS);
  timer.unref?.();
  logger.info('API maintenance sweep started');
}

export default { start, sweep };
export { start, sweep };
