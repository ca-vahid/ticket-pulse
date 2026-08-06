import crypto from 'node:crypto';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { webhookUrlProblem } from './notificationWorkflowActionNodes.js';

/**
 * Outbound webhooks — durable, Standard-Webhooks-signed delivery.
 *
 * dispatchWebhookEvent() enqueues one row per matching subscription into the
 * `webhook_deliveries` outbox; a background worker drains due rows with
 * exponential backoff (survives restarts) and dead-letters after maxAttempts.
 * Each delivery is signed per the Standard Webhooks spec (webhook-id /
 * -timestamp / -signature over `id.timestamp.body`), with the legacy
 * X-TicketPulse-Signature sent in parallel during migration. Sustained failure
 * (20 consecutive across a subscription) auto-disables it.
 */

export const WEBHOOK_EVENTS = [
  'ticket.created',
  'ticket.status_changed',
  'ticket.assigned',
  'ticket.reply_received',
  'ticket.public_reply_added',
  'ticket.tags_changed',
  'ticket.custom_fields_changed',
  'approval.requested',
  'approval.decided',
];

// Backoff per attempt index (seconds): immediate, 15s, 1m, 5m, 30m, 2h, 6h, 12h.
const BACKOFF_SEC = [0, 15, 60, 300, 1800, 7200, 21600, 43200];
const MAX_ATTEMPTS = 8;
const AUTO_DISABLE_AFTER = 20;
const DELIVERY_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 30_000;
const TICK_MS = 5_000;
const BATCH = 20;

const subsCache = new Map(); // workspaceId -> { at, rows }
import('./memoryDiagnostics.js').then(({ registerGauge }) => registerGauge('webhookDispatch.subs', () => subsCache.size)).catch(() => {});

// Legacy HMAC (hex over raw body) — kept for one migration cycle.
export function signWebhookPayload(secret, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

// Standard Webhooks signature: base64 HMAC-SHA256 over `id.timestamp.body`,
// keyed by the base64-decoded bytes of the `whsec_`-prefixed secret.
export function signStandardWebhook(secret, msgId, timestampSec, body) {
  const raw = String(secret || '').replace(/^whsec_/, '');
  let key;
  try { key = Buffer.from(raw, 'base64'); } catch { key = Buffer.from(raw); }
  if (!key.length) key = Buffer.from(raw);
  const sig = crypto.createHmac('sha256', key).update(`${msgId}.${timestampSec}.${body}`).digest('base64');
  return `v1,${sig}`;
}

// Grace window during which a rotated-away secret still signs alongside the new
// one, so consumers that haven't switched keep verifying (Standard Webhooks
// permits multiple space-separated signatures in the header).
const SECRET_GRACE_MS = 24 * 60 * 60 * 1000;
export function standardWebhookHeader(sub, msgId, timestampSec, body) {
  const sigs = [signStandardWebhook(sub.secret, msgId, timestampSec, body)];
  if (sub.secretPrevious && sub.secretRotatedAt
      && Date.now() - new Date(sub.secretRotatedAt).getTime() < SECRET_GRACE_MS) {
    sigs.push(signStandardWebhook(sub.secretPrevious, msgId, timestampSec, body));
  }
  return sigs.join(' ');
}

async function enabledSubscriptions(workspaceId) {
  const hit = subsCache.get(workspaceId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
  const rows = await prisma.webhookSubscription.findMany({ where: { workspaceId, isEnabled: true } });
  subsCache.set(workspaceId, { at: Date.now(), rows });
  return rows;
}

export function invalidateWebhookCache(workspaceId) {
  subsCache.delete(workspaceId);
}

/** Enqueue an event to every matching subscription (durable). Fire-and-forget. */
export function dispatchWebhookEvent(workspaceId, eventType, payload) {
  if (!WEBHOOK_EVENTS.includes(eventType)) return;
  enabledSubscriptions(workspaceId)
    .then(async (subs) => {
      const matching = subs.filter((s) => s.events.includes(eventType));
      if (!matching.length) return;
      const occurredAt = new Date().toISOString();
      await prisma.webhookDelivery.createMany({
        data: matching.map((sub) => ({
          subscriptionId: sub.id,
          workspaceId,
          eventId: `msg_${crypto.randomBytes(12).toString('base64url')}`,
          eventType,
          payload: { type: eventType, event: eventType, timestamp: occurredAt, workspaceId, data: payload },
          status: 'pending',
          nextAttemptAt: new Date(),
          maxAttempts: MAX_ATTEMPTS,
        })),
      });
      setTimeout(() => { processDue().catch(() => {}); }, 50);
    })
    .catch((err) => logger.warn(`Webhook enqueue failed (non-fatal): ${err.message}`));
}

async function sendHttp(sub, delivery) {
  // Re-validate on EVERY delivery, not just at create/test time: an endpoint
  // that was public when registered can 302 to an internal address, and this
  // worker follows it. redirect:'error' refuses the redirect; the URL check
  // blocks a directly-private target.
  const urlProblem = webhookUrlProblem(sub.url);
  if (urlProblem) return { ok: false, status: null, error: `blocked: ${urlProblem}` };
  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify(delivery.payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(sub.url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'TicketPulse-Webhook/2.0',
        'webhook-id': delivery.eventId,
        'webhook-timestamp': String(ts),
        'webhook-signature': standardWebhookHeader(sub, delivery.eventId, ts, body),
        'X-TicketPulse-Event': delivery.eventType,
        'X-TicketPulse-Signature': signWebhookPayload(sub.secret, body),
      },
      body,
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: null, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function recordSubOutcome(sub, { ok, status, error }) {
  const entry = { at: new Date().toISOString(), ok, status: status || null, error: error ? String(error).slice(0, 200) : null };
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
      ...(disable ? { isEnabled: false, disabledReason: `Auto-disabled after ${failureCount} consecutive failures` } : {}),
    },
  }).catch(() => {});
  if (disable) {
    invalidateWebhookCache(sub.workspaceId);
    logger.warn(`Webhook subscription ${sub.id} auto-disabled after ${failureCount} consecutive failures`);
  }
}

async function processOne(delivery) {
  const sub = await prisma.webhookSubscription.findUnique({ where: { id: delivery.subscriptionId } });
  if (!sub) { await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { status: 'dead', lastError: 'subscription deleted' } }).catch(() => {}); return; }
  if (!sub.isEnabled) { await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { status: 'dead', lastError: 'subscription disabled' } }).catch(() => {}); return; }
  const result = await sendHttp(sub, delivery);
  const attempts = delivery.attempts + 1;
  if (result.ok) {
    await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { status: 'success', attempts, lastStatusCode: result.status, deliveredAt: new Date() } });
    await recordSubOutcome(sub, result);
    return;
  }
  if (attempts >= (delivery.maxAttempts || MAX_ATTEMPTS)) {
    await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { status: 'dead', attempts, lastStatusCode: result.status, lastError: String(result.error || '').slice(0, 500) } });
    await recordSubOutcome(sub, result);
    return;
  }
  const delaySec = BACKOFF_SEC[Math.min(attempts, BACKOFF_SEC.length - 1)];
  await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: { status: 'pending', attempts, lastStatusCode: result.status, lastError: String(result.error || '').slice(0, 500), nextAttemptAt: new Date(Date.now() + delaySec * 1000) },
  });
  // Only count toward auto-disable on a fully-dead delivery, not each retry.
}

