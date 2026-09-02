import { jest } from '@jest/globals';

/**
 * Phase RL (RL-2) — a Graph 403 is `permission_denied` with the exact grant
 * text, never `ip_blocked`; SendGrid 403s keep their IP-allowlist meaning;
 * the per-workspace send-lane summary the Ticket Mailboxes panel reads.
 */

const prismaMock = {
  notificationChannelHealthEvent: { create: jest.fn().mockResolvedValue({ id: 1 }), findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn() },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const {
  default: emailHealthService, classifyEmailError, hintForFailure, isGraphPermissionError, GRAPH_PERMISSION_GRANT_TEXT,
} = await import('../src/services/emailHealthService.js');

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.notificationChannelHealthEvent.create.mockResolvedValue({ id: 1 });
  prismaMock.notificationChannelHealthEvent.findFirst.mockResolvedValue(null);
});

describe('classifyEmailError — Graph 403 (RL-2)', () => {
  test('provider msgraph + 403 → permission_denied', () => {
    expect(classifyEmailError({ statusCode: 403, message: 'Access is denied. Check credentials and try again.' }, { provider: 'msgraph' }).errorClass).toBe('permission_denied');
  });
  test('an error tagged by graphMailClient classifies without the provider hint', () => {
    expect(classifyEmailError({ statusCode: 403, graphPermissionDenied: true, message: 'Microsoft Graph sendMail as x was refused' }).errorClass).toBe('permission_denied');
    expect(classifyEmailError({ code: 'ErrorAccessDenied', message: 'Access is denied' }).errorClass).toBe('permission_denied');
  });
  test('a SendGrid 403 stays ip_blocked (the allowlist case)', () => {
    expect(classifyEmailError({ providerStatus: 403, message: 'access forbidden' }, { provider: 'sendgrid' }).errorClass).toBe('ip_blocked');
    expect(classifyEmailError({ providerStatus: 403, message: 'access forbidden' }).errorClass).toBe('ip_blocked');
    expect(isGraphPermissionError({ providerStatus: 403, message: 'access forbidden' })).toBe(false);
  });
  test('the hint carries the exact grant text', () => {
    expect(GRAPH_PERMISSION_GRANT_TEXT).toMatch(/^Grant Mail\.ReadWrite \(application\) to Ticket Pulse Backend/);
    expect(hintForFailure({ errorClass: 'permission_denied', provider: 'msgraph' })).toContain(GRAPH_PERMISSION_GRANT_TEXT);
    expect(hintForFailure({ errorClass: 'ip_blocked', provider: 'msgraph' })).toContain('Mail.ReadWrite');
  });
});

describe('recordFailure persists permission_denied for the Graph lane', () => {
  test('the health event row carries error_class permission_denied + 403', async () => {
    const err = Object.assign(new Error('Access is denied. Check credentials and try again.'), { statusCode: 403, code: 'ErrorAccessDenied' });
    await emailHealthService.recordFailure({ workspaceId: 5, provider: 'msgraph', context: 'native_reply', error: err, recipients: ['a@b.c'] });
    expect(prismaMock.notificationChannelHealthEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ workspaceId: 5, provider: 'msgraph', success: false, errorClass: 'permission_denied', statusCode: 403 }),
    });
  });
  test('status derivation treats permission_denied as systemic (down after one failure)', () => {
    const status = emailHealthService._classify('email', [
      { success: false, errorClass: 'permission_denied', statusCode: 403, provider: 'msgraph', createdAt: new Date(), sanitizedMessage: 'x' },
      { success: true, createdAt: new Date(Date.now() - 1000) },
    ]);
    expect(status.status).toBe('down');
    expect(status.hint).toContain('Grant Mail.ReadWrite');
  });
});

describe('getGraphSendLane (panel state)', () => {
  test('null when Graph was never tried', async () => {
    expect(await emailHealthService.getGraphSendLane(5)).toBeNull();
    expect(prismaMock.notificationChannelHealthEvent.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ channel: 'email', provider: 'msgraph', workspaceId: 5 }),
    }));
  });
  test('not_granted with the grant text on permission_denied — and on pre-RL ip_blocked/403 rows', async () => {
    prismaMock.notificationChannelHealthEvent.findFirst.mockResolvedValue({ success: false, errorClass: 'permission_denied', statusCode: 403, createdAt: new Date('2026-09-01T16:10:00Z'), sanitizedMessage: 'denied' });
    const lane = await emailHealthService.getGraphSendLane(5);
    expect(lane).toMatchObject({ status: 'not_granted', errorClass: 'permission_denied', permissionGrantText: GRAPH_PERMISSION_GRANT_TEXT });

    prismaMock.notificationChannelHealthEvent.findFirst.mockResolvedValue({ success: false, errorClass: 'ip_blocked', statusCode: 403, createdAt: new Date(), sanitizedMessage: 'old row' });
    expect((await emailHealthService.getGraphSendLane(5)).status).toBe('not_granted');
  });
  test('ok after a successful Graph send; failing for other errors', async () => {
    prismaMock.notificationChannelHealthEvent.findFirst.mockResolvedValue({ success: true, createdAt: new Date() });
    expect((await emailHealthService.getGraphSendLane(5)).status).toBe('ok');
    prismaMock.notificationChannelHealthEvent.findFirst.mockResolvedValue({ success: false, errorClass: 'network', statusCode: null, createdAt: new Date(), sanitizedMessage: 'timeout' });
    const lane = await emailHealthService.getGraphSendLane(5);
    expect(lane.status).toBe('failing');
    expect(lane).not.toHaveProperty('permissionGrantText');
  });
});
