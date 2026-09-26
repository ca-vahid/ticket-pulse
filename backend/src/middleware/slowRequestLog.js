import logger from '../utils/logger.js';

/**
 * Slow-request log (QA 09-25 slow agent page).
 *
 * The per-request access log runs at `http` level, which production drops, so
 * nobody could see which API call took 10 s. This logs a single `warn` line
 * for any request slower than the threshold, with the ROUTE path only — never
 * the query string (public token pages and API keys can carry secrets there).
 *
 * Streams are skipped: the SSE channel (/api/sse) and anything answered as
 * text/event-stream stay open for minutes by design.
 */
export const SLOW_REQUEST_MS = 1500;

function routePath(req) {
  // Prefer the matched Express pattern (/api/dashboard/technician/:id/weekly)
  // so log lines group per endpoint and carry no ids or tokens.
  if (req.route?.path && typeof req.route.path === 'string') {
    return `${req.baseUrl || ''}${req.route.path}`;
  }
  const url = req.originalUrl || req.url || '';
  const q = url.indexOf('?');
  return redactPath(q === -1 ? url : url.slice(0, q));
}

// No route matched (404s, static, public token pages): the raw path may
// carry a token, so long or token-shaped segments become ':token' (review N6).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{16,}$/i;
const TOKENISH_RE = /^[A-Za-z0-9_-]{16,}$/;
const ROUTE_WORD_RE = /^[a-z]+(-[a-z]+)*$/;

function looksLikeToken(segment) {
  if (!segment) return false;
  // Plain route words (notification-workflows) stay readable at any length.
  if (ROUTE_WORD_RE.test(segment)) return false;
  if (segment.length > 20) return true;
  if (UUID_RE.test(segment) || HEX_RE.test(segment)) return true;
  // Mixed letters + digits of token length (base64url / nanoid style).
  return TOKENISH_RE.test(segment) && /[0-9]/.test(segment) && /[A-Za-z]/.test(segment);
}

export function redactPath(path) {
  return String(path || '')
    .split('/')
    .map((segment) => {
      let decoded = segment;
      try { decoded = decodeURIComponent(segment); } catch { /* keep raw */ }
      return looksLikeToken(decoded) ? ':token' : segment;
    })
    .join('/');
}

function isStream(req, res) {
  const path = req.originalUrl || req.url || '';
  if (path === '/api/sse' || path.startsWith('/api/sse/') || path.startsWith('/api/sse?')) return true;
  const type = String(res.getHeader?.('content-type') || '');
  return type.includes('text/event-stream');
}

export function slowRequestLog({ thresholdMs = SLOW_REQUEST_MS, now = () => Date.now() } = {}) {
  return (req, res, next) => {
    const started = now();
    res.on('finish', () => {
      const ms = now() - started;
      if (ms <= thresholdMs) return;
      if (isStream(req, res)) return;
      logger.warn('Slow request', {
        method: req.method,
        path: routePath(req),
        status: res.statusCode,
        ms,
      });
    });
    next();
  };
}

export default slowRequestLog;
