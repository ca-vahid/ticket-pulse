import crypto from 'node:crypto';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import graphMailClient, { graphErrorStatus } from '../integrations/graphMailClient.js';
import mailboxIngestService from './mailboxIngestService.js';

/**
 * Microsoft Graph change-notification manager for ticket mailboxes
 * (Mega 08-31 Phase MB-2c/2d). Owns, per ingest-capable MailboxConnection:
 *
 *  - ONE `created` subscription on /users/{mb}/mailFolders('inbox')/messages
 *    with notificationUrl + lifecycleNotificationUrl (set at creation — Graph
 *    cannot add the lifecycle URL later), a random per-connection clientState
 *    and a 6-day expiry (Outlook cap is 10,080 min ≈ 7 d).
 *  - Renewal: PATCH when < 48 h remain (one PATCH renews AND reauthorizes —
 *    the lifecycle doc forbids mixing /reauthorize with PATCH inside 10 min,
 *    so `reauthorizationRequired` is answered with the same PATCH).
 *  - Recreate on 404 / `subscriptionRemoved` / expiry; delta re-sync on
 *    `missed` (handed to the poller's catch-up lane).
 *  - The delta cursor bootstrap (`deltaLink`) the demoted poller reconciles
 *    against every few minutes.
 *  - The in-process notification queue: the public route enqueues and
 *    answers 202 in the same tick; this worker resolves the connection by
 *    subscriptionId, checks clientState, fetches the message by id (minimal
 *    $select) and hands it to mailboxIngestService.ingestSingleMessage —
 *    same dedupe/matching/side effects as the poller.
 *
 * Feature-flagged: GRAPH_NOTIFICATIONS_ENABLED=true AND an https base URL
 * (GRAPH_NOTIFICATION_BASE_URL, prod default https://api.ticketpulse.bgcsaas.com).
 * Dev boxes are unreachable by Graph, so everything here is a logged no-op
 * there; the poller keeps working exactly as before.
 */

export const SUBSCRIPTION_TTL_MS = 6 * 24 * 60 * 60 * 1000; // 6 d < 10,080-min cap
export const RENEW_THRESHOLD_MS = 48 * 60 * 60 * 1000;
export const ENSURE_TICK_MS = Number(process.env.GRAPH_SUBSCRIPTION_TICK_MS) || 30 * 60 * 1000;
const START_DELAY_MS = Number(process.env.GRAPH_SUBSCRIPTION_START_DELAY_MS) || 20 * 1000;
const QUEUE_MAX = 5000;
const CONNECTION_CACHE_MS = 60 * 1000;
const LAST_NOTIFICATION_WRITE_MS = 5 * 1000;
// The poller caps new tickets per sender per pass (loop guard). Webhooks
// arrive one at a time, so the worker keys the same cap to a rolling window.
const SENDER_CAP_WINDOW_MS = 5 * 60 * 1000;
const PROD_DEFAULT_BASE_URL = 'https://api.ticketpulse.bgcsaas.com';

export const NOTIFICATION_STATUS = Object.freeze({
  ACTIVE: 'active', RENEWING: 'renewing', ERROR: 'error', DISABLED: 'disabled',
});

const ELIGIBLE_WHERE = Object.freeze({
  isEnabled: true,
  mode: { in: ['ingest', 'both'] },
  workspace: { isActive: true, nativeTicketingEnabled: true },
});

