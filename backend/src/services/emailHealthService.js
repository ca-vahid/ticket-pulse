import prisma from './prisma.js';
import logger from '../utils/logger.js';

/**
 * Delivery-health telemetry for outbound notification transports. Every send
 * attempt (email now; the `channel` column lets SMS/WhatsApp/voice join later)
 * records one row — success or failure — so the app can surface "email delivery
 * is failing" in Settings and warn admins, instead of swallowing send errors as
 * non-fatal. Mirrors the AI provider health-event pattern.
 *
 * Recording never throws: a telemetry write must not break a send path.
 */

// Most-recent attempts we scan to decide the current status.
const RECENT_TAKE = 100;
// How far back a failure still counts toward the current status / list.
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const COUNT_WINDOW_MS = 24 * 60 * 60 * 1000;

function eventTime(event) {
  return event?.createdAt ? new Date(event.createdAt).getTime() : 0;
}

function statusCodeFromError(error) {
  const value = error?.providerStatus
    || error?.status
    || error?.statusCode
    || error?.response?.status
    || error?.responseCode;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

export function sanitizeEmailErrorMessage(error) {
  return String(error?.message || error || 'Unknown email error')
    .replace(/SG\.[A-Za-z0-9_.-]+/g, '[redacted-key]')
    .replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .slice(0, 500);
}

/**
 * Exact grant text for a Graph 403 (Phase RL, RL-2). The app registration
 * name/id are what IT sees in Entra; the permission is what the send lane
 * needs beyond Mail.Send (createReply + draft-then-send write to the mailbox).
 */
export const GRAPH_APP_NAME = process.env.AZURE_GRAPH_APP_NAME || 'Ticket Pulse Backend';
export const GRAPH_APP_ID = process.env.AZURE_GRAPH_CLIENT_ID || 'f3a49518-786c-456d-a881-6cc24e378c2c';
export const GRAPH_PERMISSION_GRANT_TEXT = `Grant Mail.ReadWrite (application) to ${GRAPH_APP_NAME} (${GRAPH_APP_ID}) in Entra → App registrations → API permissions, then "Grant admin consent" — Mail.Send alone cannot create the reply draft. Scope it to the ticket mailboxes with Exchange RBAC for Applications if the tenant requires it. Until then every send falls back to SendGrid as ticketpulse@.`;

/** Is this error a Microsoft Graph access-denied (403 / ErrorAccessDenied)? */
export function isGraphPermissionError(error, provider = null) {
  const statusCode = statusCodeFromError(error);
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  const graphShaped = provider === 'msgraph'
    || error?.graphPermissionDenied === true
    || code === 'erroraccessdenied'
    || code === 'accessdenied'
    || message.includes('microsoft graph')
    || message.includes('graph api');
  if (!graphShaped) return false;
  return statusCode === 403 || code === 'erroraccessdenied' || code === 'accessdenied' || message.includes('access is denied');
}

/** Classify an email transport error into a stable class + status code. */
export function classifyEmailError(error, { provider = null } = {}) {
  const statusCode = statusCodeFromError(error);
  const message = sanitizeEmailErrorMessage(error);
  const lower = message.toLowerCase();
  const code = error?.code;
  let errorClass = 'unknown';

  if (isGraphPermissionError(error, provider)) {
    // Graph 403 = the app registration lacks the mailbox permission (Phase
    // RL): NOT an IP block — that label sent IT to SendGrid's allowlist.
    errorClass = 'permission_denied';
  } else if (lower.includes('not configured') || lower.includes('no recipient') || lower.includes('is required')) {
    errorClass = 'config_missing';
  } else if (statusCode === 401 || lower.includes('unauthorized') || lower.includes('authentication')) {
    errorClass = 'auth_error';
  } else if (statusCode === 403 || lower.includes('access forbidden') || lower.includes('not allowed to access') || lower.includes('ip address')) {
    errorClass = 'ip_blocked';
  } else if (statusCode === 429 || lower.includes('rate limit') || lower.includes('too many requests')) {
    errorClass = 'rate_limited';
  } else if (statusCode === 413 || lower.includes('payload too large')) {
    errorClass = 'payload_too_large';
  } else if (
    statusCode === 400
    || statusCode === 422
    || lower.includes('does not contain a valid address')
    || lower.includes('invalid email')
    || lower.includes('valid address')
  ) {
    errorClass = 'invalid_recipient';
  } else if (
    code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'ECONNRESET'
    || lower.includes('timeout') || lower.includes('network') || lower.includes('econn')
  ) {
    errorClass = 'network';
  } else if ((statusCode && statusCode >= 500) || lower.includes('server error')) {
    errorClass = 'provider_down';
  }

  return { errorClass, statusCode, message };
}

/** A plain-English, actionable hint for the most recent failure. */
export function hintForFailure({ errorClass, statusCode, provider } = {}) {
  switch (errorClass) {
  case 'permission_denied':
    return `Microsoft Graph refused the send (403 access denied) — the send lane is not granted. ${GRAPH_PERMISSION_GRANT_TEXT}`;
  case 'ip_blocked':
    return provider === 'msgraph'
      ? `Microsoft Graph rejected the request (403). ${GRAPH_PERMISSION_GRANT_TEXT}`
      : 'SendGrid returned 403 — the sending server’s outbound IP is likely blocked. Check SendGrid → Settings → IP Access Management (allowlist the app’s outbound IPs, or disable it for this send-only key).';
  case 'auth_error':
    return 'The provider rejected the credentials (401). Verify the SendGrid API key (or Graph client secret) is valid and not expired.';
  case 'config_missing':
    return 'Email isn’t fully configured — a provider API key or from-address is missing.';
  case 'rate_limited':
    return 'The provider is rate-limiting sends (429). Sends should recover on their own; investigate if it persists.';
  case 'invalid_recipient':
    return 'The provider rejected the recipient address as invalid. Check the address on the failing item.';
  case 'network':
    return 'Could not reach the email provider (network/timeout). Usually transient; check outbound connectivity if it persists.';
  case 'provider_down':
    return 'The email provider returned a server error (5xx). Usually transient on the provider’s side.';
  default:
    return statusCode
      ? `The email provider returned an unexpected error (status ${statusCode}).`
      : 'The email provider returned an unexpected error.';
  }
}

function recipientDomainOf(recipients) {
  const first = (Array.isArray(recipients) ? recipients : [recipients]).find(Boolean);
  if (!first) return null;
  const at = String(first).lastIndexOf('@');
  if (at === -1) return null;
  return String(first).slice(at + 1).toLowerCase().slice(0, 120) || null;
}

class EmailHealthService {
  async recordSuccess({
    workspaceId = null,
    channel = 'email',
    context = null,
    provider = null,
    durationMs = null,
    recipients = null,
  } = {}) {
    try {
      return await prisma.notificationChannelHealthEvent.create({
        data: {
          workspaceId: workspaceId || null,
          channel,
          context,
          provider,
          success: true,
          durationMs,
          recipientDomain: recipientDomainOf(recipients),
        },
      });
    } catch (error) {
      logger.debug(`Failed to record ${channel} success health event: ${error.message}`);
      return null;
    }
  }

  async recordFailure({
    workspaceId = null,
    channel = 'email',
    context = null,
    provider = null,
    error,
    durationMs = null,
    recipients = null,
  } = {}) {
    const classified = classifyEmailError(error, { provider });
    try {
      return await prisma.notificationChannelHealthEvent.create({
        data: {
          workspaceId: workspaceId || null,
          channel,
          context,
          provider,
          success: false,
          errorClass: classified.errorClass,
          statusCode: classified.statusCode,
          durationMs,
          recipientDomain: recipientDomainOf(recipients),
          sanitizedMessage: classified.message,
        },
      });
    } catch (writeError) {
      logger.debug(`Failed to record ${channel} failure health event: ${writeError.message}`);
      return null;
    }
  }

  /**
   * Current delivery status for a channel, derived from recency of the most
   * recent success vs failure, plus 24h counts for context.
   */
  async getStatus({ channel = 'email' } = {}) {
    const since = new Date(Date.now() - LOOKBACK_MS);
    const events = await prisma.notificationChannelHealthEvent.findMany({
      where: { channel, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: RECENT_TAKE,
    });
    return this._classify(channel, events);
  }

  /**
   * Outbound Graph lane state for one workspace (Phase RL, RL-2 / RL-7):
   * the most recent msgraph email event in the lookback window decides it.
   *   { status: 'ok' | 'not_granted' | 'failing', lastEventAt, errorClass,
   *     statusCode, message, hint, permissionGrantText }
   * Null when Graph has never been tried for this workspace.
   */
  async getGraphSendLane(workspaceId) {
    const since = new Date(Date.now() - LOOKBACK_MS);
    const last = await prisma.notificationChannelHealthEvent.findFirst({
      where: { channel: 'email', provider: 'msgraph', createdAt: { gte: since }, ...(workspaceId ? { workspaceId: Number(workspaceId) } : {}) },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, success: true, errorClass: true, statusCode: true, sanitizedMessage: true, context: true },
    });
    if (!last) return null;
    if (last.success) return { status: 'ok', lastEventAt: last.createdAt, errorClass: null, statusCode: null, message: null, hint: null };
    const notGranted = last.errorClass === 'permission_denied'
      || (last.errorClass === 'ip_blocked' && last.statusCode === 403); // pre-RL rows
    return {
      status: notGranted ? 'not_granted' : 'failing',
      lastEventAt: last.createdAt,
      errorClass: notGranted ? 'permission_denied' : last.errorClass,
      statusCode: last.statusCode,
      message: last.sanitizedMessage,
      context: last.context,
      hint: hintForFailure({ errorClass: notGranted ? 'permission_denied' : last.errorClass, statusCode: last.statusCode, provider: 'msgraph' }),
      ...(notGranted ? { permissionGrantText: GRAPH_PERMISSION_GRANT_TEXT } : {}),
    };
  }

  async getRecentFailures({ channel = 'email', limit = 10 } = {}) {
    const since = new Date(Date.now() - LOOKBACK_MS);
    const rows = await prisma.notificationChannelHealthEvent.findMany({
      where: { channel, success: false, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(Number(limit) || 10, 1), 50),
      select: {
        id: true, createdAt: true, context: true, provider: true,
        errorClass: true, statusCode: true, recipientDomain: true, sanitizedMessage: true,
      },
    });
    return rows;
  }

  _classify(channel, events = []) {
    const base = {
      channel,
      status: 'unknown',
      lastEventAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastErrorClass: null,
      lastMessage: null,
      lastStatusCode: null,
      lastProvider: null,
      successCount24h: 0,
      failureCount24h: 0,
      hint: null,
    };
    if (!events.length) return base;

    const countSince = Date.now() - COUNT_WINDOW_MS;
    const in24h = events.filter((e) => eventTime(e) >= countSince);
    base.successCount24h = in24h.filter((e) => e.success).length;
    base.failureCount24h = in24h.length - base.successCount24h;

    const lastSuccess = events.find((e) => e.success);
    const lastFailure = events.find((e) => !e.success);
    const latestSuccessAt = eventTime(lastSuccess);
    const latestFailureAt = eventTime(lastFailure);
    const failureStreak = events.findIndex((e) => e.success);
    const normalizedStreak = failureStreak === -1 ? events.length : failureStreak;

    base.lastEventAt = events[0].createdAt;
    base.lastSuccessAt = lastSuccess?.createdAt || null;
    base.lastFailureAt = lastFailure?.createdAt || null;

    if (latestFailureAt > latestSuccessAt) {
      // Most recent attempt failed.
      base.lastErrorClass = lastFailure.errorClass;
      base.lastMessage = lastFailure.sanitizedMessage;
      base.lastStatusCode = lastFailure.statusCode;
      base.lastProvider = lastFailure.provider;
      const systemic = ['ip_blocked', 'permission_denied', 'auth_error', 'config_missing'].includes(lastFailure.errorClass);
      base.status = (systemic || normalizedStreak >= 3) ? 'down' : 'degraded';
      base.hint = hintForFailure({
        errorClass: lastFailure.errorClass,
        statusCode: lastFailure.statusCode,
        provider: lastFailure.provider,
      });
    } else {
      // Most recent attempt succeeded — recovered / healthy.
      base.status = 'healthy';
      if (lastFailure) {
        base.lastErrorClass = lastFailure.errorClass;
        base.lastMessage = lastFailure.sanitizedMessage;
        base.lastStatusCode = lastFailure.statusCode;
        base.lastProvider = lastFailure.provider;
      }
    }
    return base;
  }
}

export default new EmailHealthService();
export { EmailHealthService };
