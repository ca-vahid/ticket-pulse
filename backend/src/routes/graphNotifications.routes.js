import express from 'express';
import graphSubscriptionService from '../services/graphSubscriptionService.js';
import logger from '../utils/logger.js';

/**
 * Microsoft Graph change-notification endpoints (Mega 08-31 Phase MB-2b).
 * Mounted PRE-AUTH in app.js (Graph carries no session/JWT; the shared
 * secret is the per-connection clientState, checked by the worker).
 *
 *   POST /api/graph-notifications  — message notifications
 *   POST /api/graph-lifecycle      — reauthorizationRequired / subscriptionRemoved / missed
 *
 * Contract (change-notifications-delivery-webhooks):
 *  - Endpoint validation: POST ?validationToken=… → 200 text/plain echoing
 *    the decoded token, within 10 s. Nothing else may be in the body.
 *  - Real notifications: respond 202 within 3 s or Graph marks the endpoint
 *    slow and eventually drops it → we only parse + enqueue here; NO Graph
 *    calls, NO awaits on I/O. The worker validates clientState and fetches.
 *  - Never trust the payload: the message is re-fetched by id.
 */

const router = express.Router();

/** Parse GRAPH_NOTIFICATION_IP_ALLOWLIST: comma list of exact IPs or prefixes ending in `.`/`:`. */
export function parseIpAllowlist(raw) {
  return String(raw || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function ipAllowed(ip, allowlist) {
  if (!allowlist || allowlist.length === 0) return true;
  const candidate = String(ip || '').replace(/^::ffff:/, '');
  return allowlist.some((entry) => {
    const e = entry.replace(/^::ffff:/, '');
    if (/[.:]$/.test(e)) return candidate.startsWith(e);
    return candidate === e;
  });
}

function requestIp(req) {
  const forwarded = String(req.get('x-forwarded-for') || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || '';
}

function allowlistGate(req, res) {
  const allowlist = parseIpAllowlist(process.env.GRAPH_NOTIFICATION_IP_ALLOWLIST);
  if (allowlist.length === 0) return true;
  const ip = requestIp(req);
  if (ipAllowed(ip, allowlist)) return true;
  logger.warn(`Graph notification from non-allowlisted IP ${ip} rejected`);
  res.status(403).json({ success: false, code: 'ip_not_allowed' });
  return false;
}

/** Validation handshake — Graph expects the raw token back as text/plain. */
function handshake(req, res) {
  const token = req.query?.validationToken;
  if (typeof token !== 'string' || token.length === 0) return false;
  res.status(200).type('text/plain').send(token);
  return true;
}

function notificationItems(body) {
  return Array.isArray(body?.value) ? body.value : [];
}

router.post('/graph-notifications', (req, res) => {
  if (handshake(req, res)) return undefined;
  if (!allowlistGate(req, res)) return undefined;
  const items = notificationItems(req.body);
  // Synchronous: parse + queue only. Drain runs on the next tick.
  const result = graphSubscriptionService.enqueueNotifications(items);
  if (items.length && !result.queued && !result.duplicates) {
    logger.debug('Graph notification batch carried nothing actionable', { count: items.length, ...result });
  }
  return res.status(202).json({ success: true, accepted: result.queued, duplicates: result.duplicates });
});

router.post('/graph-lifecycle', (req, res) => {
  if (handshake(req, res)) return undefined;
  if (!allowlistGate(req, res)) return undefined;
  const items = notificationItems(req.body);
  // Acknowledge first; the handler validates clientState and flips flags
  // asynchronously (DB lookups must not sit in front of the 202).
  res.status(202).json({ success: true, accepted: items.length });
  if (items.length) {
    setImmediate(() => {
      graphSubscriptionService.handleLifecycleEvents(items)
        .catch((err) => logger.warn(`Graph lifecycle handling failed: ${err.message}`));
    });
  }
  return undefined;
});

export default router;
