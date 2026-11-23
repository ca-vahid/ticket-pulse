import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';

/**
 * Personal API keys (4.4.05): how a `tpu_` key authenticates on /api/v1.
 * Every call re-checks the key, the workspace's API access list, the person's
 * access and role; scopes are capped by the ability table and the role.
 * Integration keys (`tp_live_`) and OAuth are pinned unchanged.
 */
const prismaMock = {
  personalApiKey: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  apiKey: { findUnique: jest.fn(), update: jest.fn() },
  oAuthClient: { findUnique: jest.fn(), update: jest.fn() },
  technician: { findFirst: jest.fn() },
  workspace: { findUnique: jest.fn() },
};
const settings = new Map();
const settingsMock = { get: jest.fn(async (k) => settings.get(k) ?? null), set: jest.fn(async (k, v) => settings.set(k, v)) };
const workspaceRepoMock = { getAccessRole: jest.fn() };
const rateLimiterMock = { hit: jest.fn().mockResolvedValue({ allowed: true, limit: 60, remaining: 59, reset: 0 }) };
const auditMock = { recordAccessEvent: jest.fn().mockResolvedValue({}), recordCredentialEvent: jest.fn().mockResolvedValue({}) };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({ default: workspaceRepoMock }));
jest.unstable_mockModule('../src/services/apiRateLimitService.js', () => ({ default: rateLimiterMock }));
jest.unstable_mockModule('../src/services/accessAuditService.js', () => auditMock);
jest.unstable_mockModule('../src/services/reportRecipients.js', () => ({ superAdminEmails: jest.fn(async () => []) }));
jest.unstable_mockModule('../src/services/oauthClientService.js', () => ({ verifyAccessToken: jest.fn(() => { throw new Error('bad'); }), clientUsable: jest.fn(() => false) }));

const { requireApiKey } = await import('../src/middleware/apiKeyAuth.js');
const { apiProblemHandler } = await import('../src/utils/apiProblem.js');
const svc = await import('../src/services/personalApiKeyService.js');

const SECRET = 'tpu_personal-secret-for-jest-0001';
const hash = (raw) => createHash('sha256').update(raw).digest('hex');
const ALL_SCOPES = svc.scopesForAbilities(['read', 'reply', 'update', 'tasks']);
const DANA = { id: 12, name: 'Dana Fox', email: 'dana.fox@example.com', isActive: true };

function key(over = {}) {
  return {
    id: 31, workspaceId: 1, technicianId: 12, ownerEmail: 'dana.fox@example.com', name: 'Laptop script',
    keyHash: hash(SECRET), keyPrefix: 'tpu_personal', scopes: ALL_SCOPES, ipAllowlist: [],
    expiresAt: new Date(Date.now() + 86400000 * 30), isEnabled: true, revokedAt: null, expiredNotedAt: null,
    createdAt: new Date(), ...over,
  };
}

function app(scope) {
  const a = express();
  a.set('trust proxy', true);
  a.use(express.json());
  a.all('/r', requireApiKey(scope), (req, res) => res.json({ apiKey: req.apiKey, workspaceId: req.workspaceId }));
  a.use(apiProblemHandler);
  return a;
}

const call = (scope, raw = SECRET, ip = null) => {
  const r = request(app(scope)).get('/r').set('Authorization', `Bearer ${raw}`);
  return ip ? r.set('X-Forwarded-For', ip) : r;
};

beforeEach(() => {
  jest.clearAllMocks();
  settings.clear();
  svc.resetPersonalKeyCaches();
  settings.set('personal_api_key_users_ws1', '[12]');
  prismaMock.personalApiKey.findUnique.mockResolvedValue(key());
  prismaMock.personalApiKey.update.mockResolvedValue({});
  prismaMock.personalApiKey.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.technician.findFirst.mockResolvedValue(DANA);
  workspaceRepoMock.getAccessRole.mockResolvedValue(null); // an agent: no workspace_access row
  rateLimiterMock.hit.mockResolvedValue({ allowed: true, limit: 60, remaining: 59, reset: 0 });
});

