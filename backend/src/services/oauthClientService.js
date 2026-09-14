import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import prisma from './prisma.js';
import config from '../config/index.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import { validateScopes } from './apiKeyService.js';

/**
 * Built-in OAuth2 client-credentials. Each client is bound to ONE workspace and
 * a scope set; exchanging its client_id + client_secret yields a short-lived,
 * stateless JWT access token carrying that workspace + scopes. Tokens are signed
 * with a secret distinct from the user-session secret so the two can never be
 * used interchangeably. Revoking/disabling a client is honored immediately
 * (the token is re-checked against the live client on every request).
 */

// Prefer a dedicated secret. Falling back to a SESSION_SECRET derivative means
// rotating the session secret silently invalidates every live access token, so
// warn loudly in production when the dedicated secret is unset.
if (process.env.NODE_ENV === 'production' && !process.env.API_OAUTH_SECRET) {
  // eslint-disable-next-line no-console
  console.warn('[oauth] API_OAUTH_SECRET is unset — deriving from SESSION_SECRET. Set API_OAUTH_SECRET in production so session-secret rotation does not invalidate API tokens.');
}
const OAUTH_SECRET = process.env.API_OAUTH_SECRET || `${config.session.secret}:tp-api-oauth`;
const TOKEN_TTL_SEC = Number(process.env.API_OAUTH_TOKEN_TTL_SEC || 3600);
const TOKEN_TYP = 'tp_api_oauth';

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV4_CIDR = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}\/(3[0-2]|[12]?\d)$/;
const ALLOWLIST_MAX = 64;

/**
 * IP allowlist for a client (Simorgh A2). Accepts an array or a comma /
 * newline separated string; each entry an IPv4 address or IPv4 CIDR. Empty =
 * no restriction. Same rule the API-key allowlist enforces in apiKeyAuth.
 */
export function validateAllowlist(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/);
  const clean = [...new Set(list.map((v) => String(v || '').trim()).filter(Boolean))];
  if (clean.length > ALLOWLIST_MAX) throw new ValidationError(`At most ${ALLOWLIST_MAX} allowlist entries`);
  for (const entry of clean) {
    if (!IPV4.test(entry) && !IPV4_CIDR.test(entry)) throw new ValidationError(`Not an IPv4 address or CIDR: "${entry}"`);
  }
  return clean;
}

/** Optional default arrival channel for tickets this client creates (Simorgh B8). */
export function validateDefaultSource(input) {
  if (input === null || input === undefined || input === '') return null;
  const n = Number(input);
  if (!Number.isInteger(n) || n < 1 || n > 9999) throw new ValidationError('defaultSource must be a positive integer source code');
  return n;
}

