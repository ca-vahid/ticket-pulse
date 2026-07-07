import crypto from 'node:crypto';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { webhookUrlProblem } from './notificationWorkflowActionNodes.js';

/**
 * Outbound webhooks (gap plan 2, Phase 3). Integrations subscribe per
 * workspace to ticket events; each delivery is an HMAC-SHA256-signed JSON
 * POST. Delivery is fire-and-forget with in-process retries (0s / 30s / 2m) —
 * documented as at-least-effort, not durable across restarts. Sustained
 * failure (20 consecutive) auto-disables the subscription with the error
 * visible in the admin UI.
 */

export const WEBHOOK_EVENTS = [
  'ticket.created',
  'ticket.status_changed',
  'ticket.assigned',
  'ticket.reply_received',
  'ticket.public_reply_added',
  'ticket.tags_changed',
  'approval.requested',
  'approval.decided',
];

const RETRY_DELAYS_MS = [0, 30_000, 120_000];
const AUTO_DISABLE_AFTER = 20;
const DELIVERY_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 30_000;

const subsCache = new Map(); // workspaceId -> { at, rows }

export function signWebhookPayload(secret, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

async function enabledSubscriptions(workspaceId) {
  const hit = subsCache.get(workspaceId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
  const rows = await prisma.webhookSubscription.findMany({
    where: { workspaceId, isEnabled: true },
  });
  subsCache.set(workspaceId, { at: Date.now(), rows });
  return rows;
}

export function invalidateWebhookCache(workspaceId) {
  subsCache.delete(workspaceId);
}

async function recordOutcome(sub, { ok, status = null, error = null }) {
  const entry = { at: new Date().toISOString(), ok, status, error: error ? String(error).slice(0, 200) : null };
  const recent = [entry, ...(Array.isArray(sub.recentDeliveries) ? sub.recentDeliveries : [])].slice(0, 10);
  const failureCount = ok ? 0 : (sub.failureCount || 0) + 1;
  const disable = !ok && failureCount >= AUTO_DISABLE_AFTER;
  await prisma.webhookSubscription.update({
    where: { id: sub.id },
    data: {
      lastDeliveryAt: new Date(),
      lastError: ok ? null : String(error || `HTTP ${status}`).slice(0, 500),
      failureCount,
      recentDeliveries: recent,
      ...(disable ? { isEnabled: false } : {}),
    },
  }).catch(() => {});
  if (disable) {
    invalidateWebhookCache(sub.workspaceId);
    logger.warn(`Webhook subscription ${sub.id} auto-disabled after ${failureCount} consecutive failures`);
  }
  // Keep the in-memory copy's counter honest for retries within this process.
  sub.failureCount = failureCount;
}

async function deliverOnce(sub, body, eventType) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(sub.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'TicketPulse-Webhook/1.0',
        'X-TicketPulse-Event': eventType,
        'X-TicketPulse-Signature': signWebhookPayload(sub.secret, body),
      },
      body,
      signal: controller.signal,
    });
    if (res.ok) {
      await recordOutcome(sub, { ok: true, status: res.status });
      return true;
    }
    await recordOutcome(sub, { ok: false, status: res.status, error: `HTTP ${res.status}` });
    return false;
  } catch (err) {
    await recordOutcome(sub, { ok: false, error: err.name === 'AbortError' ? 'timeout' : err.message });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function deliverWithRetries(sub, body, eventType) {
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (RETRY_DELAYS_MS[attempt] > 0) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
    if (await deliverOnce(sub, body, eventType)) return;
    if (sub.failureCount >= AUTO_DISABLE_AFTER) return; // disabled mid-retry
  }
}

/**
 * Fan an event out to matching subscriptions. Fire-and-forget: callers never
 * wait on integration endpoints.
 */
export function dispatchWebhookEvent(workspaceId, eventType, payload) {
  if (!WEBHOOK_EVENTS.includes(eventType)) return;
  enabledSubscriptions(workspaceId)
    .then((subs) => {
      const matching = subs.filter((s) => s.events.includes(eventType));
      if (!matching.length) return;
      const body = JSON.stringify({
        event: eventType,
        occurredAt: new Date().toISOString(),
        workspaceId,
        data: payload,
      });
      for (const sub of matching) {
        deliverWithRetries({ ...sub }, body, eventType).catch(() => {});
      }
    })
    .catch((err) => logger.warn(`Webhook dispatch lookup failed (non-fatal): ${err.message}`));
}

/** Admin test-ping: one immediate signed delivery, result returned inline. */
export async function testWebhookSubscription(id, workspaceId) {
  const sub = await prisma.webhookSubscription.findFirst({ where: { id, workspaceId } });
  if (!sub) return { ok: false, error: 'Subscription not found' };
  const problem = webhookUrlProblem(sub.url);
  if (problem) return { ok: false, error: problem };
  const body = JSON.stringify({
    event: 'ping',
    occurredAt: new Date().toISOString(),
    workspaceId,
    data: { message: 'Ticket Pulse webhook test' },
  });
  const ok = await deliverOnce(sub, body, 'ping');
  invalidateWebhookCache(workspaceId);
  return { ok, lastError: ok ? null : sub.lastError || 'delivery failed' };
}

export { webhookUrlProblem };
