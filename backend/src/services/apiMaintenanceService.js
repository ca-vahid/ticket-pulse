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
  // Teams assistant audit log: 180 days (product decision, 5 Nov 2026). Once a day, on
  // its own so a missing table (migration not applied yet) never stops the rest.
  if (now - lastAssistantPruneAt >= ASSISTANT_PRUNE_EVERY_MS) {
    lastAssistantPruneAt = now;
    try {
      const { default: teamsAssistantSettings } = await import('./teamsAssistantSettings.js');
      const removed = await teamsAssistantSettings.prune(now);
      if (removed) logger.info(`Teams assistant: ${removed} audit row(s) older than 180 days removed`);
    } catch (err) {
      logger.debug(`Teams assistant prune failed (non-fatal): ${err.message}`);
    }
    // Mail triage decisions: 180 days too (plans/MAIL_TRIAGE_PLAN.md). Its own try, same reason.
    try {
      const { default: mailTriageService } = await import('./mailTriageService.js');
      const removed = await mailTriageService.prune(now);
      if (removed) logger.info(`Mail triage: ${removed} decision row(s) older than 180 days removed`);
    } catch (err) {
      logger.debug(`Mail triage prune failed (non-fatal): ${err.message}`);
    }
  }
}

const ASSISTANT_PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
let lastAssistantPruneAt = 0;

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => { sweep().catch(() => {}); }, SWEEP_MS);
  timer.unref?.();
  logger.info('API maintenance sweep started');
}

export default { start, sweep };
export { start, sweep };