export function hashSecret(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

export function generateClient() {
  const clientId = `tpc_${crypto.randomBytes(12).toString('hex')}`;
  const secret = `tps_${crypto.randomBytes(24).toString('base64url')}`;
  return { clientId, secret, secretHash: hashSecret(secret), secretPrefix: secret.slice(0, 12) };
}

export function clientUsable(client) {
  if (!client || !client.isEnabled || client.revokedAt) return false;
  if (client.expiresAt && new Date(client.expiresAt).getTime() <= Date.now()) return false;
  return true;
}

function timingSafeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function shape(client, secret = null) {
  return {
    id: client.id, name: client.name, clientId: client.clientId, secretPrefix: client.secretPrefix,
    scopes: client.scopes, isEnabled: client.isEnabled, revokedAt: client.revokedAt || null,
    trustedIntake: client.trustedIntake === true,
    ipAllowlist: Array.isArray(client.ipAllowlist) ? client.ipAllowlist : [],
    defaultSource: client.defaultSource ?? null,
    expiresAt: client.expiresAt, lastUsedAt: client.lastUsedAt, tokenCount: client.tokenCount,
    createdBy: client.createdBy, createdAt: client.createdAt,
    ...(secret ? { clientSecret: secret } : {}),
  };
}

/** Validate credentials → the client row, or null. Constant-time secret check. */
export async function verifyClientCredentials(clientId, rawSecret) {
  if (!clientId || !rawSecret) return null;
  const client = await prisma.oAuthClient.findUnique({ where: { clientId } });
  if (!clientUsable(client)) return null;
  if (!timingSafeEqualHex(client.clientSecretHash, hashSecret(rawSecret))) return null;
  return client;
}

export function issueAccessToken(client) {
  const token = jwt.sign(
    { typ: TOKEN_TYP, cid: client.clientId, wsid: client.workspaceId, scopes: client.scopes, name: client.name },
    OAUTH_SECRET,
    { algorithm: 'HS256', expiresIn: TOKEN_TTL_SEC },
  );
  prisma.oAuthClient.update({ where: { id: client.id }, data: { lastUsedAt: new Date(), tokenCount: { increment: 1 } } }).catch(() => {});
  return { access_token: token, token_type: 'Bearer', expires_in: TOKEN_TTL_SEC, scope: (client.scopes || []).join(' ') };
}

/** Verify a bearer access token → claims, or throws. Confirms typ + signature. */
export function verifyAccessToken(token) {
  const claims = jwt.verify(token, OAUTH_SECRET, { algorithms: ['HS256'] });
  if (claims.typ !== TOKEN_TYP) throw new Error('not an API OAuth token');
  return claims;
}

class OAuthClientService {
  async list(workspaceId) {
    const rows = await prisma.oAuthClient.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
    return rows.map((c) => shape(c));
  }

  async create(workspaceId, {
    name, scopes, expiresInDays = null, trustedIntake = false, ipAllowlist = [], defaultSource = null,
  }, actor) {
    const trimmed = String(name || '').trim();
    if (trimmed.length < 3) throw new ValidationError('Client name must be at least 3 characters');
    const cleanScopes = validateScopes(scopes);
    const cleanAllowlist = validateAllowlist(ipAllowlist);
    const cleanSource = validateDefaultSource(defaultSource);
    if (!cleanScopes.length) throw new ValidationError('Grant at least one scope');
    const { clientId, secret, secretHash, secretPrefix } = generateClient();
    const client = await prisma.oAuthClient.create({
      data: {
        workspaceId, name: trimmed, clientId, clientSecretHash: secretHash, secretPrefix,
        trustedIntake: trustedIntake === true, ipAllowlist: cleanAllowlist, defaultSource: cleanSource,
        scopes: cleanScopes,
        expiresAt: expiresInDays ? new Date(Date.now() + Number(expiresInDays) * 86400000) : null,
        createdBy: actor?.email || null,
      },
    });
    return shape(client, secret);
  }

  async update(id, workspaceId, patch) {
    const client = await prisma.oAuthClient.findFirst({ where: { id: Number(id), workspaceId } });
    if (!client) throw new NotFoundError('OAuth client not found');
    const data = {};
    if (patch.name !== undefined) data.name = String(patch.name).trim();
    if (patch.isEnabled !== undefined) data.isEnabled = patch.isEnabled !== false;
    if (patch.scopes !== undefined) data.scopes = validateScopes(patch.scopes);
    if (patch.trustedIntake !== undefined) data.trustedIntake = patch.trustedIntake === true;
    if (patch.ipAllowlist !== undefined) data.ipAllowlist = validateAllowlist(patch.ipAllowlist);
    if (patch.defaultSource !== undefined) data.defaultSource = validateDefaultSource(patch.defaultSource);
    const updated = await prisma.oAuthClient.update({ where: { id: client.id }, data });
    return shape(updated);
  }

  /** Rotate the client secret in place. Refuses a revoked client (rotating used
   *  to silently un-revoke + re-enable it); preserves the enabled/disabled state. */
  async rotate(id, workspaceId) {
    const client = await prisma.oAuthClient.findFirst({ where: { id: Number(id), workspaceId } });
    if (!client) throw new NotFoundError('OAuth client not found');
    if (client.revokedAt) throw new ValidationError('This client was revoked and cannot be rotated — create a new client instead');
    const { secret, secretHash, secretPrefix } = generateClient();
    const updated = await prisma.oAuthClient.update({
      where: { id: client.id }, data: { clientSecretHash: secretHash, secretPrefix },
    });
    return shape(updated, secret);
  }

  async revoke(id, workspaceId) {
    const client = await prisma.oAuthClient.findFirst({ where: { id: Number(id), workspaceId } });
    if (!client) throw new NotFoundError('OAuth client not found');
    await prisma.oAuthClient.update({ where: { id: client.id }, data: { isEnabled: false, revokedAt: new Date() } });
    return { revoked: true };
  }

  async remove(id, workspaceId) {
    const client = await prisma.oAuthClient.findFirst({ where: { id: Number(id), workspaceId } });
    if (!client) throw new NotFoundError('OAuth client not found');
    await prisma.oAuthClient.delete({ where: { id: client.id } });
    return { deleted: true };
  }
}

export default new OAuthClientService();
export { OAuthClientService, TOKEN_TTL_SEC };
