import { jest } from '@jest/globals';

/**
 * Personal API keys (4.4.05): the owner and admin lifecycle — one key per
 * person, the per-person access list (Dashboard-viewer pattern), Access
 * history for every change, the admin alert + owner e-mail, offboarding and
 * list-removal revokes, the 7-day expiry warning, and the guide.
 */
const rows = new Map();
let nextId = 100;
const prismaMock = {
  personalApiKey: {
    findMany: jest.fn(async ({ where } = {}) => [...rows.values()].filter((k) => match(k, where))),
    findFirst: jest.fn(async ({ where }) => [...rows.values()].find((k) => match(k, where)) || null),
    findUnique: jest.fn(),
    create: jest.fn(async ({ data }) => {
      const row = { id: nextId++, isEnabled: true, revokedAt: null, revokedReason: null, disabledAt: null, lastUsedAt: null, lastUsedIp: null, requestCount: 0, expiryWarnedAt: null, expiredNotedAt: null, createdAt: new Date(), updatedAt: new Date(), ...data };
      rows.set(row.id, row);
      return row;
    }),
    update: jest.fn(async ({ where, data }) => Object.assign(rows.get(where.id), data)),
    updateMany: jest.fn(async ({ where, data }) => {
      const hit = [...rows.values()].filter((k) => match(k, where));
      hit.forEach((k) => Object.assign(k, data));
      return { count: hit.length };
    }),
  },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  workspaceAccess: { findMany: jest.fn().mockResolvedValue([]) },
  workspace: { findUnique: jest.fn().mockResolvedValue({ name: 'IT' }) },
  $executeRaw: jest.fn().mockResolvedValue(1),
};
// The transaction runs on the same mock; the advisory lock is recorded.
prismaMock.$transaction = jest.fn(async (fn) => fn(prismaMock));

// A tiny where-matcher for the shapes the service uses.
function match(row, where = {}) {
  return Object.entries(where || {}).every(([k, v]) => {
    if (k === 'OR') return v.some((w) => match(row, w));
    if (v === null) return row[k] === null || row[k] === undefined;
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('gte' in v || 'lte' in v || 'gt' in v) {
        const t = row[k] ? new Date(row[k]).getTime() : null;
        if (t === null) return false;
        if (v.gte && t < new Date(v.gte).getTime()) return false;
        if (v.gt && t <= new Date(v.gt).getTime()) return false;
        if (v.lte && t > new Date(v.lte).getTime()) return false;
        return true;
      }
      if ('in' in v) return v.in.includes(row[k]);
      return true;
    }
    return row[k] === v;
  });
}

const settings = new Map();
const settingsMock = { get: jest.fn(async (k) => settings.get(k) ?? null), set: jest.fn(async (k, v) => { settings.set(k, v); }) };
const workspaceRepoMock = { getAccessRole: jest.fn() };
const auditMock = { recordAccessEvent: jest.fn().mockResolvedValue({}), recordCredentialEvent: jest.fn().mockResolvedValue({}) };
const mailMock = { deliverTransactionalEmail: jest.fn().mockResolvedValue({ sent: true }) };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({ default: workspaceRepoMock }));
jest.unstable_mockModule('../src/services/accessAuditService.js', () => auditMock);
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => mailMock);
jest.unstable_mockModule('../src/services/reportRecipients.js', () => ({ superAdminEmails: jest.fn(async () => ['priya.nair@example.com']) }));
jest.unstable_mockModule('../src/utils/publicBaseUrl.js', () => ({ resolvePublicBaseUrl: () => 'https://tickets.example.com' }));

const svc = await import('../src/services/personalApiKeyService.js');

const DANA = { id: 12, name: 'Dana Fox', email: 'dana.fox@example.com', isActive: true };
const ELI = { id: 14, name: 'Eli Park', email: 'eli.park@example.com', isActive: true };
const SAM_OFF = { id: 15, name: 'Sam Okafor', email: 'sam.okafor@example.com', isActive: false };
const TECHS = [DANA, ELI, SAM_OFF];
const dana = { email: 'Dana.Fox@example.com', role: 'viewer' };

