import { jest } from '@jest/globals';

/** Built-in OAuth2 client-credentials: credential check + token round-trip. */

const prismaMock = { oAuthClient: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) } };
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/config/index.js', () => ({ default: { session: { secret: 'test-oauth-signing-secret-0123456789' } } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const svc = await import('../src/services/oauthClientService.js');
const { generateClient, hashSecret, clientUsable, verifyClientCredentials, issueAccessToken, verifyAccessToken } = svc;

const usableClient = (over = {}) => ({ id: 1, workspaceId: 7, clientId: 'tpc_abc', clientSecretHash: hashSecret('tps_secret'), scopes: ['tickets:read'], isEnabled: true, revokedAt: null, expiresAt: null, ...over });

beforeEach(() => jest.clearAllMocks());

describe('generateClient', () => {
  test('mints tpc_/tps_ ids and stores only the hash', () => {
    const c = generateClient();
    expect(c.clientId).toMatch(/^tpc_/);
    expect(c.secret).toMatch(/^tps_/);
    expect(c.secretHash).toBe(hashSecret(c.secret));
    expect(c.secretPrefix).toBe(c.secret.slice(0, 12));
  });
});

describe('clientUsable', () => {
  test('rejects disabled / revoked / expired', () => {
    expect(clientUsable(usableClient())).toBe(true);
    expect(clientUsable(usableClient({ isEnabled: false }))).toBe(false);
    expect(clientUsable(usableClient({ revokedAt: new Date() }))).toBe(false);
    expect(clientUsable(usableClient({ expiresAt: new Date(Date.now() - 1000) }))).toBe(false);
  });
});

describe('verifyClientCredentials', () => {
  test('accepts the right secret, rejects wrong secret / disabled', async () => {
    prismaMock.oAuthClient.findUnique.mockResolvedValue(usableClient());
    expect(await verifyClientCredentials('tpc_abc', 'tps_secret')).toBeTruthy();
    expect(await verifyClientCredentials('tpc_abc', 'tps_wrong')).toBeNull();

    prismaMock.oAuthClient.findUnique.mockResolvedValue(usableClient({ isEnabled: false }));
    expect(await verifyClientCredentials('tpc_abc', 'tps_secret')).toBeNull();
  });
});

describe('access token round-trip', () => {
  test('issued token verifies and carries workspace + scopes', () => {
    const token = issueAccessToken(usableClient());
    expect(token.token_type).toBe('Bearer');
    expect(token.expires_in).toBeGreaterThan(0);
    const claims = verifyAccessToken(token.access_token);
    expect(claims.wsid).toBe(7);
    expect(claims.cid).toBe('tpc_abc');
    expect(claims.scopes).toEqual(['tickets:read']);
    expect(claims.typ).toBe('tp_api_oauth');
  });

  test('a garbage or foreign token is rejected', () => {
    expect(() => verifyAccessToken('not.a.jwt')).toThrow();
  });
});
