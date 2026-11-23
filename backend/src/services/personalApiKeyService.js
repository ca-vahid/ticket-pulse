import crypto from 'node:crypto';
import prisma from './prisma.js';
import settingsRepository from './settingsRepository.js';
import logger from '../utils/logger.js';
import { hashApiKey, scopeSatisfies } from './apiKeyService.js';
import { parseViewerIds } from './dashboardViewerService.js';
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from '../utils/errors.js';
import { problems } from '../utils/apiProblem.js';

/**
 * Personal API keys (4.4.05, plans/PERSONAL_API_KEYS_PLAN.md + the owner's
 * changes of 22 Nov).
 *
 * A personal key IS one person in one workspace. Every /api/v1 call made with
 * it runs as that person (the same actor the app builds when they are signed
 * in) and is re-checked on every call against:
 *   1. the workspace's list `personal_api_key_users_ws<N>` (JSON technician ids,
 *      the Dashboard-viewer pattern; empty = nobody),
 *   2. the person's access in the workspace right now (an active agent profile,
 *      a workspace_access row, or the super-admin list),
 *   3. their role right now: read-only people keep the read scopes only.
 * The key's scopes are an upper bound; no admin power ever goes through one.
 *
 * One key per person per workspace. Rotating replaces it (the old row is
 * revoked with reason 'rotated', a new row carries the same settings).
 */

export const PERSONAL_KEY_PREFIX = 'tpu_';
export const PERSONAL_KEY_RATE_LIMIT = 60;
export const MAX_PERSONAL_KEYS = 1;
export const EXPIRY_OPTIONS = Object.freeze([30, 90, 180, 365]);
export const DEFAULT_EXPIRY_DAYS = 90;
export const EXPIRY_WARNING_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const READ_SCOPES = Object.freeze([
  'tickets:read', 'conversations:read', 'attachments:read',
  'agents:read', 'groups:read', 'categories:read', 'types:read', 'tags:read', 'contacts:read',
  'search:read',
]);

/** What a personal key can do, in the words the screen shows. `read` is always on. */
export const ABILITIES = Object.freeze([
  {
    id: 'read',
    label: 'Read tickets and conversations',
    description: 'The tickets you see in the app, their conversations and attachments, and the agents, groups, categories, types and tags lists.',
    scopes: READ_SCOPES,
    locked: true,
  },
  {
    id: 'reply',
    label: 'Reply to requesters and add notes',
    description: 'Replies go out as you, with your signature and the app’s e-mail template.',
    scopes: Object.freeze(['conversations:write', 'attachments:write']),
    locked: false,
  },
  {
    id: 'update',
    label: 'Update tickets',
    description: 'Status, priority, assignment and fields, as far as your role allows in the app.',
    scopes: Object.freeze(['tickets:write', 'tags:write']),
    locked: false,
  },
  {
    id: 'tasks',
    label: 'Tasks and time',
    description: 'Add, change and finish tasks on tickets.',
    scopes: Object.freeze(['tasks:read', 'tasks:write', 'timeentries:read', 'timeentries:write']),
    locked: false,
  },
]);
export const ABILITY_IDS = Object.freeze(ABILITIES.map((a) => a.id));

/** Every scope a personal key may ever hold (never approvals, custom-field writes, tag creation, webhooks…). */
export const PERSONAL_KEY_MAX_SCOPES = Object.freeze([...new Set(ABILITIES.flatMap((a) => a.scopes))]);

export const PERSONAL_ACTIONS = Object.freeze({
  CREATED: 'personal_key_created',
  ROTATED: 'personal_key_rotated',
  REVOKED: 'personal_key_revoked',
  EXPIRED: 'personal_key_expired',
  DISABLED_BY_ADMIN: 'personal_key_disabled_by_admin',
  ENABLED_BY_ADMIN: 'personal_key_enabled_by_admin',
  ACCESS_GRANTED: 'personal_key_access_granted',
  ACCESS_REMOVED: 'personal_key_access_removed',
});

export const REASONS = Object.freeze({
  NOT_ON_LIST: 'Ask an admin to give you API access.',
  READ_ONLY: 'Your access is read-only, so you can’t make an API key.',
  HAS_KEY: 'You already have a key. Rotate it for a new secret, or revoke it first.',
  DISABLED: 'An admin switched your key off. Ask them about it before you make a new one.',
  NO_ACCESS: 'You no longer have access to this workspace.',
});

// A ValidationError (so the app's error shape carries `details`) answered as 422.
class UnprocessableError extends ValidationError {
  constructor(message, code, details = null) {
    super(message, details);
    this.statusCode = 422;
    this.code = code;
  }
}

// ------------------------------------------------------------------ helpers

const lower = (v) => String(v || '').trim().toLowerCase();

export function personalKeyUsersKey(workspaceId) {
  return `personal_api_key_users_ws${Number(workspaceId)}`;
}

export function isPersonalKeyRaw(raw) {
  return typeof raw === 'string' && raw.startsWith(PERSONAL_KEY_PREFIX);
}

