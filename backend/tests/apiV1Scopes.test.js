import { jest } from '@jest/globals';

/** API v1: scope catalogue, key format, and wildcard scope matching. */

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  API_KEY_SCOPES, generateApiKey, hashApiKey, scopeSatisfies, keyUsable,
} = await import('../src/services/apiKeyService.js');

describe('API v1 scopes', () => {
  test('the scope catalogue covers the FreshService-parity resources', () => {
    for (const s of ['tickets:read', 'tickets:write', 'conversations:write', 'contacts:read',
      'agents:read', 'groups:read', 'tasks:write', 'webhooks:manage', 'search:read',
      // FR 08-05 #1: custom-field definitions read + values write (conditional gate).
      'customfields:read', 'customfields:write']) {
      expect(API_KEY_SCOPES).toContain(s);
    }
  });

  test('keys hash deterministically and carry a tp_<mode>_ prefix', () => {
    const live = generateApiKey('live');
    expect(live.raw.startsWith('tp_live_')).toBe(true);
    expect(live.prefix).toBe(live.raw.slice(0, 16));
    expect(hashApiKey(live.raw)).toBe(live.hash);
    expect(hashApiKey(live.raw)).toHaveLength(64);
    expect(generateApiKey('test').raw.startsWith('tp_test_')).toBe(true);
  });

  test('scopeSatisfies honors exact, wildcard, and superuser grants', () => {
    expect(scopeSatisfies(['tickets:read'], 'tickets:read')).toBe(true);
    expect(scopeSatisfies(['tickets:read'], 'tickets:write')).toBe(false);
    expect(scopeSatisfies(['tickets:*'], 'tickets:write')).toBe(true);
    expect(scopeSatisfies(['*:read'], 'contacts:read')).toBe(true);
    expect(scopeSatisfies(['*'], 'anything:goes')).toBe(true);
    // legacy alias still works
    expect(scopeSatisfies(['tickets:notes'], 'conversations:write')).toBe(true);
  });

  test('keyUsable rejects disabled, revoked, and expired keys', () => {
    const base = { isEnabled: true, revokedAt: null, expiresAt: null };
    expect(keyUsable(base)).toBe(true);
    expect(keyUsable({ ...base, isEnabled: false })).toBe(false);
    expect(keyUsable({ ...base, revokedAt: new Date() })).toBe(false);
    expect(keyUsable({ ...base, expiresAt: new Date(Date.now() - 1000) })).toBe(false);
    expect(keyUsable({ ...base, expiresAt: new Date(Date.now() + 60000) })).toBe(true);
  });
});