let running = false;
export async function processDue() {
  if (running) return;
  running = true;
  try {
    const due = await prisma.webhookDelivery.findMany({
      where: { status: 'pending', nextAttemptAt: { lte: new Date() } },
      orderBy: { nextAttemptAt: 'asc' },
      take: BATCH,
    });
    for (const d of due) {
      // eslint-disable-next-line no-await-in-loop
      await processOne(d).catch((err) => logger.debug(`Webhook delivery ${d.id} error: ${err.message}`));
    }
  } finally {
    running = false;
  }
}

/** Admin test-ping: one immediate signed delivery, result returned inline. */
export async function testWebhookSubscription(id, workspaceId) {
  const sub = await prisma.webhookSubscription.findFirst({ where: { id, workspaceId } });
  if (!sub) return { ok: false, error: 'Subscription not found' };
  const problem = webhookUrlProblem(sub.url);
  if (problem) return { ok: false, error: problem };
  const delivery = { eventId: `msg_${crypto.randomBytes(12).toString('base64url')}`, eventType: 'ping', payload: { type: 'ping', event: 'ping', timestamp: new Date().toISOString(), workspaceId, data: { message: 'Ticket Pulse webhook test' } } };
  const result = await sendHttp(sub, delivery);
  await recordSubOutcome(sub, result);
  invalidateWebhookCache(workspaceId);
  return { ok: result.ok, lastError: result.ok ? null : (result.error || 'delivery failed') };
}

export async function listDeliveries(subscriptionId, workspaceId, limit = 25) {
  const sub = await prisma.webhookSubscription.findFirst({ where: { id: subscriptionId, workspaceId }, select: { id: true } });
  if (!sub) return [];
  return prisma.webhookDelivery.findMany({
    where: { subscriptionId }, orderBy: { createdAt: 'desc' }, take: Math.min(Number(limit) || 25, 100),
    select: { id: true, eventId: true, eventType: true, status: true, attempts: true, lastStatusCode: true, lastError: true, createdAt: true, deliveredAt: true, nextAttemptAt: true },
  });
}

export async function redeliver(deliveryId, workspaceId) {
  const delivery = await prisma.webhookDelivery.findFirst({ where: { id: deliveryId, workspaceId }, include: { subscription: { select: { isEnabled: true } } } });
  if (!delivery) return { ok: false, error: 'Delivery not found' };
  if (delivery.subscription && !delivery.subscription.isEnabled) return { ok: false, error: 'Subscription is disabled — re-enable it before redelivering' };
  await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { status: 'pending', attempts: 0, nextAttemptAt: new Date(), lastError: null } });
  setTimeout(() => { processDue().catch(() => {}); }, 50);
  return { ok: true };
}

let timer = null;
export function start() {
  if (timer) return;
  timer = setInterval(() => { processDue().catch((err) => logger.debug(`Webhook worker tick failed: ${err.message}`)); }, TICK_MS);
  timer.unref?.();
  logger.info('Webhook delivery worker started');
}

export { webhookUrlProblem };
export default { dispatchWebhookEvent, testWebhookSubscription, listDeliveries, redeliver, processDue, start, WEBHOOK_EVENTS };