/** A raw secret, its stored hash and the display prefix. */
export function generatePersonalKey() {
  const raw = `${PERSONAL_KEY_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, 12) };
}

export function scopesForAbilities(abilities = []) {
  const wanted = new Set(['read', ...(Array.isArray(abilities) ? abilities : [])]);
  return [...new Set(ABILITIES.filter((a) => wanted.has(a.id)).flatMap((a) => a.scopes))];
}

export function abilitiesFromScopes(scopes = []) {
  const set = new Set(scopes || []);
  return ABILITIES.filter((a) => a.scopes.every((s) => set.has(s))).map((a) => a.id);
}

/** Validate the abilities a person asked for. Unknown ones are refused, never dropped. */
export function validateAbilities(abilities) {
  if (abilities === undefined || abilities === null) return ['read'];
  if (!Array.isArray(abilities)) throw new ValidationError('abilities must be a list');
  const list = [...new Set(abilities.map((a) => String(a).trim()).filter(Boolean))];
  const bad = list.filter((a) => !ABILITY_IDS.includes(a));
  if (bad.length) throw new ValidationError(`A personal key can't have: ${bad.join(', ')}. Choose from ${ABILITY_IDS.join(', ')}.`);
  return ABILITY_IDS.filter((id) => id === 'read' || list.includes(id));
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

export function validateIpAllowlist(list) {
  if (list === undefined || list === null) return [];
  const raw = Array.isArray(list) ? list : String(list).split(/[\n,]/);
  const clean = [...new Set(raw.map((v) => String(v).trim()).filter(Boolean))];
  if (clean.length > 20) throw new ValidationError('At most 20 IP addresses');
  const bad = clean.filter((entry) => {
    const [addr, bits, extra] = entry.split('/');
    if (extra !== undefined) return true;
    if (IPV4.test(addr)) return bits !== undefined && !(/^\d{1,2}$/.test(bits) && Number(bits) <= 32);
    return !(IPV6.test(addr) && addr.includes(':') && bits === undefined);
  });
  if (bad.length) throw new ValidationError(`Not an IP address: ${bad.join(', ')}. Use 203.0.113.7, a range like 203.0.113.0/24, or an IPv6 address.`);
  return clean;
}

export function validateExpiryDays(days) {
  if (days === undefined || days === null || days === '') return DEFAULT_EXPIRY_DAYS;
  const n = Number(days);
  if (!EXPIRY_OPTIONS.includes(n)) throw new ValidationError(`A key lasts ${EXPIRY_OPTIONS.join(', ')} days`);
  return n;
}

export function validateName(name) {
  const clean = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (clean.length < 2) throw new ValidationError('Give the key a name of at least 2 characters');
  if (clean.length > 60) throw new ValidationError('Key names are at most 60 characters');
  return clean;
}

export function keyStatus(key, now = Date.now()) {
  if (!key) return 'revoked';
  if (key.revokedAt) return 'revoked';
  if (!key.isEnabled) return 'disabled';
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= now) return 'expired';
  return 'active';
}

/** The Key object both screens read. Never the hash or the secret. */
export function shapeKey(key, { owner = null } = {}) {
  const scopes = Array.isArray(key.scopes) ? key.scopes : [];
  return {
    id: key.id,
    name: key.name,
    prefix: key.keyPrefix,
    abilities: abilitiesFromScopes(scopes),
    scopes,
    expiresAt: key.expiresAt || null,
    createdAt: key.createdAt || null,
    lastUsedAt: key.lastUsedAt || null,
    lastUsedIp: key.lastUsedIp || null,
    useCount: Number(key.requestCount) || 0,
    ipAllowlist: Array.isArray(key.ipAllowlist) ? key.ipAllowlist : [],
    status: keyStatus(key),
    disabledAt: key.disabledAt || null,
    revokedAt: key.revokedAt || null,
    revokedReason: key.revokedReason || null,
    ...(owner ? { owner } : {}),
  };
}

/** Scopes left after the role cap: a read-only person keeps the reads only. */
export function roleCappedScopes(scopes, { readOnly = false } = {}) {
  const allowed = (scopes || []).filter((s) => PERSONAL_KEY_MAX_SCOPES.includes(s));
  return readOnly ? allowed.filter((s) => /:read$/.test(s)) : allowed;
}

// ------------------------------------------------------- the access list

const LIST_CACHE_TTL_MS = 15_000;
const listCache = new Map(); // workspaceId -> { ids, at }

export async function getListedTechnicianIds(workspaceId, { fresh = false } = {}) {
  const ws = Number(workspaceId);
  if (!Number.isInteger(ws) || ws <= 0) return [];
  const hit = listCache.get(ws);
  if (!fresh && hit && Date.now() - hit.at < LIST_CACHE_TTL_MS) return hit.ids;
  const ids = parseViewerIds(await settingsRepository.get(personalKeyUsersKey(ws)));
  listCache.set(ws, { ids, at: Date.now() });
  return ids;
}

export function resetPersonalKeyCaches() {
  listCache.clear();
}

async function superAdmins() {
  const { superAdminEmails } = await import('./reportRecipients.js');
  return Promise.resolve().then(() => superAdminEmails()).catch(() => []);
}

/**
 * The person's standing in a workspace right now. Used on every v1 call and by
 * the owner routes. Reads are live (the list is cached 15 s).
 */
export async function resolveOwnerAccess(workspaceId, email, { technicianId = null, fresh = false } = {}) {
  const ws = Number(workspaceId);
  const address = lower(email);
  const [ids, technician, workspaceRole, supers] = await Promise.all([
    getListedTechnicianIds(ws, { fresh }),
    prisma.technician.findFirst({
      where: technicianId
        ? { id: Number(technicianId), workspaceId: ws }
        : { workspaceId: ws, email: { equals: address, mode: 'insensitive' } },
      select: { id: true, name: true, email: true, isActive: true },
    }),
    import('./workspaceRepository.js').then(({ default: repo }) => repo.getAccessRole(address, ws)),
    superAdmins(),
  ]);
  const techEmailMatches = Boolean(technician && lower(technician.email) === address);
  const tech = techEmailMatches ? technician : null;
  const superAdmin = supers.includes(address);
  const hasAccess = Boolean(superAdmin || workspaceRole || tech?.isActive);
  const onList = Boolean(tech && ids.includes(tech.id));
  // No admin power ever goes through a personal key: admin is capped at reviewer.
  const rawRole = workspaceRole || (superAdmin ? 'admin' : null);
  const cappedRole = rawRole === 'admin' ? 'reviewer' : rawRole;
  const readOnly = workspaceRole === 'readonly';
  return {
    workspaceId: ws,
    email: address,
    technician: tech,
    workspaceRole: workspaceRole || null,
    cappedRole,
    superAdmin,
    hasAccess,
    onList,
    eligible: Boolean(tech && tech.isActive),
    readOnly,
  };
}

/** The actor a personal-key call runs as: the person, never with admin powers. */
export function buildPersonalActor(access, key) {
  const tech = access.technician;
  return {
    email: access.email,
    name: tech?.name || access.email,
    role: access.cappedRole ? 'viewer' : 'agent',
    workspaceRole: access.cappedRole || null,
    technicianId: tech?.isActive ? tech.id : null,
    kind: access.cappedRole ? 'member' : 'agent',
    trustedIntake: false,
    defaultSource: null,
    via: { kind: 'personal_key', keyId: key.id, keyName: key.name },
  };
}