beforeEach(() => {
  jest.clearAllMocks();
  rows.clear();
  settings.clear();
  svc.resetPersonalKeyCaches();
  settings.set('personal_api_key_users_ws1', '[12]');
  workspaceRepoMock.getAccessRole.mockResolvedValue(null);
  prismaMock.technician.findFirst.mockImplementation(async ({ where }) => TECHS.find((t) => (where.id ? t.id === where.id : t.email === where.email.equals)) || null);
  prismaMock.technician.findMany.mockImplementation(async ({ where }) => TECHS.filter((t) => !where.id || where.id.in.includes(t.id)));
  prismaMock.workspaceAccess.findMany.mockResolvedValue([]);
});

const body = (over = {}) => ({ name: 'Laptop script', abilities: ['reply'], expiresInDays: 90, ipAllowlist: [], ...over });

describe('the owner overview', () => {
  test('nobody is on an empty list: enabled false with a plain reason', async () => {
    settings.set('personal_api_key_users_ws1', '[]');
    const data = await svc.getOwnerOverview(1, dana);
    expect(data).toEqual(expect.objectContaining({ enabled: false, canCreate: false, reason: 'Ask an admin to give you API access.', maxKeys: 1, rateLimitPerMinute: 60, keys: [] }));
    expect(data.abilities.map((a) => a.id)).toEqual(['read', 'reply', 'update', 'tasks']);
    expect(data.abilities[0].locked).toBe(true);
  });

  test('a listed agent can create; with a key, the reason says rotate or revoke', async () => {
    expect(await svc.getOwnerOverview(1, dana)).toEqual(expect.objectContaining({ enabled: true, canCreate: true, reason: null }));
    await svc.createOwnKey(1, dana, body());
    const after = await svc.getOwnerOverview(1, dana);
    expect(after.canCreate).toBe(false);
    expect(after.reason).toMatch(/already have a key/);
    expect(after.keys).toHaveLength(1);
  });
});