export function notificationBaseUrl(env = process.env) {
  const explicit = String(env.GRAPH_NOTIFICATION_BASE_URL || env.PUBLIC_API_URL || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  return env.NODE_ENV === 'production' ? PROD_DEFAULT_BASE_URL : '';
}

/**
 * Why notifications are off, or null when they can run. Exported so the
 * health surface and boot log can say the same thing.
 */
export function notificationsDisabledReason(env = process.env, configured = graphMailClient.isConfigured()) {
  if (String(env.GRAPH_NOTIFICATIONS_ENABLED || '').toLowerCase() !== 'true') return 'GRAPH_NOTIFICATIONS_ENABLED is not true';
  if (!configured) return 'Azure Graph credentials are not configured';
  const base = notificationBaseUrl(env);
  if (!/^https:\/\//i.test(base)) return 'GRAPH_NOTIFICATION_BASE_URL must be an https URL reachable by Microsoft Graph';
  return null;
}

/**
 * Pure decision for one connection given its stored state, the clock and a
 * pending lifecycle flag ('renew' | 'recreate' | 'resync' | null):
 *   create     — no subscription yet
 *   recreate   — flagged removed, or expired / missing expiry
 *   renew      — flagged (reauthorizationRequired) or < 48 h left
 *   resync     — flagged missed (subscription itself is fine)
 *   none       — healthy
 */
export function decideSubscriptionAction(connection, now = Date.now(), pending = null) {
  if (!connection?.subscriptionId) return 'create';
  if (pending === 'recreate') return 'recreate';
  const expires = connection.subscriptionExpiresAt ? new Date(connection.subscriptionExpiresAt).getTime() : NaN;
  if (!Number.isFinite(expires) || expires <= now) return 'recreate';
  if (pending === 'renew' || expires - now < RENEW_THRESHOLD_MS) return 'renew';
  if (pending === 'resync') return 'resync';
  return 'none';
}

/** Normalize one Graph changeNotification into the queue item shape. */
export function normalizeNotification(item) {
  if (!item || typeof item !== 'object') return null;
  const subscriptionId = String(item.subscriptionId || '').trim();
  let messageId = String(item.resourceData?.id || '').trim();
  if (!messageId && typeof item.resource === 'string') {
    // Graph sends `Users/{id}/Messages/{id}`; tolerate the OData key form too.
    const m = item.resource.match(/[Mm]essages(?:\/|\(')([^/?')]+)/);
    messageId = m ? decodeURIComponent(m[1]) : '';
  }
  if (!subscriptionId || !messageId) return null;
  return {
    subscriptionId,
    clientState: item.clientState === undefined || item.clientState === null ? null : String(item.clientState),
    changeType: String(item.changeType || 'created'),
    resourceMessageId: messageId,
    tenantId: item.tenantId || null,
  };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

class GraphSubscriptionService {
  constructor() {
    this._queue = [];
    this._inFlight = new Set(); // `${subscriptionId}:${messageId}` queued or processing
    this._draining = false;
    this._pending = new Map(); // subscriptionId -> 'renew' | 'recreate' | 'resync'
    this._connectionCache = new Map(); // subscriptionId -> { connection, at }
    this._lastNotificationWrite = new Map(); // connectionId -> ts
    this._unknownSubscriptionsCleaned = new Set();
    this._senderCreates = { at: 0, map: new Map() };
    this._ensureTimer = null;
    this._ensureSoonTimer = null;
    this._ensuring = false;
    this._loggedDisabled = false;
    this.stats = { received: 0, queued: 0, duplicates: 0, rejectedClientState: 0, unknownSubscription: 0, ingested: 0, fetchMisses: 0, errors: 0, lifecycle: 0 };
  }

  // ----------------------------------------------------------------- config

  isEnabled() {
    return notificationsDisabledReason() === null;
  }

  notificationUrl() { return `${notificationBaseUrl()}/api/graph-notifications`; }

  lifecycleNotificationUrl() { return `${notificationBaseUrl()}/api/graph-lifecycle`; }

  // ------------------------------------------------------------------ boot

  /** Boot hook (app.js): log the lane state and schedule the first ensure. */
  start() {
    const reason = notificationsDisabledReason();
    if (reason) {
      logger.info(`Graph mail notifications disabled (${reason}) — mailbox poller remains the inbound lane`);
      return false;
    }
    logger.info(`Graph mail notifications enabled → ${this.notificationUrl()} (ensure every ${Math.round(ENSURE_TICK_MS / 60000)} min)`);
    if (!this._ensureTimer) {
      this._ensureTimer = setTimeout(() => {
        this._ensureTimer = null;
        this.ensureSubscriptions().catch((err) => logger.warn(`Graph subscription ensure failed (non-fatal): ${err.message}`));
      }, START_DELAY_MS);
      this._ensureTimer.unref?.();
    }
    return true;
  }

  stop() {
    if (this._ensureTimer) clearTimeout(this._ensureTimer);
    if (this._ensureSoonTimer) clearTimeout(this._ensureSoonTimer);
    this._ensureTimer = null;
    this._ensureSoonTimer = null;
  }

  /** Debounced "run ensureSubscriptions shortly" (lifecycle events, delta resets). */
  requestEnsureSoon(delayMs = 2000) {
    if (!this.isEnabled() || this._ensureSoonTimer) return;
    this._ensureSoonTimer = setTimeout(() => {
      this._ensureSoonTimer = null;
      this.ensureSubscriptions().catch((err) => logger.warn(`Graph subscription ensure failed (non-fatal): ${err.message}`));
    }, delayMs);
    this._ensureSoonTimer.unref?.();
  }

  // --------------------------------------------------- subscription manager

  /**
   * Walk every ingest-capable connection and converge its subscription
   * (create / renew / recreate / resync) + delta cursor; release
   * subscriptions of connections that stopped being eligible. Safe to call
   * from a cron tick — re-entrancy guarded, per-connection failures isolated.
   */
  async ensureSubscriptions(now = Date.now()) {
    const reason = notificationsDisabledReason();
    if (reason) {
      if (!this._loggedDisabled) {
        logger.debug(`Graph subscription ensure skipped: ${reason}`);
        this._loggedDisabled = true;
      }
      return { skipped: reason };
    }
    if (this._ensuring) return { skipped: 'in_progress' };
    this._ensuring = true;
    const summary = { created: 0, renewed: 0, recreated: 0, resynced: 0, released: 0, deltaBootstrapped: 0, errors: 0, unchanged: 0 };
    try {
      const eligible = await prisma.mailboxConnection.findMany({ where: ELIGIBLE_WHERE });
      for (const connection of eligible) {
        const pending = this._pending.get(connection.subscriptionId || '') || null;
        const action = decideSubscriptionAction(connection, now, pending);
        try {
          let current = connection;
          if (action === 'create' || action === 'recreate') {
            current = await this._createSubscription(connection, now);
            summary[action === 'create' ? 'created' : 'recreated'] += 1;
          } else if (action === 'renew') {
            current = await this._renewSubscription(connection, now);
            summary.renewed += 1;
          } else if (action === 'resync') {
            mailboxIngestService.requestCatchUp(connection.id);
            summary.resynced += 1;
          } else {
            summary.unchanged += 1;
          }
          if (connection.subscriptionId) this._pending.delete(connection.subscriptionId);
          if (current?.subscriptionId) this._pending.delete(current.subscriptionId);
          if (!current.deltaLink) {
            const bootstrapped = await this._bootstrapDelta(current, now);
            if (bootstrapped) summary.deltaBootstrapped += 1;
          }
        } catch (err) {
          summary.errors += 1;
          await prisma.mailboxConnection.update({
            where: { id: connection.id },
            data: { notificationStatus: NOTIFICATION_STATUS.ERROR },
          }).catch(() => {});
          this._connectionCache.clear();
          logger.warn(`Graph subscription ${action} failed for ${connection.address} — poller stays on its own cadence: ${err.message}`);
        }
      }

      // Connections that stopped being eligible but still hold a subscription.
      const stale = await prisma.mailboxConnection.findMany({
        where: { subscriptionId: { not: null }, OR: [{ isEnabled: false }, { mode: 'send' }] },
      });
      for (const connection of stale) {
        await this._releaseSubscription(connection).catch((err) => {
          logger.warn(`Graph subscription release failed for ${connection.address} (non-fatal): ${err.message}`);
        });
        summary.released += 1;
      }
      if (summary.created || summary.renewed || summary.recreated || summary.errors || summary.released) {
        logger.info('Graph subscription ensure', summary);
      }
      return summary;
    } finally {
      this._ensuring = false;
    }
  }

  async _createSubscription(connection, now = Date.now()) {
    // Best-effort cleanup of the previous subscription (expired/removed ids
    // 404 — that's fine).
    if (connection.subscriptionId) {
      await graphMailClient.deleteSubscription(connection.subscriptionId).catch(() => {});
    }
    // Persist the new clientState BEFORE Graph can send anything with it —
    // Graph validates the endpoint synchronously and may notify right away.
    const clientState = crypto.randomBytes(24).toString('hex');
    await prisma.mailboxConnection.update({
      where: { id: connection.id },
      data: { clientState, notificationStatus: NOTIFICATION_STATUS.RENEWING, subscriptionId: null, subscriptionExpiresAt: null },
    });
    this._connectionCache.clear();
    const created = await graphMailClient.createMailSubscription(connection.address, {
      notificationUrl: this.notificationUrl(),
      lifecycleNotificationUrl: this.lifecycleNotificationUrl(),
      clientState,
      expirationDateTime: new Date(now + SUBSCRIPTION_TTL_MS),
    });
    const updated = await prisma.mailboxConnection.update({
      where: { id: connection.id },
      data: {
        subscriptionId: created.id,
        subscriptionExpiresAt: new Date(created.expirationDateTime),
        notificationStatus: NOTIFICATION_STATUS.ACTIVE,
      },
    });
    this._connectionCache.clear();
    logger.info(`Graph mail subscription ${connection.subscriptionId ? 'recreated' : 'created'} for ${connection.address} (expires ${updated.subscriptionExpiresAt?.toISOString?.() || created.expirationDateTime})`);
    return updated;
  }

  async _renewSubscription(connection, now = Date.now()) {
    try {
      const renewed = await graphMailClient.renewSubscription(connection.subscriptionId, new Date(now + SUBSCRIPTION_TTL_MS));
      const updated = await prisma.mailboxConnection.update({
        where: { id: connection.id },
        data: {
          subscriptionExpiresAt: new Date(renewed.expirationDateTime),
          notificationStatus: NOTIFICATION_STATUS.ACTIVE,
        },
      });
      this._connectionCache.clear();
      logger.info(`Graph mail subscription renewed for ${connection.address} (expires ${updated.subscriptionExpiresAt?.toISOString?.()})`);
      return updated;
    } catch (err) {
      if (graphErrorStatus(err) === 404) {
        logger.warn(`Graph mail subscription for ${connection.address} is gone (404 on renew) — recreating`);
        return this._createSubscription(connection, now);
      }
      throw err;
    }
  }

  async _releaseSubscription(connection) {
    if (connection.subscriptionId) {
      await graphMailClient.deleteSubscription(connection.subscriptionId).catch(() => {});
    }
    await prisma.mailboxConnection.update({
      where: { id: connection.id },
      data: {
        subscriptionId: null, subscriptionExpiresAt: null, clientState: null, deltaLink: null,
        notificationStatus: NOTIFICATION_STATUS.DISABLED,
      },
    });
    this._connectionCache.clear();
    logger.info(`Graph mail subscription released for ${connection.address} (no longer ingest-eligible)`);
  }

  /**
   * Bootstrap the delta cursor: an initial round filtered to
   * receivedDateTime ge lastMessageAt (or a 15-min lookback) whose items we
   * deliberately DON'T ingest here — the poller's next inbox fetch covers
   * that window; from then on the poller walks the cursor.
   */
  async _bootstrapDelta(connection, now = Date.now()) {
    const since = connection.lastMessageAt ? new Date(connection.lastMessageAt) : new Date(now - 15 * 60 * 1000);
    try {
      const round = await graphMailClient.getInboxDeltaChanges(connection.address, null, { since });
      if (!round.deltaLink) return false;
      await prisma.mailboxConnection.update({ where: { id: connection.id }, data: { deltaLink: round.deltaLink } });
      this._connectionCache.clear();
      return true;
    } catch (err) {
      logger.warn(`Delta cursor bootstrap failed for ${connection.address} (poller keeps the inbox fetch): ${err.message}`);
      return false;
    }
  }

  // --------------------------------------------------------- lifecycle lane

  /**
   * Lifecycle notifications (validated by clientState against the stored
   * connection). Flags are consumed by the next ensure pass, which is
   * requested immediately.
   */
  async handleLifecycleEvents(items) {
    const handled = [];
    for (const raw of Array.isArray(items) ? items : []) {
      const subscriptionId = String(raw?.subscriptionId || '').trim();
      const event = String(raw?.lifecycleEvent || '').trim();
      if (!subscriptionId || !event) continue;
      this.stats.lifecycle += 1;
      const connection = await this._resolveConnection(subscriptionId);
      if (!connection) {
        this.stats.unknownSubscription += 1;
        logger.debug(`Graph lifecycle ${event} for unknown subscription ${subscriptionId} — ignored`);
        continue;
      }
      if (!safeEqual(connection.clientState, raw.clientState)) {
        this.stats.rejectedClientState += 1;
        logger.warn(`Graph lifecycle ${event} rejected for ${connection.address}: clientState mismatch`);
        continue;
      }
      if (event === 'reauthorizationRequired') {
        this._pending.set(subscriptionId, 'renew');
        await prisma.mailboxConnection.update({
          where: { id: connection.id }, data: { notificationStatus: NOTIFICATION_STATUS.RENEWING },
        }).catch(() => {});
      } else if (event === 'subscriptionRemoved') {
        this._pending.set(subscriptionId, 'recreate');
        await prisma.mailboxConnection.update({
          where: { id: connection.id }, data: { notificationStatus: NOTIFICATION_STATUS.RENEWING },
        }).catch(() => {});
        mailboxIngestService.requestCatchUp(connection.id);
      } else if (event === 'missed') {
        this._pending.set(subscriptionId, 'resync');
        mailboxIngestService.requestCatchUp(connection.id);
      } else {
        logger.debug(`Graph lifecycle event ${event} ignored for ${connection.address}`);
        continue;
      }
      this._connectionCache.clear();
      handled.push({ connectionId: connection.id, event });
      logger.info(`Graph lifecycle ${event} for ${connection.address} → ${this._pending.get(subscriptionId)}`);
    }
    if (handled.length) this.requestEnsureSoon();
    return handled;
  }

  /** Pending lifecycle flag for a subscription (tests / health). */
  pendingActionFor(subscriptionId) {
    return this._pending.get(String(subscriptionId || '')) || null;
  }

  // ------------------------------------------------------ notification lane

  /**
   * Route entry: synchronous, no I/O. Collapses duplicate notifications for
   * a message already queued/in flight (Graph retries + bursts) and caps the
   * queue so a storm can't grow memory unbounded. Drain is scheduled on the
   * next tick so the HTTP handler returns 202 first.
   */
  enqueueNotifications(items) {
    const result = { queued: 0, duplicates: 0, invalid: 0, dropped: 0 };
    for (const raw of Array.isArray(items) ? items : []) {
      this.stats.received += 1;
      const item = normalizeNotification(raw);
      if (!item) { result.invalid += 1; continue; }
      const key = `${item.subscriptionId}:${item.resourceMessageId}`;
      if (this._inFlight.has(key)) { result.duplicates += 1; this.stats.duplicates += 1; continue; }
      if (this._queue.length >= QUEUE_MAX) { result.dropped += 1; continue; }
      this._inFlight.add(key);
      this._queue.push({ ...item, key, receivedAt: Date.now() });
      result.queued += 1;
      this.stats.queued += 1;
    }
    if (result.dropped) logger.warn(`Graph notification queue full (${QUEUE_MAX}) — dropped ${result.dropped}; poller catch-up will reconcile`);
    if (result.queued) setImmediate(() => { this.drain().catch((err) => logger.warn(`Graph notification drain failed: ${err.message}`)); });
    return result;
  }

  queueSize() { return this._queue.length; }

  /** Drain the queue serially; safe to call repeatedly. */
  async drain() {
    if (this._draining) return { skipped: true };
    this._draining = true;
    let processed = 0;
    try {
      while (this._queue.length > 0) {
        const item = this._queue.shift();
        try {
          await this._processNotification(item);
        } catch (err) {
          this.stats.errors += 1;
          logger.warn(`Graph notification processing failed (${item.subscriptionId}/${item.resourceMessageId}): ${err.message}`);
        } finally {
          this._inFlight.delete(item.key);
          processed += 1;
        }
      }
      return { processed };
    } finally {
      this._draining = false;
    }
  }

  async _processNotification(item) {
    const connection = await this._resolveConnection(item.subscriptionId);
    if (!connection) {
      this.stats.unknownSubscription += 1;
      await this._cleanupUnknownSubscription(item.subscriptionId);
      return 'unknown_subscription';
    }
    if (!safeEqual(connection.clientState, item.clientState)) {
      this.stats.rejectedClientState += 1;
      logger.warn(`Graph notification rejected for ${connection.address}: clientState mismatch`);
      return 'client_state_mismatch';
    }
    await this._touchLastNotification(connection.id);

    if (item.changeType && item.changeType !== 'created') return 'ignored_change_type';

    let email;
    try {
      email = await graphMailClient.getMessageForIngest(connection.address, item.resourceMessageId);
    } catch (err) {
      // Transient Graph failure: let the poller's catch-up lane pick it up.
      mailboxIngestService.requestCatchUp(connection.id);
      throw err;
    }
    if (!email) { this.stats.fetchMisses += 1; return 'message_gone'; }

    const outcome = await mailboxIngestService.ingestSingleMessage(connection, email, this._senderCapMap());
    this.stats.ingested += 1;
    if (email.receivedAt instanceof Date && !Number.isNaN(email.receivedAt.getTime())) {
      await prisma.mailboxConnection.updateMany({
        where: { id: connection.id, OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: email.receivedAt } }] },
        data: { lastMessageAt: email.receivedAt },
      }).catch(() => {});
    }
    logger.info(`Graph notification → ${outcome} for ${connection.address} (${item.resourceMessageId.slice(0, 12)}…)`);
    return outcome;
  }

  /** Per-sender create-cap map shared across notifications inside a 5-min window. */
  _senderCapMap(now = Date.now()) {
    if (now - this._senderCreates.at > SENDER_CAP_WINDOW_MS) {
      this._senderCreates = { at: now, map: new Map() };
    }
    return this._senderCreates.map;
  }

  async _resolveConnection(subscriptionId) {
    const cached = this._connectionCache.get(subscriptionId);
    if (cached && Date.now() - cached.at < CONNECTION_CACHE_MS) return cached.connection;
    const connection = await prisma.mailboxConnection.findFirst({ where: { subscriptionId } });
    this._connectionCache.set(subscriptionId, { connection: connection || null, at: Date.now() });
    return connection || null;
  }

  async _touchLastNotification(connectionId) {
    const last = this._lastNotificationWrite.get(connectionId) || 0;
    const now = Date.now();
    if (now - last < LAST_NOTIFICATION_WRITE_MS) return;
    this._lastNotificationWrite.set(connectionId, now);
    await prisma.mailboxConnection.update({
      where: { id: connectionId }, data: { lastNotificationAt: new Date(now) },
    }).catch(() => {});
  }

  /**
   * A subscription we don't know (deleted connection, older deploy) keeps
   * posting until it expires (≤ 6 d). Delete it once — it can only be ours:
   * Graph only routes an app's own subscriptions to its notificationUrl.
   */
  async _cleanupUnknownSubscription(subscriptionId) {
    if (!this.isEnabled() || this._unknownSubscriptionsCleaned.has(subscriptionId)) return;
    this._unknownSubscriptionsCleaned.add(subscriptionId);
    if (this._unknownSubscriptionsCleaned.size > 500) this._unknownSubscriptionsCleaned.clear();
    logger.warn(`Graph notification for unknown subscription ${subscriptionId} — deleting it`);
    await graphMailClient.deleteSubscription(subscriptionId).catch(() => {});
  }

  getStats() {
    return { ...this.stats, queueSize: this._queue.length, enabled: this.isEnabled(), disabledReason: notificationsDisabledReason() };
  }

  /** Test hook: reset in-memory state. */
  _resetForTests() {
    this._queue = [];
    this._inFlight.clear();
    this._draining = false;
    this._pending.clear();
    this._connectionCache.clear();
    this._lastNotificationWrite.clear();
    this._unknownSubscriptionsCleaned.clear();
    this._senderCreates = { at: 0, map: new Map() };
    this._loggedDisabled = false;
    this.stop();
    for (const k of Object.keys(this.stats)) this.stats[k] = 0;
  }
}

export default new GraphSubscriptionService();
