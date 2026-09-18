/**
 * The public base URL that links in OUTBOUND mail are built from — approval
 * pages, reply links, ticket-status pages, "open in Ticket Pulse".
 *
 * One resolver instead of eight copies (18 Sep 2026). Each service carried its
 * own chain ending in a silent `http://localhost:5173`, two of them read
 * CORS_ORIGIN without splitting it, and none said a word when they fell
 * through. That bit for real: a repair script run from a developer machine
 * against the PRODUCTION database had none of the variables set, so an approver
 * received an e-mail whose button opened `localhost:5173` on his own PC.
 *
 * The rule now: a localhost link must never be sent alongside production data.
 * When the database is remote and the resolved base is missing or points at
 * localhost, the production address is used instead, with one loud warning.
 * A fully local setup (local DB) keeps localhost, so development is unchanged.
 *
 * Pure apart from reading `env`; pass one in to test.
 */
export const PRODUCTION_PUBLIC_URL = 'https://ticketpulse.bgcsaas.com';
const LOCAL_FALLBACK = 'http://localhost:5173';
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[?::1\]?|host\.docker\.internal)$/i;

const clean = (v) => String(v || '').trim().replace(/\/+$/, '');

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

export function isLocalUrl(url) {
  const host = hostOf(url);
  return !host || LOCAL_HOST.test(host);
}

/** True when DATABASE_URL names a host that is not this machine. Unparseable/absent → false. */
export function databaseIsRemote(env = process.env) {
  const raw = String(env.DATABASE_URL || '').trim();
  if (!raw) return false;
  const host = hostOf(raw.replace(/^postgres(ql)?:/i, 'http:'));
  return Boolean(host) && !LOCAL_HOST.test(host);
}

let warned = false;
export function _resetPublicBaseUrlWarning() { warned = false; }

export function resolvePublicBaseUrl({ env = process.env, fallback = null, warn = null } = {}) {
  const firstCors = String(env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean)[0] || null;
  const configured = clean(env.PUBLIC_APP_URL || env.FRONTEND_PUBLIC_URL || env.FRONTEND_URL || env.APP_URL || firstCors || fallback || '');
  if (configured && !isLocalUrl(configured)) return configured;
  if (databaseIsRemote(env)) {
    if (!warned) {
      warned = true;
      const message = `Public base URL ${configured ? `is local (${configured})` : 'is not configured'} while DATABASE_URL is remote — links in outbound mail use ${PRODUCTION_PUBLIC_URL}. Set PUBLIC_APP_URL.`;
      if (typeof warn === 'function') warn(message);
      // Deliberate: two callers have no logger, and this must never pass silently.
      // eslint-disable-next-line no-console
      else console.warn(`[publicBaseUrl] ${message}`);
    }
    return PRODUCTION_PUBLIC_URL;
  }
  return configured || LOCAL_FALLBACK;
}

export default resolvePublicBaseUrl;