describe('creating a key', () => {
  test('returns the secret once, stores only its hash, caps the scopes to the abilities, records + mails', async () => {
    const { key, secret } = await svc.createOwnKey(1, dana, body({ ipAllowlist: ['203.0.113.0/24', '198.51.100.7'] }), { ip: '198.51.100.7' });
    expect(secret).toMatch(/^tpu_[A-Za-z0-9_-]{32}$/);
    const stored = prismaMock.personalApiKey.create.mock.calls[0][0].data;
    expect(stored.keyHash).toHaveLength(64);
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(stored).toEqual(expect.objectContaining({ workspaceId: 1, technicianId: 12, ownerEmail: 'dana.fox@example.com', name: 'Laptop script', ipAllowlist: ['203.0.113.0/24', '198.51.100.7'] }));
    expect(stored.scopes).toEqual(expect.arrayContaining(['tickets:read', 'conversations:read', 'conversations:write']));
    expect(stored.scopes).not.toContain('tickets:write');
    expect(Math.round((stored.expiresAt - Date.now()) / 86400000)).toBe(90);
    expect(key).toEqual(expect.objectContaining({ abilities: ['read', 'reply'], status: 'active', prefix: secret.slice(0, 12) }));
    expect(key).not.toHaveProperty('keyHash');
    expect(auditMock.recordCredentialEvent).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 1, actorEmail: 'dana.fox@example.com', action: 'personal_key_created', targetEmail: 'dana.fox@example.com',
      extra: expect.objectContaining({ kind: 'personal_key', ownerEmail: 'dana.fox@example.com' }),
    }));
    expect(mailMock.deliverTransactionalEmail).toHaveBeenCalledWith(expect.objectContaining({ to: ['dana.fox@example.com'], subject: 'You made an API key in IT: "Laptop script"' }));
    const mail = mailMock.deliverTransactionalEmail.mock.calls[0][0];
    expect(mail.text).toMatch(/If this wasn’t you, revoke the key now/);
    expect(mail.text).not.toContain(secret);
    expect(mail.text).toContain('Your API keys: https://tickets.example.com/profile');
  });

  test('one key per person: a second create is refused while one is active; the check runs under the person lock', async () => {
    await svc.createOwnKey(1, dana, body());
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    const lockSql = prismaMock.$executeRaw.mock.calls[0];
    expect(lockSql[0].join('?')).toMatch(/pg_advisory_xact_lock\(hashtext\(\?::text\)\)/);
    expect(lockSql[1]).toBe('pkey:1:dana.fox@example.com');
    await expect(svc.createOwnKey(1, dana, body({ name: 'Second' }))).rejects.toMatchObject({ statusCode: 409, code: 'personal_key_exists' });
    // once it is revoked a new one may be made
    [...rows.values()][0].revokedAt = new Date();
    await expect(svc.createOwnKey(1, dana, body({ name: 'Fresh' }))).resolves.toHaveProperty('secret');
  });

  test('the unique index is the last line: a racing insert (P2002) answers 409 personal_key_exists', async () => {
    prismaMock.personalApiKey.create.mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
    await expect(svc.createOwnKey(1, dana, body())).rejects.toMatchObject({ statusCode: 409, code: 'personal_key_exists' });
  });

  test('an ended key is revoked (reason expired) when a new one is made, and recorded', async () => {
    const { key } = await svc.createOwnKey(1, dana, body());
    rows.get(key.id).expiresAt = new Date(Date.now() - 1000);
    const fresh = await svc.createOwnKey(1, dana, body({ name: 'Next' }));
    expect(rows.get(key.id)).toEqual(expect.objectContaining({ revokedReason: 'expired', isEnabled: false }));
    expect(rows.get(key.id).revokedAt).toBeInstanceOf(Date);
    expect(fresh.key.status).toBe('active');
    expect(auditMock.recordCredentialEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'personal_key_revoked', extra: expect.objectContaining({ reason: 'expired' }) }));
  });

  test('race: an admin switches the key off between the owner\'s read and the revoke, and the owner\'s revoke does not land', async () => {
    const { key } = await svc.createOwnKey(1, dana, body());
    const stale = { ...rows.get(key.id) }; // the owner's read, still on
    rows.get(key.id).isEnabled = false; // the admin's switch-off lands first
    prismaMock.personalApiKey.findFirst.mockImplementationOnce(async () => stale);
    await expect(svc.revokeOwnKey(1, dana, key.id)).rejects.toMatchObject({ statusCode: 403, code: 'personal_key_disabled' });
    expect(rows.get(key.id).revokedAt).toBeNull();
  });

  test('an admin switch-off cannot be dodged: no new key, and the owner cannot revoke it; an admin revoke frees the slot', async () => {
    const { key } = await svc.createOwnKey(1, dana, body());
    await svc.adminSetDisabled(1, key.id, true, { email: 'priya.nair@example.com' });
    await expect(svc.createOwnKey(1, dana, body({ name: 'Around it' }))).rejects.toMatchObject({ statusCode: 403, code: 'personal_key_disabled' });
    await expect(svc.revokeOwnKey(1, dana, key.id)).rejects.toMatchObject({ statusCode: 403, code: 'personal_key_disabled' });
    expect(rows.get(key.id).revokedAt).toBeNull();
    // even after it would have ended, a switched-off key still blocks (expiry never frees it)
    rows.get(key.id).expiresAt = new Date(Date.now() - 1000);
    await expect(svc.createOwnKey(1, dana, body({ name: 'Around it' }))).rejects.toMatchObject({ statusCode: 403, code: 'personal_key_disabled' });
    expect((await svc.getOwnerOverview(1, dana)).reason).toMatch(/An admin switched your key off/);
    await svc.adminRevoke(1, key.id, { email: 'priya.nair@example.com' });
    await expect(svc.createOwnKey(1, dana, body({ name: 'Allowed now' }))).resolves.toHaveProperty('secret');
  });

  test('create reads the access list fresh, never from the 15 s cache', async () => {
    expect(await svc.getListedTechnicianIds(1)).toEqual([12]); // cached
    settings.set('personal_api_key_users_ws1', '[]'); // another server took Dana off
    await expect(svc.createOwnKey(1, dana, body())).rejects.toMatchObject({ statusCode: 403, code: 'personal_key_not_allowed' });
  });

  test('non-numeric key ids are 404, not 500', async () => {
    for (const bad of ['abc', '1.5', '-3', '', '9'.repeat(30)]) {
      await expect(svc.revokeOwnKey(1, dana, bad)).rejects.toMatchObject({ statusCode: 404 });
      await expect(svc.rotateOwnKey(1, dana, bad)).rejects.toMatchObject({ statusCode: 404 });
      await expect(svc.adminRevoke(1, bad, {})).rejects.toMatchObject({ statusCode: 404 });
      await expect(svc.adminSetDisabled(1, bad, true, {})).rejects.toMatchObject({ statusCode: 404 });
    }
    expect(prismaMock.personalApiKey.findFirst).not.toHaveBeenCalled();
  });

  test('not on the list, read-only, or no access: refused with the matching code', async () => {
    settings.set('personal_api_key_users_ws1', '[14]');
    svc.resetPersonalKeyCaches();
    await expect(svc.createOwnKey(1, dana, body())).rejects.toMatchObject({ statusCode: 403, code: 'personal_key_not_allowed' });
    settings.set('personal_api_key_users_ws1', '[12]');
    svc.resetPersonalKeyCaches();
    workspaceRepoMock.getAccessRole.mockResolvedValue('readonly');
    await expect(svc.createOwnKey(1, dana, body())).rejects.toMatchObject({ statusCode: 403, code: 'read_only_role' });
    expect(prismaMock.personalApiKey.create).not.toHaveBeenCalled();
  });

  test('scopes outside the table, bad expiry, bad IPs and bad names are refused at creation', async () => {
    await expect(svc.createOwnKey(1, dana, body({ abilities: ['approvals'] }))).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.createOwnKey(1, dana, body({ abilities: ['tickets:write'] }))).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.createOwnKey(1, dana, body({ expiresInDays: 0 }))).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.createOwnKey(1, dana, body({ expiresInDays: 3650 }))).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.createOwnKey(1, dana, body({ ipAllowlist: ['not-an-ip'] }))).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.createOwnKey(1, dana, body({ ipAllowlist: ['10.0.0.0/40'] }))).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.createOwnKey(1, dana, body({ name: ' ' }))).rejects.toMatchObject({ statusCode: 400 });
    expect(prismaMock.personalApiKey.create).not.toHaveBeenCalled();
  });

  test('the ability → scope table never grants approvals, custom-field writes, tag creation or webhooks', () => {
    const all = svc.scopesForAbilities(['read', 'reply', 'update', 'tasks']);
    for (const never of ['approvals:read', 'approvals:write', 'customfields:write', 'tags:create', 'webhooks:read', 'webhooks:manage', '*']) {
      expect(all).not.toContain(never);
    }
    expect(svc.roleCappedScopes([...all, 'approvals:write'], { readOnly: true }).every((s) => s.endsWith(':read'))).toBe(true);
  });
});