describe('a working personal key', () => {
  test('runs as the person, with via, on its own 60/min bucket', async () => {
    const res = await call('tickets:read').expect(200);
    expect(prismaMock.personalApiKey.findUnique).toHaveBeenCalledWith({ where: { keyHash: hash(SECRET) } });
    expect(res.body.workspaceId).toBe(1);
    expect(res.body.apiKey.id).toBeNull(); // never an api_keys id
    expect(res.body.apiKey.personalKeyId).toBe(31);
    expect(res.body.apiKey.personal.actor).toEqual({
      email: 'dana.fox@example.com', name: 'Dana Fox', role: 'agent', workspaceRole: null, technicianId: 12, kind: 'agent',
      trustedIntake: false, defaultSource: null, via: { kind: 'personal_key', keyId: 31, keyName: 'Laptop script' },
    });
    expect(res.body.apiKey).toEqual(expect.objectContaining({ trustedIntake: false, fsStatusWrite: false, readExcludeCategoryIds: [], readPrivateNotes: true }));
    expect(rateLimiterMock.hit).toHaveBeenCalledWith('pkey:31', 60);
    // usage counters land on the personal key, never on api_keys
    await new Promise((r) => setTimeout(r, 20));
    expect(prismaMock.personalApiKey.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 31 }, data: expect.objectContaining({ requestCount: { increment: 1 } }) }));
    expect(prismaMock.apiKey.update).not.toHaveBeenCalled();
  });

  test('an admin\'s key carries no admin power: the role is capped at reviewer', async () => {
    workspaceRepoMock.getAccessRole.mockResolvedValue('admin');
    const res = await call('tickets:write').expect(200);
    expect(res.body.apiKey.personal.actor).toEqual(expect.objectContaining({ role: 'viewer', workspaceRole: 'reviewer', kind: 'member' }));
  });
});

describe('refused keys', () => {
  test('unknown, revoked and switched-off keys are 401 invalid_api_key', async () => {
    prismaMock.personalApiKey.findUnique.mockResolvedValueOnce(null);
    expect((await call('tickets:read').expect(401)).body.code).toBe('invalid_api_key');
    prismaMock.personalApiKey.findUnique.mockResolvedValueOnce(key({ revokedAt: new Date() }));
    expect((await call('tickets:read').expect(401)).body.code).toBe('invalid_api_key');
    prismaMock.personalApiKey.findUnique.mockResolvedValueOnce(key({ isEnabled: false }));
    const off = await call('tickets:read').expect(401);
    expect(off.body.detail).toMatch(/switched off by an admin/);
  });

  test('an expired key is 401 and records personal_key_expired once', async () => {
    prismaMock.personalApiKey.findUnique.mockResolvedValue(key({ expiresAt: new Date(Date.now() - 1000) }));
    const res = await call('tickets:read').expect(401);
    expect(res.body.detail).toMatch(/expired on/);
    expect(prismaMock.personalApiKey.updateMany).toHaveBeenCalledWith({ where: { id: 31, expiredNotedAt: null }, data: { expiredNotedAt: expect.any(Date) } });
    expect(auditMock.recordCredentialEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'personal_key_expired', workspaceId: 1 }));
    // already noted: nothing more is recorded
    auditMock.recordCredentialEvent.mockClear();
    prismaMock.personalApiKey.findUnique.mockResolvedValue(key({ expiresAt: new Date(Date.now() - 1000), expiredNotedAt: new Date() }));
    await call('tickets:read').expect(401);
    expect(auditMock.recordCredentialEvent).not.toHaveBeenCalled();
  });

  test('a call from outside the IP lock is 403 ip_not_allowed', async () => {
    prismaMock.personalApiKey.findUnique.mockResolvedValue(key({ ipAllowlist: ['203.0.113.0/24'] }));
    expect((await call('tickets:read', SECRET, '198.51.100.9').expect(403)).body.code).toBe('ip_not_allowed');
    await call('tickets:read', SECRET, '203.0.113.40').expect(200);
  });

  test('a person taken off the list is 403 personal_key_not_allowed', async () => {
    settings.set('personal_api_key_users_ws1', '[]');
    expect((await call('tickets:read').expect(403)).body.code).toBe('personal_key_not_allowed');
  });

  test('a ticked person who lost workspace access gets 403 on everything', async () => {
    prismaMock.technician.findFirst.mockResolvedValue({ ...DANA, isActive: false });
    workspaceRepoMock.getAccessRole.mockResolvedValue(null);
    expect((await call('tickets:read').expect(403)).body.code).toBe('personal_key_owner_has_no_access');
    expect((await call('conversations:write').expect(403)).body.code).toBe('personal_key_owner_has_no_access');
  });

  test('an agent profile whose e-mail no longer matches the key is no access', async () => {
    prismaMock.technician.findFirst.mockResolvedValue({ ...DANA, email: 'someone.else@example.com' });
    expect((await call('tickets:read').expect(403)).body.code).toBe('personal_key_not_allowed');
  });

  test('a ticked person who is now read-only can read, but writes get 403 read_only_role', async () => {
    workspaceRepoMock.getAccessRole.mockResolvedValue('readonly');
    const ok = await call('tickets:read').expect(200);
    expect(ok.body.apiKey.scopes.every((s) => s.endsWith(':read'))).toBe(true);
    expect((await call('tickets:write').expect(403)).body.code).toBe('read_only_role');
    expect((await call(['tickets:write', 'conversations:write']).expect(403)).body.code).toBe('read_only_role');
  });

  test('scopes outside the ability table are refused at call time, even if stored on the key', async () => {
    prismaMock.personalApiKey.findUnique.mockResolvedValue(key({ scopes: [...ALL_SCOPES, 'approvals:write', 'webhooks:manage', 'customfields:write', 'tags:create', '*'] }));
    for (const s of ['approvals:write', 'webhooks:manage', 'customfields:write', 'tags:create', 'approvals:read']) {
      expect((await call(s).expect(403)).body.code).toBe('insufficient_scope');
    }
  });

  test('a key without an ability is refused that scope', async () => {
    prismaMock.personalApiKey.findUnique.mockResolvedValue(key({ scopes: svc.scopesForAbilities(['read']) }));
    expect((await call('conversations:write').expect(403)).body.code).toBe('insufficient_scope');
  });

  test('over 60 a minute is 429', async () => {
    rateLimiterMock.hit.mockResolvedValueOnce({ allowed: false, limit: 60, remaining: 0, reset: Math.floor(Date.now() / 1000) + 30 });
    const res = await call('tickets:read').expect(429);
    expect(res.body.detail).toMatch(/60 requests\/minute/);
  });
});

