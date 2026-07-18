import { jest } from '@jest/globals';

/** Email delivery health — classification, hints, status derivation. */

const prismaMock = {
  notificationChannelHealthEvent: {
    create: jest.fn().mockResolvedValue({ id: 1 }),
    findMany: jest.fn().mockResolvedValue([]),
  },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const mod = await import('../src/services/emailHealthService.js');
const { default: emailHealthService, classifyEmailError, sanitizeEmailErrorMessage, hintForFailure } = mod;

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.notificationChannelHealthEvent.create.mockResolvedValue({ id: 1 });
});

describe('classifyEmailError', () => {
  test('403 → ip_blocked (the SendGrid IP-allowlist case)', () => {
    expect(classifyEmailError({ providerStatus: 403, message: 'access forbidden' }).errorClass).toBe('ip_blocked');
  });
  test('401 → auth_error', () => {
    expect(classifyEmailError({ providerStatus: 401, message: 'Unauthorized' }).errorClass).toBe('auth_error');
  });
  test('not-configured → config_missing', () => {
    expect(classifyEmailError({ message: 'SendGrid is not configured' }).errorClass).toBe('config_missing');
  });
  test('429 → rate_limited', () => {
    expect(classifyEmailError({ providerStatus: 429, message: 'Too many requests' }).errorClass).toBe('rate_limited');
  });
  test('400 invalid address → invalid_recipient', () => {
    expect(classifyEmailError({ providerStatus: 400, message: 'Does not contain a valid address' }).errorClass).toBe('invalid_recipient');
  });
  test('5xx → provider_down', () => {
    expect(classifyEmailError({ providerStatus: 502, message: 'Bad gateway' }).errorClass).toBe('provider_down');
  });
  test('extracts numeric status code', () => {
    expect(classifyEmailError({ providerStatus: 403 }).statusCode).toBe(403);
  });
});

describe('sanitizeEmailErrorMessage', () => {
  test('redacts SendGrid keys and email addresses', () => {
    const msg = sanitizeEmailErrorMessage({ message: 'key SG.abc123_DEF.xyz failed for user@bgc.ca' });
    expect(msg).not.toContain('SG.abc123');
    expect(msg).not.toContain('user@bgc.ca');
    expect(msg).toContain('[redacted-key]');
    expect(msg).toContain('[email]');
  });
});

describe('hintForFailure', () => {
  test('ip_blocked hint points at SendGrid IP Access Management', () => {
    expect(hintForFailure({ errorClass: 'ip_blocked', provider: 'sendgrid' })).toMatch(/IP Access Management/i);
  });
  test('ip_blocked hint differs for msgraph', () => {
    expect(hintForFailure({ errorClass: 'ip_blocked', provider: 'msgraph' })).toMatch(/Graph/i);
  });
});

describe('recordSuccess / recordFailure', () => {
  test('recordSuccess writes a success row with recipient domain only', async () => {
    await emailHealthService.recordSuccess({ workspaceId: 2, context: 'test', provider: 'sendgrid', recipients: ['a@bgc.ca'] });
    const data = prismaMock.notificationChannelHealthEvent.create.mock.calls[0][0].data;
    expect(data.success).toBe(true);
    expect(data.channel).toBe('email');
    expect(data.recipientDomain).toBe('bgc.ca');
    expect(data).not.toHaveProperty('errorClass');
  });

  test('recordFailure classifies and stores status code', async () => {
    await emailHealthService.recordFailure({ context: 'approval', provider: 'sendgrid', error: { providerStatus: 403, message: 'access forbidden' } });
    const data = prismaMock.notificationChannelHealthEvent.create.mock.calls[0][0].data;
    expect(data.success).toBe(false);
    expect(data.errorClass).toBe('ip_blocked');
    expect(data.statusCode).toBe(403);
  });

  test('recording never throws even if the DB write fails', async () => {
    prismaMock.notificationChannelHealthEvent.create.mockRejectedValueOnce(new Error('db down'));
    await expect(emailHealthService.recordSuccess({ recipients: ['x@y.com'] })).resolves.toBeNull();
  });
});

describe('getStatus classification', () => {
  const at = (minsAgo, extra = {}) => ({ createdAt: new Date(Date.now() - minsAgo * 60000).toISOString(), ...extra });

  test('no events → unknown', async () => {
    prismaMock.notificationChannelHealthEvent.findMany.mockResolvedValue([]);
    expect((await emailHealthService.getStatus()).status).toBe('unknown');
  });

  test('most recent send succeeded → healthy', async () => {
    prismaMock.notificationChannelHealthEvent.findMany.mockResolvedValue([
      at(1, { success: true }), at(30, { success: false, errorClass: 'network' }),
    ]);
    expect((await emailHealthService.getStatus()).status).toBe('healthy');
  });

  test('most recent failure is systemic (ip_blocked) → down with hint', async () => {
    prismaMock.notificationChannelHealthEvent.findMany.mockResolvedValue([
      at(1, { success: false, errorClass: 'ip_blocked', statusCode: 403, provider: 'sendgrid' }),
      at(20, { success: true }),
    ]);
    const s = await emailHealthService.getStatus();
    expect(s.status).toBe('down');
    expect(s.hint).toMatch(/IP Access Management/i);
  });

  test('single non-systemic failure after success → degraded', async () => {
    prismaMock.notificationChannelHealthEvent.findMany.mockResolvedValue([
      at(1, { success: false, errorClass: 'invalid_recipient', statusCode: 400 }),
      at(10, { success: true }),
    ]);
    expect((await emailHealthService.getStatus()).status).toBe('degraded');
  });

  test('three consecutive failures → down even if non-systemic', async () => {
    prismaMock.notificationChannelHealthEvent.findMany.mockResolvedValue([
      at(1, { success: false, errorClass: 'provider_down' }),
      at(2, { success: false, errorClass: 'provider_down' }),
      at(3, { success: false, errorClass: 'provider_down' }),
      at(50, { success: true }),
    ]);
    expect((await emailHealthService.getStatus()).status).toBe('down');
  });

  test('24h counts reflect the rolling window', async () => {
    prismaMock.notificationChannelHealthEvent.findMany.mockResolvedValue([
      at(1, { success: true }), at(60, { success: false, errorClass: 'network' }),
    ]);
    const s = await emailHealthService.getStatus();
    expect(s.successCount24h).toBe(1);
    expect(s.failureCount24h).toBe(1);
  });
});