describe('rotate and revoke', () => {
  test('rotate replaces the key: old revoked (rotated), new row keeps name, abilities and IP lock', async () => {
    const first = await svc.createOwnKey(1, dana, body({ abilities: ['reply', 'tasks'], ipAllowlist: ['203.0.113.7'], expiresInDays: 30 }));
    const rotated = await svc.rotateOwnKey(1, dana, first.key.id);
    expect(rotated.secret).not.toBe(first.secret);
    expect(rotated.key.id).not.toBe(first.key.id);
    expect(rows.get(first.key.id)).toEqual(expect.objectContaining({ revokedReason: 'rotated', isEnabled: false }));
    expect(rows.get(rotated.key.id)).toEqual(expect.objectContaining({ name: 'Laptop script', ipAllowlist: ['203.0.113.7'], rotatedFromId: first.key.id }));
    expect(rotated.key.abilities).toEqual(['read', 'reply', 'tasks']);
    expect(Math.round((new Date(rotated.key.expiresAt) - Date.now()) / 86400000)).toBe(30);
    expect(auditMock.recordCredentialEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'personal_key_rotated' }));
    expect(mailMock.deliverTransactionalEmail).toHaveBeenLastCalledWith(expect.objectContaining({ subject: 'Your API key "Laptop script" has a new secret' }));
  });

  test('rotate refuses while another live key exists (one key per person), inside the person lock', async () => {
    const { key } = await svc.createOwnKey(1, dana, body());
    // a second unrevoked row (only possible before the unique index existed)
    rows.set(999, { ...rows.get(key.id), id: 999, keyHash: 'x'.repeat(64) });
    prismaMock.$transaction.mockClear();
    await expect(svc.rotateOwnKey(1, dana, key.id)).rejects.toMatchObject({ statusCode: 409, code: 'personal_key_exists' });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(rows.get(key.id).revokedAt).toBeNull(); // nothing changed
  });

  test('rotate keeps the length (nearest of 30/90/180/365) and restarts the end date from today', async () => {
    const { key } = await svc.createOwnKey(1, dana, body({ expiresInDays: 180 }));
    // made 100 days ago with 180 days: 80 days left — the new key gets 180 from today
    rows.get(key.id).createdAt = new Date(Date.now() - 100 * 86400000);
    rows.get(key.id).expiresAt = new Date(Date.now() + 80 * 86400000);
    const rotated = await svc.rotateOwnKey(1, dana, key.id);
    expect(Math.round((new Date(rotated.key.expiresAt) - Date.now()) / 86400000)).toBe(180);
  });

  test('a key an admin switched off cannot be rotated by its owner; a revoked one cannot either', async () => {
    const { key } = await svc.createOwnKey(1, dana, body());
    rows.get(key.id).isEnabled = false;
    await expect(svc.rotateOwnKey(1, dana, key.id)).rejects.toMatchObject({ statusCode: 403, code: 'personal_key_disabled' });
    rows.get(key.id).revokedAt = new Date();
    await expect(svc.rotateOwnKey(1, dana, key.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  test('revoking your own key records personal_key_revoked (owner); someone else\'s key is not found', async () => {
    const { key } = await svc.createOwnKey(1, dana, body());
    await svc.revokeOwnKey(1, dana, key.id);
    expect(rows.get(key.id)).toEqual(expect.objectContaining({ revokedReason: 'owner', revokedBy: 'dana.fox@example.com' }));
    expect(auditMock.recordCredentialEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'personal_key_revoked', extra: expect.objectContaining({ reason: 'owner' }) }));
    await expect(svc.revokeOwnKey(1, { email: 'eli.park@example.com' }, key.id)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('admin: everyone\'s keys', () => {
  test('lists keys with their owner; switch off / on records Access history; revoke records admin', async () => {
    const { key } = await svc.createOwnKey(1, dana, body());
    const list = await svc.adminList(1);
    expect(list.enabled).toBe(true);
    expect(list.keys[0]).toEqual(expect.objectContaining({ id: key.id, owner: { name: 'Dana Fox', email: 'dana.fox@example.com', technicianId: 12 } }));
    const off = await svc.adminSetDisabled(1, key.id, true, { email: 'priya.nair@example.com' });
    expect(off.status).toBe('disabled');
    expect(auditMock.recordCredentialEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'personal_key_disabled_by_admin', actorEmail: 'priya.nair@example.com' }));
    const on = await svc.adminSetDisabled(1, key.id, false, { email: 'priya.nair@example.com' });
    expect(on.status).toBe('active');
    expect(auditMock.recordCredentialEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'personal_key_enabled_by_admin' }));
    await svc.adminRevoke(1, key.id, { email: 'priya.nair@example.com' });
    expect(rows.get(key.id).revokedReason).toBe('admin');
    await expect(svc.adminSetDisabled(1, key.id, false, {})).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('admin: who may have a key', () => {
  test('GET users tells eligible people from those without an agent profile', async () => {
    prismaMock.technician.findMany.mockResolvedValue(TECHS);
    prismaMock.workspaceAccess.findMany.mockResolvedValue([{ email: 'eli.park@example.com', role: 'readonly' }, { email: 'priya.nair@example.com', role: 'admin' }]);
    const { technicianIds, people } = await svc.adminUsers(1);
    expect(technicianIds).toEqual([12]);
    expect(people.find((p) => p.technicianId === 12)).toEqual(expect.objectContaining({ onList: true, eligible: true, reason: null }));
    expect(people.find((p) => p.technicianId === 14)).toEqual(expect.objectContaining({ accessRole: 'readonly', eligible: true }));
    expect(people.find((p) => p.email === 'priya.nair@example.com')).toEqual(expect.objectContaining({ technicianId: null, eligible: false, reason: expect.stringMatching(/No agent profile/) }));
    // switched-off people who are not listed are left out
    expect(people.find((p) => p.technicianId === 15)).toBeUndefined();
  });

  test('PUT users: one Access history row per person changed; removal revokes their key in the same request', async () => {
    const { key } = await svc.createOwnKey(1, dana, body());
    auditMock.recordCredentialEvent.mockClear();
    const out = await svc.adminSetUsers(1, [14], { email: 'priya.nair@example.com' });
    expect(out).toEqual({ technicianIds: [14], revokedKeyIds: [key.id] });
    expect(settingsMock.set).toHaveBeenCalledWith('personal_api_key_users_ws1', '[14]');
    expect(auditMock.recordAccessEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'personal_key_access_granted', targetEmail: 'eli.park@example.com', targetLabel: 'Eli Park', actorEmail: 'priya.nair@example.com' }));
    expect(auditMock.recordAccessEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'personal_key_access_removed', targetEmail: 'dana.fox@example.com' }));
    expect(auditMock.recordAccessEvent).toHaveBeenCalledTimes(2);
    expect(rows.get(key.id).revokedReason).toBe('access_removed');
    expect(auditMock.recordCredentialEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'personal_key_revoked', extra: expect.objectContaining({ reason: 'access_removed' }) }));
    // the next v1 call sees the new list at once (cache refreshed by the write)
    expect(await svc.getListedTechnicianIds(1)).toEqual([14]);
  });

  test('a person with no agent profile, or a switched-off one, is refused with 422 and nothing is saved', async () => {
    await expect(svc.adminSetUsers(1, [12, 999, 15], { email: 'priya.nair@example.com' })).rejects.toMatchObject({
      statusCode: 422,
      code: 'personal_key_user_not_eligible',
      details: [{ technicianId: 999, reason: expect.any(String) }, { technicianId: 15, reason: 'Their agent profile is switched off.' }],
    });
    expect(settingsMock.set).not.toHaveBeenCalled();
    expect(auditMock.recordAccessEvent).not.toHaveBeenCalled();
  });

  test('PUT users with a delta applies only the delta, to the list as it is now; a stale technicianIds beside it is ignored', async () => {
    settings.set('personal_api_key_users_ws1', '[12]');
    // another admin added Eli a moment ago; this admin's picker still shows [12, 15] (stale)
    settings.set('personal_api_key_users_ws1', '[12,14]');
    const out = await svc.adminSetUsers(1, { add: [], remove: [12], technicianIds: [12, 15] }, { email: 'priya.nair@example.com' });
    expect(out.technicianIds).toEqual([14]);
    expect(settings.get('personal_api_key_users_ws1')).toBe('[14]');
    expect(auditMock.recordAccessEvent).toHaveBeenCalledTimes(1);
    expect(auditMock.recordAccessEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'personal_key_access_removed', targetEmail: 'dana.fox@example.com' }));
    // an add-only delta
    const added = await svc.adminSetUsers(1, { add: [12] }, {});
    expect(added.technicianIds).toEqual([12, 14]);
    // neither add nor remove: the whole-list form
    expect((await svc.adminSetUsers(1, { technicianIds: [14] }, {})).technicianIds).toEqual([14]);
    await expect(svc.adminSetUsers(1, {}, {})).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.adminSetUsers(1, { add: 'x' }, {})).rejects.toMatchObject({ statusCode: 400 });
    // a delta that adds someone not eligible is still 422
    await expect(svc.adminSetUsers(1, { add: [15] }, {})).rejects.toMatchObject({ statusCode: 422 });
  });

  test('an unchanged list writes no history', async () => {
    await svc.adminSetUsers(1, [12], {});
    expect(auditMock.recordAccessEvent).not.toHaveBeenCalled();
  });
});