// ------------------------------------------------------------ v1 auth

/**
 * Turn a `tpu_` secret into the v1 principal. Throws problem+json errors:
 * 401 invalid_api_key (unknown / revoked / off / expired), 403
 * personal_key_not_allowed (not on the list), 403
 * personal_key_owner_has_no_access (no access in the workspace now).
 */
export async function authenticatePersonalKey(raw) {
  const key = await prisma.personalApiKey.findUnique({ where: { keyHash: hashApiKey(raw) } });
  if (!key || key.revokedAt) throw problems.unauthorized('Unknown or revoked personal API key', 'invalid_api_key');
  if (!key.isEnabled) throw problems.unauthorized('This personal API key was switched off by an admin', 'invalid_api_key');
  if (new Date(key.expiresAt).getTime() <= Date.now()) {
    await noteExpired(key).catch(() => {});
    throw problems.unauthorized(`This personal API key expired on ${new Date(key.expiresAt).toISOString().slice(0, 10)}. Make a new one in your profile.`, 'invalid_api_key');
  }
  const access = await resolveOwnerAccess(key.workspaceId, key.ownerEmail, { technicianId: key.technicianId });
  if (!access.onList) {
    throw problems.forbidden('Your API access was removed in this workspace. Ask an admin to give it back.', 'personal_key_not_allowed');
  }
  // A key needs an ACTIVE agent profile on every call (review 73f06f8b #2): a
  // switched-off technician who keeps a workspace_access row is refused too.
  if (!access.hasAccess || !access.eligible) {
    throw problems.forbidden('The person this key belongs to no longer has access to this workspace.', 'personal_key_owner_has_no_access');
  }
  const scopes = roleCappedScopes(key.scopes, access);
  return {
    key,
    access,
    actor: buildPersonalActor(access, key),
    scopes,
    keyScopes: roleCappedScopes(key.scopes),
    abilities: abilitiesFromScopes(key.scopes),
  };
}

/** Did the role cap (not the key) take away the scope this call needs? */
export function refusedByRole(keyScopes, required) {
  return required.some((s) => scopeSatisfies(keyScopes, s));
}

/** Usage counters, fire and forget. */
export function recordUse(keyId, ip) {
  Promise.resolve()
    .then(() => prisma.personalApiKey.update({
      where: { id: keyId },
      data: { lastUsedAt: new Date(), lastUsedIp: ip ? String(ip).slice(0, 64) : null, requestCount: { increment: 1 } },
    }))
    .catch(() => {});
}

// ------------------------------------------------------------ audit + mail