describe('integration keys are unchanged (pin)', () => {
  test('a tp_live_ key resolves exactly as before: same req.apiKey shape, 120/min, key:<id> bucket, api_keys usage', async () => {
    const raw = 'tp_live_integration-secret-0001';
    prismaMock.apiKey.findUnique.mockResolvedValue({
      id: 7, workspaceId: 1, name: 'Power App', keyPrefix: 'tp_live_integrat', mode: 'live', scopes: ['tickets:read'],
      isEnabled: true, revokedAt: null, expiresAt: null, ipAllowlist: [], rateLimitPerMin: null, trustedIntake: false,
    });
    prismaMock.apiKey.update.mockResolvedValue({});
    rateLimiterMock.hit.mockResolvedValue({ allowed: true, limit: 120, remaining: 119, reset: 0 });
    const res = await call('tickets:read', raw).expect(200);
    expect(res.body.apiKey).toEqual({
      id: 7, keyPrefix: 'tp_live_integrat', name: 'Power App', scopes: ['tickets:read'], mode: 'live',
      oauthClientId: null, trustedIntake: false, defaultSource: null, structureOwnTicketsOnly: false,
      fsStatusWrite: false, readExcludeCategoryIds: [], readPrivateNotes: true,
    });
    expect(rateLimiterMock.hit).toHaveBeenCalledWith('key:7', 120);
    expect(prismaMock.personalApiKey.findUnique).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 20));
    expect(prismaMock.apiKey.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 7 } }));
    expect(prismaMock.personalApiKey.update).not.toHaveBeenCalled();
  });

  test('a tp_ key never reaches the personal key table, and a tpu_ key never reaches api_keys', async () => {
    prismaMock.apiKey.findUnique.mockResolvedValue(null);
    await call('tickets:read', 'tp_live_nope').expect(401);
    expect(prismaMock.personalApiKey.findUnique).not.toHaveBeenCalled();
    await call('tickets:read', SECRET).expect(200);
    expect(prismaMock.apiKey.findUnique).toHaveBeenCalledTimes(1);
  });
});
