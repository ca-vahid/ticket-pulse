import crypto from 'node:crypto';
import prisma from '../services/prisma.js';
import { ApiProblem, problems } from '../utils/apiProblem.js';

/**
 * Idempotency-Key support for public-API writes (opt-in via the header). On the
 * first request the response is executed and cached (keyed by api key + idem
 * key, 24h TTL sweep). A retry with the same key replays the stored response
 * instead of re-executing — so a client retry never double-creates a ticket.
 * Reusing a key with a *different* body is rejected. Apply AFTER requireApiKey.
 */

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function withIdempotency(req, res, next) {
  const idemKey = String(req.headers['idempotency-key'] || '').trim();
  if (!idemKey) return next(); // opt-in
  if (idemKey.length > 255) return next(problems.badRequest('Idempotency-Key must be 255 characters or fewer'));
  if (!req.apiKey) return next();

  const requestHash = crypto.createHash('sha256')
    .update(`${req.method} ${req.originalUrl} ${stableStringify(req.body || {})}`)
    .digest('hex');

  prisma.apiIdempotencyKey.findUnique({
    where: { apiKeyId_idemKey: { apiKeyId: req.apiKey.id, idemKey } },
  }).then((existing) => {
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return next(new ApiProblem({
          status: 422, code: 'idempotency_key_reused', title: 'Idempotency-Key reused',
          detail: 'This Idempotency-Key was already used with a different request body.',
        }));
      }
      res.set('Idempotent-Replayed', 'true');
      return res.status(existing.statusCode).json(existing.responseBody);
    }
    // First time: capture the response body, persist on a successful finish.
    const origJson = res.json.bind(res);
    res.json = (body) => { res._idemBody = body; return origJson(body); };
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300 && res._idemBody !== undefined) {
        prisma.apiIdempotencyKey.create({
          data: {
            apiKeyId: req.apiKey.id, idemKey, method: req.method,
            path: String(req.originalUrl).slice(0, 500), requestHash,
            statusCode: res.statusCode, responseBody: res._idemBody,
          },
        }).catch(() => {}); // unique clash on concurrent retry → ignore
      }
    });
    return next();
  }).catch(() => next());
}

export default { withIdempotency };
