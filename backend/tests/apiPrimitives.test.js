import { jest } from '@jest/globals';

/** Public-API primitives: IP allowlist, client IP, and durable rate limiting. */

const prismaMock = { apiRateWindow: { upsert: jest.fn(), deleteMany: jest.fn().mockResolvedValue({ count: 0 }) } };
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { ipAllowed, clientIp } = await import('../src/middleware/apiKeyAuth.js');
const rateLimiter = (await import('../src/services/apiRateLimitService.js')).default;

describe('ipAllowed', () => {
  test('exact IPv4 match', () => {
    expect(ipAllowed('203.0.113.7', ['203.0.113.7'])).toBe(true);
    expect(ipAllowed('203.0.113.8', ['203.0.113.7'])).toBe(false);
  });
  test('CIDR range match', () => {
    expect(ipAllowed('10.1.2.3', ['10.1.0.0/16'])).toBe(true);
    expect(ipAllowed('10.2.2.3', ['10.1.0.0/16'])).toBe(false);
    expect(ipAllowed('192.168.1.5', ['192.168.1.0/24'])).toBe(true);
  });
  test('no IP or empty allowlist', () => {
    expect(ipAllowed(null, ['10.0.0.0/8'])).toBe(false);
    expect(ipAllowed('10.0.0.1', [])).toBe(false);
  });
});

describe('clientIp', () => {
  test('trusts Express req.ip (set via trust proxy), ignoring a spoofable XFF header', () => {
    // req.ip is the platform-verified client hop. A forged X-Forwarded-For must
    // NOT win — that would defeat the IP allowlist and every per-IP throttle.
    expect(clientIp({ ip: '198.51.100.9', headers: { 'x-forwarded-for': '1.2.3.4' }, socket: {} })).toBe('198.51.100.9');
  });
  test('falls back to the socket address and strips v4-mapped v6', () => {
    expect(clientIp({ headers: {}, socket: { remoteAddress: '::ffff:203.0.113.5' } })).toBe('203.0.113.5');
  });
});

describe('rate limiter (durable fixed window)', () => {
  test('allows until the limit, then blocks', async () => {
    prismaMock.apiRateWindow.upsert.mockResolvedValueOnce({ count: 1 });
    let r = await rateLimiter.hit('key:1', 2);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(1);

    prismaMock.apiRateWindow.upsert.mockResolvedValueOnce({ count: 3 });
    r = await rateLimiter.hit('key:1', 2);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
    expect(r.reset).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test('fails open if the store errors (never blocks the API)', async () => {
    prismaMock.apiRateWindow.upsert.mockRejectedValueOnce(new Error('db down'));
    const r = await rateLimiter.hit('key:1', 5);
    expect(r.allowed).toBe(true);
  });
});