async function audit({ workspaceId, actorEmail, action, key = null, targetEmail = null, targetLabel = null, extra = {} }) {
  const mod = await import('./accessAuditService.js');
  if (key) {
    return mod.recordCredentialEvent({
      workspaceId,
      actorEmail,
      action,
      credential: { id: key.id, name: key.name, keyPrefix: key.keyPrefix, scopes: key.scopes, ipAllowlist: key.ipAllowlist, expiresAt: key.expiresAt, ownerEmail: key.ownerEmail },
      extra: { kind: 'personal_key', ownerEmail: key.ownerEmail, ...extra },
      targetEmail: key.ownerEmail,
    });
  }
  return mod.recordAccessEvent({ workspaceId, actorEmail, action, targetEmail, targetLabel, details: { kind: 'personal_key', ...extra } });
}

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function dayPacific(d) {
  return new Date(d).toLocaleDateString('en-US', { timeZone: 'America/Vancouver', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

async function workspaceName(workspaceId) {
  const ws = await Promise.resolve()
    .then(() => prisma.workspace.findUnique({ where: { id: Number(workspaceId) }, select: { name: true } }))
    .catch(() => null);
  return ws?.name || `workspace ${workspaceId}`;
}

async function profileUrl() {
  const { resolvePublicBaseUrl } = await import('../utils/publicBaseUrl.js');
  return `${resolvePublicBaseUrl() || ''}/profile`;
}

/** The owner's own e-mail: created / rotated / expiring. Exported for tests. */
export function renderOwnerMail({ kind, key, workspace, url, ip = null }) {
  const name = key.name;
  const expires = dayPacific(key.expiresAt);
  const lines = {
    created: {
      subject: `You made an API key in ${workspace}: "${name}"`,
      intro: `You made the personal API key "${name}" in ${workspace}. It acts as you: anyone who has it can reply to requesters in your name.`,
    },
    rotated: {
      subject: `Your API key "${name}" has a new secret`,
      intro: `Your personal API key "${name}" in ${workspace} got a new secret. The old secret no longer works.`,
    },
    expiring: {
      subject: `Your API key "${name}" ends on ${expires}`,
      intro: `Your personal API key "${name}" in ${workspace} stops working on ${expires}. To keep your automation running, rotate it in your profile before then and put the new secret in place.`,
    },
  }[kind];
  const rows = [
    ['Key', `${name} (${key.keyPrefix}…)`],
    ['Ends', expires],
    ['IP lock', Array.isArray(key.ipAllowlist) && key.ipAllowlist.length ? key.ipAllowlist.join(', ') : 'none: it works from any address'],
    ...(ip ? [['From', ip]] : []),
  ];
  const tail = kind === 'expiring' ? '' : 'If this wasn’t you, revoke the key now and tell IT.';
  const text = [lines.intro, '', ...rows.map(([k, v]) => `${k}: ${v}`), '', tail, `Your API keys: ${url}`].filter((l) => l !== '').join('\n');
  const cell = 'font-family:Calibri,Segoe UI,Arial,sans-serif;font-size:14px;line-height:20px;color:#1f2937;padding:4px 12px 4px 0;vertical-align:top;';
  const html = `<div style="font-family:Calibri,Segoe UI,Arial,sans-serif;font-size:15px;line-height:22px;color:#1f2937;">
<p style="margin:0 0 12px;">${esc(lines.intro)}</p>
<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 14px;">
${rows.map(([k, v]) => `<tr><td style="${cell}color:#6b7280;">${esc(k)}</td><td style="${cell}">${esc(v)}</td></tr>`).join('\n')}
</table>
${tail ? `<p style="margin:0 0 12px;"><b>${esc(tail)}</b></p>` : ''}
<p style="margin:0;"><a href="${esc(url)}" style="color:#1d4ed8;">Your API keys</a></p>
</div>`;
  return { subject: lines.subject, text, html };
}

async function mailOwner(kind, key, extra = {}) {
  try {
    const [workspace, url] = await Promise.all([workspaceName(key.workspaceId), profileUrl()]);
    const { subject, text, html } = renderOwnerMail({ kind, key, workspace, url, ...extra });
    const { deliverTransactionalEmail } = await import('./transactionalEmailService.js');
    await deliverTransactionalEmail({ workspaceId: key.workspaceId, to: [key.ownerEmail], subject, html, text, label: 'personal api key' });
    return true;
  } catch (err) {
    logger.warn(`Personal API key: owner mail (${kind}) not sent for key ${key.id}: ${err.message}`);
    return false;
  }
}

async function noteExpired(key) {
  if (key.expiredNotedAt) return false;
  const { count } = await prisma.personalApiKey.updateMany({ where: { id: key.id, expiredNotedAt: null }, data: { expiredNotedAt: new Date() } });
  if (!count) return false;
  await audit({ workspaceId: key.workspaceId, actorEmail: null, action: PERSONAL_ACTIONS.EXPIRED, key });
  return true;
}

// ------------------------------------------------------------ revoking

async function revokeRows(rows, { reason, actorEmail = null, onlyEnabled = false }) {
  const revokedIds = [];
  for (const key of rows) {
    const { count } = await prisma.personalApiKey.updateMany({
      // onlyEnabled: an owner's revoke never lands on a key an admin switched
      // off between the owner's read and this write (second-look race).
      where: { id: key.id, revokedAt: null, ...(onlyEnabled ? { isEnabled: true } : {}) },
      data: { revokedAt: new Date(), revokedBy: actorEmail ? lower(actorEmail) : null, revokedReason: reason, isEnabled: false },
    });
    if (!count) continue;
    revokedIds.push(key.id);
    await audit({ workspaceId: key.workspaceId, actorEmail, action: PERSONAL_ACTIONS.REVOKED, key, extra: { reason } });
  }
  if (revokedIds.length) logger.info(`Personal API keys revoked (${reason}): ${revokedIds.join(', ')}`);
  return revokedIds;
}

/**
 * Take people off the workspace's list (offboarding, review 73f06f8b #8): one
 * Access history row each (personal_key_access_removed, details.reason). Reads
 * the list fresh. Returns the ids removed.
 */
async function removeFromList(workspaceId, technicianIds, { actorEmail = null, reason = 'offboarded' } = {}) {
  const ws = Number(workspaceId);
  const current = await getListedTechnicianIds(ws, { fresh: true });
  const drop = [...new Set(technicianIds.map(Number))].filter((id) => current.includes(id));
  if (!drop.length) return [];
  const ids = current.filter((id) => !drop.includes(id));
  await settingsRepository.set(personalKeyUsersKey(ws), JSON.stringify(ids));
  listCache.set(ws, { ids, at: Date.now() });
  const techs = await Promise.resolve()
    .then(() => prisma.technician.findMany({ where: { workspaceId: ws, id: { in: drop } }, select: { id: true, name: true, email: true } }))
    .catch(() => []);
  const byId = new Map((techs || []).map((t) => [t.id, t]));
  for (const id of drop) {
    const t = byId.get(id);
    await audit({ workspaceId: ws, actorEmail, action: PERSONAL_ACTIONS.ACCESS_REMOVED, targetEmail: t?.email || null, targetLabel: t?.name || `technician ${id}`, extra: { technicianId: id, reason } });
  }
  return drop;
}

/**
 * Offboarding one technician: revoke their keys AND take them off the list.
 * Never throws. Returns { revokedKeyIds, removedFromList }.
 */
export async function offboardTechnician(workspaceId, technicianId, { actorEmail = null, reason = 'offboarded' } = {}) {
  const revokedKeyIds = await revokeForTechnician(workspaceId, technicianId, { reason, actorEmail });
  const removedFromList = await removeFromList(workspaceId, [technicianId], { actorEmail, reason }).catch((err) => {
    logger.warn(`Personal API keys: list removal for technician ${technicianId} in ws ${workspaceId} failed: ${err.message}`);
    return [];
  });
  return { revokedKeyIds, removedFromList };
}

/** Offboarding by e-mail (workspace access removed). Never throws. */
export async function offboardEmail(workspaceId, email, { actorEmail = null, reason = 'offboarded' } = {}) {
  const revokedKeyIds = await revokeForEmail(workspaceId, email, { reason, actorEmail });
  let removedFromList = [];
  try {
    const tech = await prisma.technician.findFirst({ where: { workspaceId: Number(workspaceId), email: { equals: lower(email), mode: 'insensitive' } }, select: { id: true } });
    if (tech) removedFromList = await removeFromList(workspaceId, [tech.id], { actorEmail, reason });
  } catch (err) {
    logger.warn(`Personal API keys: list removal for ${email} in ws ${workspaceId} failed: ${err.message}`);
  }
  return { revokedKeyIds, removedFromList };
}

/**
 * After a sync switched technicians off in bulk (deactivateNotInList returns a
 * count only): offboard every listed person or key owner whose agent profile
 * is no longer active. Never throws.
 */
export async function offboardInactiveTechnicians(workspaceId, { reason = 'offboarded' } = {}) {
  try {
    const ws = Number(workspaceId);
    const [ids, keys] = await Promise.all([
      getListedTechnicianIds(ws, { fresh: true }),
      prisma.personalApiKey.findMany({ where: { workspaceId: ws, revokedAt: null }, select: { technicianId: true } }),
    ]);
    const candidates = [...new Set([...ids, ...(keys || []).map((k) => k.technicianId).filter(Boolean)])];
    if (!candidates.length) return [];
    const techs = await prisma.technician.findMany({ where: { workspaceId: ws, id: { in: candidates } }, select: { id: true, isActive: true } });
    const active = new Set((techs || []).filter((t) => t.isActive).map((t) => t.id));
    const gone = candidates.filter((id) => !active.has(id));
    for (const id of gone) await offboardTechnician(ws, id, { reason });
    return gone;
  } catch (err) {
    logger.warn(`Personal API keys: inactive sweep for ws ${workspaceId} failed: ${err.message}`);
    return [];
  }
}

/** Revoke every live key a technician holds in a workspace. Never throws. */
export async function revokeForTechnician(workspaceId, technicianId, { reason = 'offboarded', actorEmail = null } = {}) {
  try {
    const rows = await prisma.personalApiKey.findMany({ where: { workspaceId: Number(workspaceId), technicianId: Number(technicianId), revokedAt: null } });
    return await revokeRows(rows || [], { reason, actorEmail });
  } catch (err) {
    logger.warn(`Personal API keys: revoke for technician ${technicianId} in ws ${workspaceId} failed: ${err.message}`);
    return [];
  }
}

/** Revoke every live key an e-mail holds in a workspace (access removed). Never throws. */
export async function revokeForEmail(workspaceId, email, { reason = 'offboarded', actorEmail = null } = {}) {
  try {
    const address = lower(email);
    if (!address) return [];
    const rows = await prisma.personalApiKey.findMany({ where: { workspaceId: Number(workspaceId), ownerEmail: address, revokedAt: null } });
    return await revokeRows(rows || [], { reason, actorEmail });
  } catch (err) {
    logger.warn(`Personal API keys: revoke for ${email} in ws ${workspaceId} failed: ${err.message}`);
    return [];
  }
}

// ------------------------------------------------------------ owner side

function sessionEmail(user) {
  return lower(user?.email);
}

async function ownKeys(workspaceId, email) {
  return prisma.personalApiKey.findMany({
    where: { workspaceId: Number(workspaceId), ownerEmail: email, revokedAt: null },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * May this person create a key now? → { canCreate, reason }. `keys` are their
 * unrevoked keys. A key an admin switched off blocks a new one until an admin
 * revokes it (the owner can't revoke it either), so a switch-off can't be
 * dodged. An expired key does not block: create revokes it first.
 */
function createVerdict(access, keys) {
  if (!access.hasAccess) return { canCreate: false, reason: REASONS.NO_ACCESS };
  if (!access.onList || !access.eligible) return { canCreate: false, reason: REASONS.NOT_ON_LIST };
  if (access.readOnly) return { canCreate: false, reason: REASONS.READ_ONLY };
  if (keys.some((k) => !k.revokedAt && !k.isEnabled)) return { canCreate: false, reason: REASONS.DISABLED };
  const live = keys.filter((k) => keyStatus(k) === 'active');
  if (live.length >= MAX_PERSONAL_KEYS) return { canCreate: false, reason: REASONS.HAS_KEY };
  return { canCreate: true, reason: null };
}

/** A key id from the URL: anything but a positive whole number is "not found". */
function keyIdOf(id) {
  const n = Number(id);
  if (!/^\d+$/.test(String(id ?? '')) || !Number.isSafeInteger(n) || n <= 0) throw new NotFoundError('API key not found');
  return n;
}

/**
 * Check-and-write under a per-person lock (review 73f06f8b #4): two creates or
 * a create and a rotate at once can never leave two live keys. The partial
 * unique index personal_api_keys_one_live_per_person is the last line.
 */
async function withPersonLock(workspaceId, email, fn) {
  const lockKey = `pkey:${Number(workspaceId)}:${lower(email)}`;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}::text))`;
    return fn(tx);
  });
}

function conflict(message, code) {
  const err = new ConflictError(message);
  err.code = code;
  return err;
}

async function createRow(tx, data) {
  try {
    return await tx.personalApiKey.create({ data });
  } catch (err) {
    if (err?.code === 'P2002') throw conflict(REASONS.HAS_KEY, 'personal_key_exists');
    throw err;
  }
}

export async function getOwnerOverview(workspaceId, user) {
  const email = sessionEmail(user);
  const [access, keys] = await Promise.all([resolveOwnerAccess(workspaceId, email), ownKeys(workspaceId, email)]);
  const verdict = createVerdict(access, keys);
  return {
    enabled: Boolean(access.onList && access.eligible),
    canCreate: verdict.canCreate,
    reason: verdict.reason,
    maxKeys: MAX_PERSONAL_KEYS,
    rateLimitPerMinute: PERSONAL_KEY_RATE_LIMIT,
    expiryOptions: [...EXPIRY_OPTIONS],
    defaultExpiryDays: DEFAULT_EXPIRY_DAYS,
    abilities: ABILITIES.map((a) => ({ id: a.id, label: a.label, description: a.description, scopes: [...a.scopes], locked: a.locked })),
    keys: keys.map((k) => shapeKey(k)),
  };
}

function refusalFor(verdict) {
  if (verdict.reason === REASONS.HAS_KEY) return conflict(verdict.reason, 'personal_key_exists');
  if (verdict.reason === REASONS.DISABLED) return new AuthorizationError(verdict.reason, 'personal_key_disabled');
  if (verdict.reason === REASONS.READ_ONLY) return new AuthorizationError(verdict.reason, 'read_only_role');
  if (verdict.reason === REASONS.NO_ACCESS) return new AuthorizationError(verdict.reason, 'workspace_access_denied');
  return new AuthorizationError(verdict.reason, 'personal_key_not_allowed');
}

export async function createOwnKey(workspaceId, user, body = {}, { ip = null } = {}) {
  const email = sessionEmail(user);
  const name = validateName(body.name);
  const abilities = validateAbilities(body.abilities);
  const expiresInDays = validateExpiryDays(body.expiresInDays);
  const ipAllowlist = validateIpAllowlist(body.ipAllowlist);
  // The list is read fresh here, never from the 15 s cache (review #14).
  const access = await resolveOwnerAccess(workspaceId, email, { fresh: true });
  const accessVerdict = createVerdict(access, []);
  if (!accessVerdict.canCreate) throw refusalFor(accessVerdict);
  const { raw, hash, prefix } = generatePersonalKey();
  const { key, expired } = await withPersonLock(workspaceId, email, async (tx) => {
    const keys = await tx.personalApiKey.findMany({ where: { workspaceId: Number(workspaceId), ownerEmail: email, revokedAt: null } });
    const verdict = createVerdict(access, keys);
    if (!verdict.canCreate) throw refusalFor(verdict);
    // Ended keys still hold the one-key slot (and the unique index): revoke them first.
    const ended = keys.filter((k) => keyStatus(k) === 'expired');
    if (ended.length) {
      await tx.personalApiKey.updateMany({
        where: { id: { in: ended.map((k) => k.id) }, revokedAt: null },
        data: { revokedAt: new Date(), revokedBy: null, revokedReason: 'expired', isEnabled: false },
      });
    }
    const row = await createRow(tx, {
      workspaceId: Number(workspaceId),
      technicianId: access.technician.id,
      ownerEmail: email,
      name,
      keyHash: hash,
      keyPrefix: prefix,
      scopes: scopesForAbilities(abilities),
      ipAllowlist,
      expiresAt: new Date(Date.now() + expiresInDays * DAY_MS),
      createdBy: email,
    });
    return { key: row, expired: ended };
  });
  for (const old of expired) {
    await audit({ workspaceId, actorEmail: email, action: PERSONAL_ACTIONS.REVOKED, key: old, extra: { reason: 'expired' } });
  }
  await audit({ workspaceId, actorEmail: email, action: PERSONAL_ACTIONS.CREATED, key });
  await mailOwner('created', key, { ip });
  logger.info(`Personal API key ${key.id} (${prefix}…) created by ${email} in workspace ${workspaceId}`);
  return { key: shapeKey(key), secret: raw };
}

async function findOwn(workspaceId, email, id) {
  const key = await prisma.personalApiKey.findFirst({ where: { id: keyIdOf(id), workspaceId: Number(workspaceId), ownerEmail: email } });
  if (!key) throw new NotFoundError('API key not found');
  return key;
}

const REVOKED_MESSAGE = 'This key was revoked. Make a new one instead.';
const DISABLED_KEY_MESSAGE = 'An admin switched this key off. Only an admin can switch it back on or revoke it.';

/**
 * Rotate = replace: the old row is revoked ('rotated') and a new row carries
 * the same name, abilities and IP lock. The LENGTH carries over (the nearest
 * of 30/90/180/365 days to the old key's length); the end date restarts from
 * today. Refused while the person has any other unrevoked key.
 */
export async function rotateOwnKey(workspaceId, user, id, { ip = null } = {}) {
  const email = sessionEmail(user);
  const found = await findOwn(workspaceId, email, id);
  if (found.revokedAt) throw conflict(REVOKED_MESSAGE, 'personal_key_revoked');
  if (!found.isEnabled) throw new AuthorizationError(DISABLED_KEY_MESSAGE, 'personal_key_disabled');
  const access = await resolveOwnerAccess(workspaceId, email, { fresh: true });
  if (!access.hasAccess) throw new AuthorizationError(REASONS.NO_ACCESS, 'workspace_access_denied');
  if (!access.onList || !access.eligible) throw new AuthorizationError(REASONS.NOT_ON_LIST, 'personal_key_not_allowed');
  if (access.readOnly) throw new AuthorizationError(REASONS.READ_ONLY, 'read_only_role');
  const { raw, hash, prefix } = generatePersonalKey();
  const { key, old } = await withPersonLock(workspaceId, email, async (tx) => {
    const keys = await tx.personalApiKey.findMany({ where: { workspaceId: Number(workspaceId), ownerEmail: email, revokedAt: null } });
    const current = keys.find((k) => k.id === found.id);
    if (!current) throw conflict(REVOKED_MESSAGE, 'personal_key_revoked');
    if (!current.isEnabled) throw new AuthorizationError(DISABLED_KEY_MESSAGE, 'personal_key_disabled');
    if (keys.some((k) => k.id !== current.id)) {
      throw conflict('You have another key. Revoke it before you rotate this one.', 'personal_key_exists');
    }
    const lengthDays = Math.max(1, Math.round((new Date(current.expiresAt).getTime() - new Date(current.createdAt).getTime()) / DAY_MS));
    const days = EXPIRY_OPTIONS.reduce((best, d) => (Math.abs(d - lengthDays) < Math.abs(best - lengthDays) ? d : best), DEFAULT_EXPIRY_DAYS);
    await tx.personalApiKey.updateMany({
      where: { id: current.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedBy: email, revokedReason: 'rotated', isEnabled: false },
    });
    const row = await createRow(tx, {
      workspaceId: current.workspaceId,
      technicianId: access.technician.id,
      ownerEmail: email,
      name: current.name,
      keyHash: hash,
      keyPrefix: prefix,
      scopes: roleCappedScopes(current.scopes),
      ipAllowlist: Array.isArray(current.ipAllowlist) ? current.ipAllowlist : [],
      expiresAt: new Date(Date.now() + days * DAY_MS),
      rotatedFromId: current.id,
      createdBy: email,
    });
    return { key: row, old: current };
  });
  await audit({ workspaceId, actorEmail: email, action: PERSONAL_ACTIONS.ROTATED, key, extra: { rotatedFromId: old.id } });
  await mailOwner('rotated', key, { ip });
  return { key: shapeKey(key), secret: raw };
}

export async function revokeOwnKey(workspaceId, user, id) {
  const email = sessionEmail(user);
  const key = await findOwn(workspaceId, email, id);
  if (key.revokedAt) return { revoked: true };
  // An admin's switch-off can't be dodged by revoking and making a new key
  // (review #3): only an admin revokes a switched-off key, which frees the slot.
  if (!key.isEnabled) throw new AuthorizationError(DISABLED_KEY_MESSAGE, 'personal_key_disabled');
  const revoked = await revokeRows([key], { reason: 'owner', actorEmail: email, onlyEnabled: true });
  if (!revoked.length) {
    const now = await prisma.personalApiKey.findFirst({ where: { id: key.id }, select: { isEnabled: true, revokedAt: true } }).catch(() => null);
    if (now && !now.revokedAt && !now.isEnabled) throw new AuthorizationError(DISABLED_KEY_MESSAGE, 'personal_key_disabled');
  }
  return { revoked: true };
}

// ------------------------------------------------------------ admin side

async function ownersFor(workspaceId, keys) {
  const ids = [...new Set(keys.map((k) => k.technicianId).filter(Boolean))];
  const techs = ids.length
    ? await Promise.resolve()
      .then(() => prisma.technician.findMany({ where: { workspaceId: Number(workspaceId), id: { in: ids } }, select: { id: true, name: true, email: true } }))
      .catch(() => [])
    : [];
  const byId = new Map((techs || []).map((t) => [t.id, t]));
  return (key) => {
    const t = byId.get(key.technicianId);
    return { name: t?.name || key.ownerEmail, email: key.ownerEmail, technicianId: key.technicianId ?? null };
  };
}

export async function adminList(workspaceId) {
  const since = new Date(Date.now() - 90 * DAY_MS);
  const [keys, ids] = await Promise.all([
    prisma.personalApiKey.findMany({
      where: { workspaceId: Number(workspaceId), OR: [{ revokedAt: null }, { revokedAt: { gte: since } }] },
      orderBy: { createdAt: 'desc' },
      take: 500,
    }),
    getListedTechnicianIds(workspaceId, { fresh: true }),
  ]);
  const owner = await ownersFor(workspaceId, keys);
  return { enabled: ids.length > 0, keys: keys.map((k) => shapeKey(k, { owner: owner(k) })) };
}

async function findInWorkspace(workspaceId, id) {
  const key = await prisma.personalApiKey.findFirst({ where: { id: keyIdOf(id), workspaceId: Number(workspaceId) } });
  if (!key) throw new NotFoundError('API key not found');
  return key;
}

export async function adminSetDisabled(workspaceId, id, disabled, actor) {
  if (typeof disabled !== 'boolean') throw new ValidationError('disabled must be true or false');
  const key = await findInWorkspace(workspaceId, id);
  if (key.revokedAt) {
    const err = new ConflictError('This key was revoked and can’t be switched back on.');
    err.code = 'personal_key_revoked';
    throw err;
  }
  const actorEmail = lower(actor?.email) || null;
  let updated = key;
  if (disabled === key.isEnabled) {
    updated = await prisma.personalApiKey.update({
      where: { id: key.id },
      data: disabled ? { isEnabled: false, disabledAt: new Date(), disabledBy: actorEmail } : { isEnabled: true, disabledAt: null, disabledBy: null },
    });
    await audit({ workspaceId, actorEmail, action: disabled ? PERSONAL_ACTIONS.DISABLED_BY_ADMIN : PERSONAL_ACTIONS.ENABLED_BY_ADMIN, key: updated });
  }
  const owner = await ownersFor(workspaceId, [updated]);
  return shapeKey(updated, { owner: owner(updated) });
}

export async function adminRevoke(workspaceId, id, actor) {
  const key = await findInWorkspace(workspaceId, id);
  if (!key.revokedAt) await revokeRows([key], { reason: 'admin', actorEmail: actor?.email || null });
  return { revoked: true };
}

/** The people an admin can tick, with why someone can't be. */
export async function adminUsers(workspaceId) {
  const ws = Number(workspaceId);
  const [ids, techs, accessRows, keys] = await Promise.all([
    getListedTechnicianIds(ws, { fresh: true }),
    prisma.technician.findMany({ where: { workspaceId: ws }, select: { id: true, name: true, email: true, isActive: true }, orderBy: { name: 'asc' } }),
    prisma.workspaceAccess.findMany({ where: { workspaceId: ws }, select: { email: true, role: true } }),
    prisma.personalApiKey.findMany({ where: { workspaceId: ws, revokedAt: null }, select: { technicianId: true, ownerEmail: true, isEnabled: true, expiresAt: true, revokedAt: true } }),
  ]);
  const roleByEmail = new Map((accessRows || []).map((r) => [lower(r.email), r.role]));
  const liveKeyEmails = new Set((keys || []).filter((k) => ['active', 'disabled'].includes(keyStatus(k))).map((k) => lower(k.ownerEmail)));
  const people = [];
  const seen = new Set();
  for (const t of techs || []) {
    const email = lower(t.email);
    if (!t.isActive && !ids.includes(t.id)) continue; // switched-off people only when still listed
    if (email) seen.add(email);
    const eligible = Boolean(t.isActive && email);
    people.push({
      technicianId: t.id,
      name: t.name,
      email: email || null,
      accessRole: roleByEmail.get(email) || null,
      isActive: t.isActive !== false,
      onList: ids.includes(t.id),
      eligible,
      reason: eligible ? null : (!t.isActive ? 'Their agent profile is switched off.' : 'Their agent profile has no e-mail address.'),
      hasKey: liveKeyEmails.has(email),
    });
  }
  for (const r of accessRows || []) {
    const email = lower(r.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    people.push({
      technicianId: null,
      name: null,
      email,
      accessRole: r.role,
      isActive: true,
      onList: false,
      eligible: false,
      reason: 'No agent profile in this workspace, so they can’t have a key.',
      hasKey: liveKeyEmails.has(email),
    });
  }
  return { technicianIds: ids, people };
}

function idList(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${label} must be a list`);
  const ids = [...new Set(value.map(Number))];
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new ValidationError(`${label} must be positive whole numbers`);
  return ids;
}

/**
 * Change the list. Body: `{ add: [...], remove: [...] }` (a delta, applied to
 * the list as it is NOW, so two admins editing at once don't undo each other;
 * a `technicianIds` sent beside it is ignored) or `{ technicianIds: [...] }`
 * alone (the whole list). A bare array is read as the whole list. One Access history row per person added or removed; a removed
 * person's key is revoked in the same request (reason access_removed).
 */
export async function adminSetUsers(workspaceId, body, actor) {
  const ws = Number(workspaceId);
  const input = Array.isArray(body) ? { technicianIds: body } : (body || {});
  // `add` or `remove` present (even one empty list) = a delta, and any
  // technicianIds beside it is ignored: the picker may send a stale whole list.
  const isDelta = input.add !== undefined || input.remove !== undefined;
  if (!isDelta && !Array.isArray(input.technicianIds)) throw new ValidationError('Send technicianIds (the whole list) or add / remove (changes)');
  const current = await getListedTechnicianIds(ws, { fresh: true });
  let wanted;
  if (isDelta) {
    const add = idList(input.add, 'add');
    const remove = idList(input.remove, 'remove');
    wanted = [...new Set([...current, ...add])].filter((id) => !remove.includes(id));
  } else {
    wanted = idList(input.technicianIds, 'technicianIds');
  }
  const added = wanted.filter((id) => !current.includes(id));
  const removed = current.filter((id) => !wanted.includes(id));
  const touched = [...new Set([...added, ...removed])];
  const techs = touched.length
    ? await prisma.technician.findMany({ where: { workspaceId: ws, id: { in: touched } }, select: { id: true, name: true, email: true, isActive: true } })
    : [];
  const byId = new Map((techs || []).map((t) => [t.id, t]));
  const notEligible = added
    .map((id) => {
      const t = byId.get(id);
      if (!t) return { technicianId: id, reason: 'No agent profile with this id in this workspace.' };
      if (!t.isActive) return { technicianId: id, reason: 'Their agent profile is switched off.' };
      if (!lower(t.email)) return { technicianId: id, reason: 'Their agent profile has no e-mail address.' };
      return null;
    })
    .filter(Boolean);
  if (notEligible.length) {
    throw new UnprocessableError('Only active agents of this workspace can have an API key.', 'personal_key_user_not_eligible', notEligible);
  }
  const ids = [...wanted].sort((a, b) => a - b);
  await settingsRepository.set(personalKeyUsersKey(ws), JSON.stringify(ids));
  listCache.set(ws, { ids, at: Date.now() });
  const actorEmail = lower(actor?.email) || null;
  for (const id of added) {
    const t = byId.get(id);
    await audit({ workspaceId: ws, actorEmail, action: PERSONAL_ACTIONS.ACCESS_GRANTED, targetEmail: t?.email || null, targetLabel: t?.name || `technician ${id}`, extra: { technicianId: id } });
  }
  const revokedKeyIds = [];
  for (const id of removed) {
    const t = byId.get(id);
    await audit({ workspaceId: ws, actorEmail, action: PERSONAL_ACTIONS.ACCESS_REMOVED, targetEmail: t?.email || null, targetLabel: t?.name || `technician ${id}`, extra: { technicianId: id } });
    revokedKeyIds.push(...await revokeForTechnician(ws, id, { reason: 'access_removed', actorEmail }));
  }
  return { technicianIds: ids, revokedKeyIds };
}

// ------------------------------------------------------------ the guide

/**
 * The Markdown guide for this person, personalised; never the secret.
 * `key` = the key it describes (the v1 caller's key, or the owner's live key);
 * without one it describes the most a key could do for them today.
 */
export async function buildGuide({ workspaceId, access, key = null, baseUrl }) {
  const { buildPersonalKeyGuide, GUIDE_FILENAME } = await import('./personalApiKeyGuide.js');
  const workspace = { id: Number(workspaceId), name: await workspaceName(workspaceId) };
  const keyScopes = key ? roleCappedScopes(key.scopes) : [...PERSONAL_KEY_MAX_SCOPES];
  const markdown = buildPersonalKeyGuide({
    baseUrl,
    workspace,
    person: { name: access.technician?.name || access.email, email: access.email },
    abilities: abilitiesFromScopes(keyScopes),
    scopes: roleCappedScopes(keyScopes, access),
    readOnly: access.readOnly,
    rateLimit: PERSONAL_KEY_RATE_LIMIT,
    key: key ? { name: key.name, prefix: key.keyPrefix, expiresAt: key.expiresAt } : null,
  });
  return { markdown, filename: GUIDE_FILENAME };
}

/** Owner route: the guide for the signed-in person (on the list), describing their live key if any. */
export async function ownerGuide(workspaceId, user, { baseUrl }) {
  const email = sessionEmail(user);
  const [access, keys] = await Promise.all([resolveOwnerAccess(workspaceId, email), ownKeys(workspaceId, email)]);
  if (!access.hasAccess) throw new AuthorizationError(REASONS.NO_ACCESS, 'workspace_access_denied');
  if (!access.onList || !access.eligible) throw new AuthorizationError(REASONS.NOT_ON_LIST, 'personal_key_not_allowed');
  const live = keys.find((k) => keyStatus(k) === 'active') || null;
  return buildGuide({ workspaceId, access, key: live, baseUrl });
}

// ------------------------------------------------------------ expiry sweep

/**
 * Daily (scheduledSyncService, 09:00 Pacific): mail each owner once, 7 days
 * before their key ends, and record `personal_key_expired` once a key has ended.
 */
export async function runExpirySweep({ now = new Date() } = {}) {
  const soon = new Date(now.getTime() + EXPIRY_WARNING_DAYS * DAY_MS);
  const [warn, ended] = await Promise.all([
    prisma.personalApiKey.findMany({ where: { revokedAt: null, isEnabled: true, expiryWarnedAt: null, expiresAt: { gt: now, lte: soon } }, take: 500 }),
    prisma.personalApiKey.findMany({ where: { revokedAt: null, expiredNotedAt: null, expiresAt: { lte: now } }, take: 500 }),
  ]);
  let warned = 0;
  for (const key of warn || []) {
    const { count } = await prisma.personalApiKey.updateMany({ where: { id: key.id, expiryWarnedAt: null }, data: { expiryWarnedAt: now } });
    if (!count) continue;
    if (await mailOwner('expiring', key)) warned += 1;
  }
  let expired = 0;
  for (const key of ended || []) {
    if (await noteExpired(key).catch(() => false)) expired += 1;
  }
  return { warned, expired };
}

export default {
  ABILITIES,
  PERSONAL_KEY_MAX_SCOPES,
  PERSONAL_KEY_RATE_LIMIT,
  isPersonalKeyRaw,
  authenticatePersonalKey,
  refusedByRole,
  recordUse,
  getOwnerOverview,
  createOwnKey,
  rotateOwnKey,
  revokeOwnKey,
  ownerGuide,
  buildGuide,
  adminList,
  adminSetDisabled,
  adminRevoke,
  adminUsers,
  adminSetUsers,
  revokeForTechnician,
  revokeForEmail,
  offboardTechnician,
  offboardEmail,
  offboardInactiveTechnicians,
  runExpirySweep,
  resolveOwnerAccess,
  resetPersonalKeyCaches,
};
