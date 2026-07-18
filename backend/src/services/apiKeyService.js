import crypto from 'node:crypto';
import prisma from './prisma.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';

/**
 * API key lifecycle for the public API. Keys are stored as sha256 hashes only;
 * the raw secret (`tp_live_…` / `tp_test_…`) is shown once at creation/rotation.
 * Scopes are `resource:action` with wildcard support (`tickets:*`, `*:read`, `*`).
 */

// Full scope catalogue advertised to integrators (deny-by-default).
export const API_KEY_SCOPES = [
  'tickets:read', 'tickets:write',
  'conversations:read', 'conversations:write',
  'contacts:read',
  'agents:read', 'groups:read',
  'tags:read', 'tags:write',
  'categories:read', 'types:read',
  'tasks:read', 'tasks:write',
  'timeentries:read', 'timeentries:write',
  'approvals:read', 'approvals:write',
  'attachments:read', 'attachments:write',
  'webhooks:read', 'webhooks:manage',
  'search:read',
];

// Legacy scopes still honored so existing keys keep working.
const LEGACY_SCOPE_ALIASES = {
  'tickets:notes': 'conversations:write',
  'tickets:attachments': 'attachments:read',
};

export function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(String(rawKey)).digest('hex');
}

/** Generate a raw key + its stored hash + display prefix. mode ∈ live|test. */
export function generateApiKey(mode = 'live') {
  const label = mode === 'test' ? 'test' : 'live';
  const raw = `tp_${label}_${crypto.randomBytes(24).toString('base64url')}`;
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, 16) };
}

/** Does `granted` (the key's scopes) satisfy the `required` scope? Wildcard-aware. */
export function scopeSatisfies(granted, required) {
  if (!required) return true;
  const set = new Set((granted || []).map((s) => LEGACY_SCOPE_ALIASES[s] || s));
  if (set.has('*')) return true;
  if (set.has(required)) return true;
  const [res, act] = required.split(':');
  return set.has(`${res}:*`) || set.has(`*:${act}`);
}

export function validateScopes(scopes) {
  const list = Array.isArray(scopes) ? [...new Set(scopes.map((s) => String(s).trim()).filter(Boolean))] : [];
  const known = new Set([...API_KEY_SCOPES, ...Object.keys(LEGACY_SCOPE_ALIASES), '*']);
  const bad = list.filter((s) => !known.has(s) && !/^[a-z]+:\*$/.test(s) && !/^\*:[a-z]+$/.test(s));
  if (bad.length) throw new ValidationError(`Unknown scope(s): ${bad.join(', ')}`);
  return list;
}

/** A key is usable only if enabled, not revoked, and not expired. */
export function keyUsable(key) {
  if (!key || !key.isEnabled || key.revokedAt) return false;
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) return false;
  return true;
}

function shape(key, raw = null) {
  return {
    id: key.id,
    name: key.name,
    prefix: key.keyPrefix,
    mode: key.mode,
    scopes: key.scopes,
    isEnabled: key.isEnabled,
    expiresAt: key.expiresAt,
    revokedAt: key.revokedAt || null,
    ipAllowlist: key.ipAllowlist || [],
    rateLimitPerMin: key.rateLimitPerMin || null,
    lastUsedAt: key.lastUsedAt,
    requestCount: key.requestCount,
    createdBy: key.createdBy,
    createdAt: key.createdAt,
    ...(raw ? { key: raw } : {}),
  };
}

class ApiKeyService {
  async list(workspaceId) {
    const keys = await prisma.apiKey.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
    return keys.map((k) => shape(k));
  }

  async create(workspaceId, { name, scopes, mode = 'live', expiresInDays = null, ipAllowlist = [], rateLimitPerMin = null }, actor) {
    const trimmed = String(name || '').trim();
    if (trimmed.length < 3) throw new ValidationError('Key name must be at least 3 characters');
    const cleanScopes = validateScopes(scopes);
    if (!cleanScopes.length) throw new ValidationError('Grant at least one scope');
    const keyMode = mode === 'test' ? 'test' : 'live';
    const { raw, hash, prefix } = generateApiKey(keyMode);
    const expiresAt = expiresInDays ? new Date(Date.now() + Number(expiresInDays) * 86400000) : null;
    const key = await prisma.apiKey.create({
      data: {
        workspaceId, name: trimmed, keyHash: hash, keyPrefix: prefix,
        scopes: cleanScopes, mode: keyMode, expiresAt,
        ipAllowlist: Array.isArray(ipAllowlist) ? ipAllowlist.filter(Boolean) : [],
        rateLimitPerMin: rateLimitPerMin ? Number(rateLimitPerMin) : null,
        createdBy: actor?.email || null,
      },
    });
    return shape(key, raw);
  }

  async update(id, workspaceId, patch) {
    const key = await prisma.apiKey.findFirst({ where: { id: Number(id), workspaceId } });
    if (!key) throw new NotFoundError('API key not found');
    const data = {};
    if (patch.name !== undefined) data.name = String(patch.name).trim();
    if (patch.isEnabled !== undefined) data.isEnabled = patch.isEnabled !== false;
    if (patch.scopes !== undefined) data.scopes = validateScopes(patch.scopes);
    if (patch.ipAllowlist !== undefined) data.ipAllowlist = Array.isArray(patch.ipAllowlist) ? patch.ipAllowlist.filter(Boolean) : [];
    if (patch.rateLimitPerMin !== undefined) data.rateLimitPerMin = patch.rateLimitPerMin ? Number(patch.rateLimitPerMin) : null;
    if (patch.expiresInDays !== undefined) data.expiresAt = patch.expiresInDays ? new Date(Date.now() + Number(patch.expiresInDays) * 86400000) : null;
    const updated = await prisma.apiKey.update({ where: { id: key.id }, data });
    return shape(updated);
  }

  /** Rotate: mint a new secret on the same key, keeping id/scopes; raw shown once.
   *  Refuses to rotate a REVOKED key — rotating used to silently un-revoke +
   *  re-enable it, re-arming a credential an admin had killed. Create a fresh key
   *  instead. The key's current enabled/disabled state is preserved. */
  async rotate(id, workspaceId) {
    const key = await prisma.apiKey.findFirst({ where: { id: Number(id), workspaceId } });
    if (!key) throw new NotFoundError('API key not found');
    if (key.revokedAt) throw new ValidationError('This key was revoked and cannot be rotated — create a new key instead');
    const { raw, hash, prefix } = generateApiKey(key.mode);
    const updated = await prisma.apiKey.update({
      where: { id: key.id },
      data: { keyHash: hash, keyPrefix: prefix },
    });
    return shape(updated, raw);
  }

  async revoke(id, workspaceId) {
    const key = await prisma.apiKey.findFirst({ where: { id: Number(id), workspaceId } });
    if (!key) throw new NotFoundError('API key not found');
    await prisma.apiKey.update({ where: { id: key.id }, data: { isEnabled: false, revokedAt: new Date() } });
    return { revoked: true };
  }

  async remove(id, workspaceId) {
    const key = await prisma.apiKey.findFirst({ where: { id: Number(id), workspaceId } });
    if (!key) throw new NotFoundError('API key not found');
    await prisma.apiKey.delete({ where: { id: key.id } });
    return { deleted: true };
  }
}

export default new ApiKeyService();
export { ApiKeyService };