describe('offboarding', () => {
  test('switching a technician off revokes their keys (offboarded); removing access by e-mail does too', async () => {
    const { key } = await svc.createOwnKey(1, dana, body());
    expect(await svc.revokeForTechnician(1, 12, { actorEmail: 'priya.nair@example.com' })).toEqual([key.id]);
    expect(rows.get(key.id).revokedReason).toBe('offboarded');
    rows.get(key.id).revokedAt = null;
    expect(await svc.revokeForEmail(1, 'DANA.FOX@example.com')).toEqual([key.id]);
    // nothing left: a second call revokes nothing and never throws
    expect(await svc.revokeForEmail(1, 'dana.fox@example.com')).toEqual([]);
  });

  test('offboarding a technician revokes AND takes them off the list, with an access event', async () => {
    settings.set('personal_api_key_users_ws1', '[12,14]');
    const { key } = await svc.createOwnKey(1, dana, body());
    auditMock.recordAccessEvent.mockClear();
    const out = await svc.offboardTechnician(1, 12, { actorEmail: 'priya.nair@example.com' });
    expect(out).toEqual({ revokedKeyIds: [key.id], removedFromList: [12] });
    expect(settings.get('personal_api_key_users_ws1')).toBe('[14]');
    expect(auditMock.recordAccessEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'personal_key_access_removed', targetEmail: 'dana.fox@example.com', actorEmail: 'priya.nair@example.com', details: expect.objectContaining({ technicianId: 12, reason: 'offboarded' }),
    }));
    // the next call sees it at once
    expect(await svc.getListedTechnicianIds(1)).toEqual([14]);
  });

  test('offboarding by e-mail (access removed) finds their agent profile and takes them off the list too', async () => {
    const out = await svc.offboardEmail(1, 'Dana.Fox@example.com');
    expect(out.removedFromList).toEqual([12]);
    expect(settings.get('personal_api_key_users_ws1')).toBe('[]');
  });

  test('after a bulk switch-off, every listed person or key owner no longer active is offboarded', async () => {
    settings.set('personal_api_key_users_ws1', '[12,14]');
    const { key } = await svc.createOwnKey(1, dana, body());
    const inactiveDana = { ...DANA, isActive: false };
    prismaMock.technician.findMany.mockImplementation(async ({ where }) => [inactiveDana, ELI, SAM_OFF].filter((t) => !where.id || where.id.in.includes(t.id)));
    expect(await svc.offboardInactiveTechnicians(1)).toEqual([12]);
    expect(rows.get(key.id).revokedReason).toBe('offboarded');
    expect(settings.get('personal_api_key_users_ws1')).toBe('[14]');
  });

  test('a database error never breaks the offboarding step', async () => {
    prismaMock.personalApiKey.findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.revokeForTechnician(1, 12)).resolves.toEqual([]);
  });
});

