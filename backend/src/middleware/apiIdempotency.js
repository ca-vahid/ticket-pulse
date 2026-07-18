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

function principalBucket(req) {
  if (req.apiKey?.id) return `key:${req.apiKey.id}`;
  if (req.apiKey?.oauthClientId) return `oauth:${req.apiKey.oauthClientId}`;
  return null;
}

export async function withIdempotency(req, res, next) {
  const idemKey = String(req.headers['idempotency-key'] || '').trim();
  if (!idemKey) return next(); // opt-in
  if (idemKey.length > 255) return next(problems.badRequest('Idempotency-Key must be 255 characters or fewer'));
  const principal = principalBucket(req);
  if (!principal) return next(); // no credential context (shouldn't happen post-auth)

  const requestHash = crypto.createHash('sha256')
    .update(`${req.method} ${req.originalUrl} ${stableStringify(req.body || {})}`)
    .digest('hex');
  const where = { principal_idemKey: { principal, idemKey } };

  try {
    // Reserve the key BEFORE executing so a concurrent duplicate collides here
    // instead of both running the write.
    try {
      await prisma.apiIdempotencyKey.create({
        data: {
          principal, apiKeyId: req.apiKey?.id ?? null, idemKey, method: req.method,
          path: String(req.originalUrl).slice(0, 500), requestHash, statusCode: null, responseBody: null,
        },
      });
    } catch {
      // Unique clash: a prior (completed) or concurrent (in-flight) request holds it.
      const existing = await prisma.apiIdempotencyKey.findUnique({ where });
      if (!existing) return next(); // swept between create and read — just proceed
      if (existing.requestHash !== requestHash) {
        return next(new ApiProblem({
          status: 422, code: 'idempotency_key_reused', title: 'Idempotency-Key reused',
          detail: 'This Idempotency-Key was already used with a different request body.',
        }));
      }
      if (existing.statusCode === null) {
        return next(new ApiProblem({
          status: 409, code: 'idempotency_in_flight', title: 'Request already in progress',
          detail: 'A request with this Idempotency-Key is still being processed. Retry shortly.',
        }));
      }
      res.set('Idempotent-Replayed', 'true');
      return res.status(existing.statusCode).json(existing.responseBody);
    }

    // We hold the reservation — capture the body and finalize (or release) on finish.
    const origJson = res.json.bind(res);
    res.json = (body) => { res._idemBody = body; return origJson(body); };
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300 && res._idemBody !== undefined) {
        prisma.apiIdempotencyKey.update({ where, data: { statusCode: res.statusCode, responseBody: res._idemBody } }).catch(() => {});
      } else {
        // Non-2xx or no JSON: release the reservation so the client can retry.
        prisma.apiIdempotencyKey.delete({ where }).catch(() => {});
      }
    });
    return next();
  } catch {
    return next(); // fail-open on unexpected idempotency errors — never block the write
  }
}

export default { withIdempotency };
