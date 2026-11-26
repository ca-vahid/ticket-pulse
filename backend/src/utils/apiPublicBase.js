/**
 * The public base of the API (4.4.24): where /api/v1 really answers.
 *
 * The web hosts (PUBLIC_APP_URL) are a static web app and return an HTML 404
 * for /api/v1/*, so anything that tells a person or a program where to CALL the
 * API must never be built from PUBLIC_APP_URL. Before this, the personal API
 * key guide did exactly that, and every guide sent people's assistants to a
 * dead address.
 *
 * The rule: use the host the request arrived on (x-forwarded-host behind a
 * proxy, else Host) when it is one of our known API hosts; otherwise the
 * configured API origin; otherwise the production API. A spoofed Host can only
 * pick between our own API hosts, never send someone elsewhere.
 *
 * Returns an origin with no trailing slash and no /api/v1 (callers add it).
 */
// The main API address since 25 Nov 2026 (the old api.ticketpulse.bgcsaas.com
// stays bound to the same App Service and is still accepted below).
export const PRODUCTION_API_ORIGIN = 'https://api.ticketpulse.bgcsi.com';

const KNOWN_API_HOSTS = new Set([
  'api.ticketpulse.bgcsaas.com',
  'api.ticketpulse.bgcsi.com',
  'ticket-pulse-app.azurewebsites.net',
]);
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/i;

const clean = (v) => String(v || '').trim().replace(/\/+$/, '');

/**
 * The API origin from settings alone (no request): PUBLIC_API_URL, then
 * GRAPH_NOTIFICATION_BASE_URL, then the production API in production, else ''
 * (local development). Moved here from approvalNoteImages (which re-exports it,
 * Teams fetches approval pictures from here) so this helper needs no Prisma.
 */
export function apiPublicOrigin(env = process.env) {
  const explicit = clean(env.PUBLIC_API_URL || env.GRAPH_NOTIFICATION_BASE_URL);
  if (explicit) return explicit;
  return env.NODE_ENV === 'production' ? PRODUCTION_API_ORIGIN : '';
}

function parseOrigin(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u : null;
  } catch { return null; }
}

/** `host[:port]` from a header value → URL, or null when it isn't a bare host. */
function parseHostHeader(value) {
  const raw = String(value || '').split(',')[0].trim();
  if (!raw || /[/\\@?#\s]/.test(raw)) return null;
  const u = parseOrigin(`http://${raw}`);
  return u && u.host.toLowerCase() === raw.toLowerCase() ? u : null;
}

function configuredOrigins(env) {
  return [env.API_PUBLIC_URL, env.PUBLIC_API_URL, env.GRAPH_NOTIFICATION_BASE_URL]
    .map((v) => parseOrigin(clean(v)))
    .filter(Boolean);
}

/** The origin to answer with for one request host, or null when it isn't ours. */
function originForHost(hostUrl, proto, env) {
  const hostname = hostUrl.hostname.toLowerCase();
  if (KNOWN_API_HOSTS.has(hostname)) return `https://${hostname}`;
  const configured = configuredOrigins(env).find((u) => u.host.toLowerCase() === hostUrl.host.toLowerCase());
  if (configured) return configured.origin;
  if (env.NODE_ENV !== 'production' && LOCAL_HOST.test(hostname)) {
    return `${proto === 'https' ? 'https' : 'http'}://${hostUrl.host.toLowerCase()}`;
  }
  return null;
}

/** True when `host` (a hostname, `host:port` or URL) is a known API host. */
export function isKnownApiHost(host, env = process.env) {
  const u = /^https?:\/\//i.test(String(host || '')) ? parseOrigin(host) : parseHostHeader(host);
  return Boolean(u && originForHost(u, u.protocol.replace(':', ''), env));
}

/**
 * @param {import('express').Request|null} req  the request that asked (may be null)
 * @param {{env?: object}} [opts]
 * @returns {string} e.g. https://api.ticketpulse.bgcsaas.com
 */
export function resolveApiPublicBase(req, { env = process.env } = {}) {
  if (req && typeof req.get === 'function') {
    const proto = String(req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim().toLowerCase();
    for (const header of ['x-forwarded-host', 'host']) {
      const hostUrl = parseHostHeader(req.get(header));
      const origin = hostUrl && originForHost(hostUrl, proto, env);
      if (origin) return origin;
    }
  }
  return clean(env.API_PUBLIC_URL) || apiPublicOrigin(env) || PRODUCTION_API_ORIGIN;
}

export default resolveApiPublicBase;