describe('expiry sweep', () => {
  test('warns the owner once, 7 days before the end; records the end once', async () => {
    const { key } = await svc.createOwnKey(1, dana, body());
    rows.get(key.id).expiresAt = new Date(Date.now() + 5 * 86400000);
    mailMock.deliverTransactionalEmail.mockClear();
    expect(await svc.runExpirySweep()).toEqual({ warned: 1, expired: 0 });
    expect(mailMock.deliverTransactionalEmail).toHaveBeenCalledWith(expect.objectContaining({ to: ['dana.fox@example.com'], subject: expect.stringMatching(/^Your API key "Laptop script" ends on /) }));
    expect(await svc.runExpirySweep()).toEqual({ warned: 0, expired: 0 });
    rows.get(key.id).expiresAt = new Date(Date.now() - 1000);
    expect(await svc.runExpirySweep()).toEqual({ warned: 0, expired: 1 });
    expect(auditMock.recordCredentialEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'personal_key_expired' }));
    expect(await svc.runExpirySweep()).toEqual({ warned: 0, expired: 0 });
  });
});

describe('the guide', () => {
  test('personalised for the person and their key, never the secret', async () => {
    const { secret } = await svc.createOwnKey(1, dana, body({ abilities: ['reply'] }));
    const { markdown, filename } = await svc.ownerGuide(1, dana, { baseUrl: 'https://tickets.example.com' });
    expect(filename).toBe('ticket-pulse-api-guide.md');
    expect(markdown).toContain('https://tickets.example.com/api/v1');
    expect(markdown).toContain('dana.fox@example.com');
    expect(markdown).toContain('<YOUR_KEY>');
    expect(markdown).not.toContain(secret);
    expect(markdown).toContain('/tickets/TP-1234/replies');
    expect(markdown).toContain('/tickets/TP-1234/notes');
    // no update ability on this key: the PATCH example is left out and the "No" line says so
    expect(markdown).not.toContain('-X PATCH');
    expect(markdown).toMatch(/No: change status, priority/);
  });

  test('refused for someone not on the list', async () => {
    settings.set('personal_api_key_users_ws1', '[]');
    await expect(svc.ownerGuide(1, dana, { baseUrl: 'https://tickets.example.com' })).rejects.toMatchObject({ statusCode: 403, code: 'personal_key_not_allowed' });
  });
});
