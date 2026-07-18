import crypto from 'node:crypto';
import prisma from '../services/prisma.js';
import { hashApiKey, scopeSatisfies, keyUsable } from '../services/apiKeyService.js';
import rateLimiter from '../services/apiRateLimitService.js';
import { problems } from '../utils/apiProblem.js';

/**
 * Authentication + authorization + rate limiting for the public API (/api/v1).
 * Replaces the inline guard that used to live in the route file. Resolves a
 * `Bearer` key to a workspace, enforces enabled/expiry/revocation + IP
 * allowlist + wildcard scopes, and applies durable per-key and per-IP limits
 * with standard `X-RateLimit-*` headers.
 */

const DEFAULT_KEY_LIMIT = Number(process.env.API_V1_RATE_LIMIT_PER_MINUTE || 120);
const IP_LIMIT = Number(process.env.API_V1_IP_RATE_LIMIT_PER_MINUTE || 300);

export function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (fwd || req.socket?.remoteAddress || '').replace(/^::ffff:/, '') || null;
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  return parts.reduce((acc, p) => {
    const n = Number(p);
    return acc === null || Number.isNaN(n) || n < 0 || n > 255 ? null : (acc << 8) + n;
  }, 0) >>> 0;
}

export function ipAllowed(ip, allowlist) {
  if (!ip) return false;
  for (const entry of allowlist) {
    if (entry === ip) return true;
    if (entry.includes('/')) {
      const [range, bitsStr] = entry.split('/');
      const bits = Number(bitsStr);
      const ipInt = ipv4ToInt(ip); const rangeInt = ipv4ToInt(range);
      if (ipInt === null || rangeInt === null || Number.isNaN(bits)) continue;
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      if ((ipInt & mask) === (rangeInt & mask)) return true;
    }
  }
  return false;
}

function setRateHeaders(res, r) {
  res.set('X-RateLimit-Limit', String(r.limit));
  res.set('X-RateLimit-Remaining', String(r.remaining));
  res.set('X-RateLimit-Reset', String(r.reset));
}

/** Router-level: attach a request id, and log usage/audit on response finish. */
export function apiRequestContext(req, res, next) {
  const rid = String(req.headers['x-request-id'] || '').slice(0, 64)
    || `req_${crypto.randomBytes(9).toString('base64url')}`;
  res.set('X-Request-Id', rid);
  req.apiRequestId = rid;
  const startedAt = Date.now();
  res.on('finish', () => {
    prisma.apiRequestLog.create({
      data: {
        workspaceId: req.workspaceId || null,
        apiKeyId: req.apiKey?.id || null,
        method: req.method,
        path: (req.baseUrl || '') + (req.route?.path || req.path || ''),
        scope: req.apiScope || null,
        statusCode: res.statusCode,
        ip: clientIp(req)?.slice(0, 64) || null,
        requestId: rid,
        durationMs: Date.now() - startedAt,
      },
    }).catch(() => {});
  });
  next();
}

/** Factory: `requireApiKey('tickets:write')` — auth + scope + rate limit. */
export const requireApiKey = (scope) => async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    const looksLikeKey = raw && (/^tp_(live|test)_/.test(raw) || raw.startsWith('tpk_'));
    if (!looksLikeKey) {
      throw problems.unauthorized('Provide an API key: Authorization: Bearer tp_live_…', 'api_key_required');
    }
    const key = await prisma.apiKey.findUnique({ where: { keyHash: hashApiKey(raw) } });
    if (!keyUsable(key)) {
      throw problems.unauthorized('Unknown, disabled, revoked, or expired API key', 'invalid_api_key');
    }

    const ip = clientIp(req);
    if (key.ipAllowlist?.length && !ipAllowed(ip, key.ipAllowlist)) {
      throw problems.forbidden('Request IP is not in this key’s allowlist', 'ip_not_allowed');
    }
    // `scope` may be a single scope or an array (any-of).
    const required = Array.isArray(scope) ? scope : (scope ? [scope] : []);
    if (required.length && !required.some((s) => scopeSatisfies(key.scopes, s))) {
      throw problems.forbidden(`This key is missing the '${required.join("' or '")}' scope`, 'insufficient_scope');
    }

    const limit = key.rateLimitPerMin || DEFAULT_KEY_LIMIT;
    const rk = await rateLimiter.hit(`key:${key.id}`, limit);
    setRateHeaders(res, rk);
    if (!rk.allowed) {
      throw problems.rateLimited(`Rate limit is ${limit} requests/minute for this key`, Math.max(1, rk.reset - Math.floor(Date.now() / 1000)));
    }
    if (ip) {
      const ri = await rateLimiter.hit(`ip:${ip}`, IP_LIMIT);
      if (!ri.allowed) {
        throw problems.rateLimited('Too many requests from this IP', Math.max(1, ri.reset - Math.floor(Date.now() / 1000)));
      }
    }

    req.apiKey = key;
    req.workspaceId = key.workspaceId;
    req.apiMode = key.mode;
    req.apiScope = (Array.isArray(scope) ? scope.join('|') : scope) || null;
    req.clientIp = ip;
    prisma.apiKey.update({
      where: { id: key.id },
      data: { lastUsedAt: new Date(), lastUsedIp: ip?.slice(0, 64) || null, requestCount: { increment: 1 } },
    }).catch(() => {});
    next();
  } catch (err) {
    next(err);
  }
};

export default { requireApiKey, apiRequestContext, clientIp, ipAllowed };
