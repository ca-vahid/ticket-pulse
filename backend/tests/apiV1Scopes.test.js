import { jest } from '@jest/globals';

/** API v1 (gap plan P3.1): scope catalog + OpenAPI spec sanity. */

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { API_KEY_SCOPES, generateApiKey, hashApiKey } = await import('../src/routes/apiV1.routes.js');

describe('API v1 scopes', () => {
  test('the full scope catalog is granted individually', () => {
    expect(API_KEY_SCOPES).toEqual([
      'tickets:read', 'tickets:write', 'tickets:notes', 'tickets:attachments',
      'approvals:read', 'approvals:write', 'tags:read', 'tags:write',
    ]);
  });

  test('keys hash deterministically and carry the tpk_ prefix', () => {
    const { raw, hash, prefix } = generateApiKey();
    expect(raw.startsWith('tpk_')).toBe(true);
    expect(prefix).toBe(raw.slice(0, 12));
    expect(hashApiKey(raw)).toBe(hash);
    expect(hashApiKey(raw)).toHaveLength(64);
  });
});
