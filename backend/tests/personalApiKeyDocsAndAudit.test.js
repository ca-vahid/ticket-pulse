import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Personal API keys (4.4.05): the OpenAPI "Personal keys" section, the admin
 * alert wording for a personal key, and the Idempotency-Key bucket (a personal
 * key never shares an integration key's `key:<id>` bucket).
 */
const prismaMock = {
  apiIdempotencyKey: { create: jest.fn().mockResolvedValue({}), findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}), delete: jest.fn().mockResolvedValue({}) },
  accessAuditEvent: { create: jest.fn().mockResolvedValue({ id: 1 }) },
  workspace: { findUnique: jest.fn().mockResolvedValue({ name: 'IT' }) },
};
const mailMock = { deliverTransactionalEmail: jest.fn().mockResolvedValue({ sent: true }) };
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/reportRecipients.js', () => ({ reportRecipients: jest.fn(async () => ['priya.nair@example.com']) }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => mailMock);
jest.unstable_mockModule('../src/utils/publicBaseUrl.js', () => ({ resolvePublicBaseUrl: () => 'https://tickets.example.com' }));

const { buildOpenApiSpec, renderDocsPage, PERSONAL_KEYS_DOC } = await import('../src/routes/apiV1.openapi.js');
const { recordCredentialEvent, renderCredentialAlert } = await import('../src/services/accessAuditService.js');
const { withIdempotency } = await import('../src/middleware/apiIdempotency.js');
const { ABILITIES, PERSONAL_KEY_RATE_LIMIT } = await import('../src/services/personalApiKeyService.js');

beforeEach(() => jest.clearAllMocks());

describe('OpenAPI: personal keys', () => {
  const spec = buildOpenApiSpec('https://tickets.example.com');

  test('the spec documents the scheme, /me/guide, the codes and the facts', () => {
    expect(spec.components.securitySchemes.personalKey).toEqual(expect.objectContaining({ type: 'http', scheme: 'bearer' }));
    expect(spec.paths['/me/guide'].get.security).toEqual([{ personalKey: [] }]);
    expect(spec.info['x-personal-keys']).toBe(PERSONAL_KEYS_DOC);
    const codes = spec.info['x-problem-codes'].map((c) => c.code);
    for (const c of ['read_only_role', 'personal_key_owner_has_no_access', 'personal_key_not_allowed', 'personal_key_not_allowed_here', 'personal_key_required']) expect(codes).toContain(c);
    expect(new Set(codes).size).toBe(codes.length);
    expect(spec.paths['/tickets/{id}/replies'].post.summary).toMatch(/signature_removed/);
  });

  test('the documented abilities and limit match the service', () => {
    expect(PERSONAL_KEYS_DOC.rateLimitPerMinute).toBe(PERSONAL_KEY_RATE_LIMIT);
    expect(PERSONAL_KEYS_DOC.abilities.map((a) => [a.id, a.scopes])).toEqual(ABILITIES.map((a) => [a.id, [...a.scopes]]));
  });

  test('the docs page has a Personal keys section with a reply example, the limit and no undo', () => {
    const html = renderDocsPage('https://tickets.example.com');
    expect(html).toContain('<h2>Personal keys</h2>');
    expect(html).toContain('https://tickets.example.com/api/v1/tickets/TP-1234/replies');
    expect(html).toContain('60 requests a minute');
    expect(html).toMatch(/No undo/);
    expect(html).toMatch(/acts as them/);
    expect(html).not.toMatch(/<script[^>]+src=/);
  });
});

describe('admin alert for a personal key', () => {
  test('says "personal API key" and who it acts as; created/rotated/enabled alert, revoke does not', async () => {
    const out = renderCredentialAlert({
      workspaceName: 'IT', actorEmail: 'dana.fox@example.com', action: 'personal_key_created',
      credential: { name: 'Laptop script' }, details: { scopes: ['tickets:read'], ipAllowlist: [], expiresAt: '2027-02-20T00:00:00.000Z', prefix: 'tpu_AbCdEfGh', ownerEmail: 'dana.fox@example.com' },
      settingsUrl: 'https://tickets.example.com/settings#api-keys',
    });
    expect(out.subject).toBe('New personal API key in IT: "Laptop script"');
    expect(out.text).toContain('Acts as: dana.fox@example.com');
    const enabled = renderCredentialAlert({ workspaceName: 'IT', actorEmail: 'priya.nair@example.com', action: 'personal_key_enabled_by_admin', credential: { name: 'Laptop script' }, details: {}, settingsUrl: 'x' });
    expect(enabled.subject).toMatch(/^Switched back on personal API key/);

    await recordCredentialEvent({ workspaceId: 1, actorEmail: 'dana.fox@example.com', action: 'personal_key_created', credential: { id: 31, name: 'Laptop script', keyPrefix: 'tpu_AbCdEfGh', scopes: ['tickets:read'] }, extra: { ownerEmail: 'dana.fox@example.com' }, targetEmail: 'dana.fox@example.com' });
    expect(prismaMock.accessAuditEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'personal_key_created', targetEmail: 'dana.fox@example.com', targetLabel: 'Laptop script', details: expect.objectContaining({ kind: 'personal_key', prefix: 'tpu_AbCdEfGh' }) }) });
    expect(mailMock.deliverTransactionalEmail).toHaveBeenCalledWith(expect.objectContaining({ to: ['priya.nair@example.com'], subject: 'New personal API key in IT: "Laptop script"' }));

    mailMock.deliverTransactionalEmail.mockClear();
    await recordCredentialEvent({ workspaceId: 1, actorEmail: 'dana.fox@example.com', action: 'personal_key_revoked', credential: { id: 31, name: 'Laptop script' } });
    expect(mailMock.deliverTransactionalEmail).not.toHaveBeenCalled();
  });

  test('integration-key alerts are unchanged', () => {
    const out = renderCredentialAlert({ workspaceName: 'IT', actorEmail: 'priya.nair@example.com', action: 'api_key_created', credential: { name: 'Power App' }, details: {}, settingsUrl: 'x' });
    expect(out.subject).toBe('New API key in IT: "Power App"');
    expect(out.text).not.toContain('Acts as');
  });
});

describe('Idempotency-Key buckets', () => {
  function app(apiKey) {
    const a = express();
    a.use(express.json());
    a.post('/w', (req, _res, next) => { req.apiKey = apiKey; next(); }, withIdempotency, (req, res) => res.status(201).json({ ok: true }));
    return a;
  }

  test('a personal key uses pkey:<id>; an integration key still uses key:<id>', async () => {
    await request(app({ id: null, personalKeyId: 31 })).post('/w').set('Idempotency-Key', 'k1').send({ a: 1 }).expect(201);
    expect(prismaMock.apiIdempotencyKey.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ principal: 'pkey:31', apiKeyId: null }) });
    await request(app({ id: 7 })).post('/w').set('Idempotency-Key', 'k1').send({ a: 1 }).expect(201);
    expect(prismaMock.apiIdempotencyKey.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ principal: 'key:7', apiKeyId: 7 }) });
  });
});
