import { jest } from '@jest/globals';

/**
 * MEGA 11-14 Part C: who cannot get Teams cards. Production (14 days to
 * 14 Nov 2026): 68 cards failed for 5 people with "App is blocked by app
 * permission policy". The status is derived from the conversation row and
 * the recent deliveries (no schema change); after 3 blocked sends in a row
 * sending pauses for 24 hours, and a notice with an e-mail equivalent goes by
 * e-mail instead.
 */

const prismaMock = {
  notificationWorkspaceSetting: { findUnique: jest.fn() },
  notificationPreference: { findUnique: jest.fn() },
  teamsDelivery: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  teamsConversation: { findUnique: jest.fn(), findMany: jest.fn(), upsert: jest.fn(), update: jest.fn() },
  technician: { findMany: jest.fn(), findFirst: jest.fn() },
  ticketNotificationMute: { findMany: jest.fn() },
  ticket: { findMany: jest.fn() },
  workspace: { findUnique: jest.fn() },
};
const BLOCKED = 'App is blocked by app permission policy. TenantId: 00000000-0000-0000-0000-000000000000';
const botMock = {
  isTeamsConfigured: jest.fn(() => true),
  teamsConfig: jest.fn(() => ({ appId: 'app', tenantId: 'tenant' })),
  sendToConversation: jest.fn().mockResolvedValue('act-1'),
  cardActivity: jest.fn((card, o) => ({ type: 'message', card, ...o })),
  sendActivityFeed: jest.fn().mockResolvedValue(),
  findUser: jest.fn().mockResolvedValue({ id: 'aad-1' }),
  installForUser: jest.fn(),
  createPersonalConversation: jest.fn().mockResolvedValue({ conversationId: 'conv-1', serviceUrl: 'https://smba/' }),
  describeError: (e) => e.message,
  probe: jest.fn().mockResolvedValue({ configured: true, botToken: true, graphToken: true, catalogAppId: 'cat' }),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/integrations/teamsBotClient.js', () => ({ default: botMock }));

const {
  default: svc, blockedBackoff, deriveTeamsStatus, isBlockedByPolicy, BACKOFF_AFTER,
} = await import('../src/services/teamsNotificationService.js');

const NOW = new Date('2026-11-16T17:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600_000);
const failedBlocked = (h) => ({ status: 'failed', reason: BLOCKED.slice(0, 120), createdAt: hoursAgo(h) });
const sent = (h) => ({ status: 'sent', reason: null, createdAt: hoursAgo(h) });

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.teamsDelivery.create.mockResolvedValue({});
  prismaMock.teamsDelivery.findMany.mockResolvedValue([]);
  prismaMock.teamsConversation.upsert.mockResolvedValue({});
  botMock.installForUser.mockRejectedValue(new Error(BLOCKED));
});

describe('blocked status, derived from what is already stored', () => {
  test('the Teams wording is recognised, other failures are not', () => {
    expect(isBlockedByPolicy(BLOCKED)).toBe(true);
    expect(isBlockedByPolicy('timeout of 15000ms exceeded')).toBe(false);
    expect(isBlockedByPolicy(null)).toBe(false);
  });

  test('three blocked sends in a row pause sending for 24 hours from the last one', () => {
    const rows = [failedBlocked(2), failedBlocked(5), failedBlocked(9), sent(30)];
    const b = blockedBackoff(rows, NOW);
    expect(b).toMatchObject({ active: true, streak: 3 });
    expect(b.until.toISOString()).toBe(new Date(hoursAgo(2).getTime() + 24 * 3600_000).toISOString());
    // The pause ends after a day; then one more try.
    expect(blockedBackoff([failedBlocked(25), failedBlocked(26), failedBlocked(27)], NOW).active).toBe(false);
  });

  test('two blocked sends, or a success in between, do not pause', () => {
    expect(blockedBackoff([failedBlocked(1), failedBlocked(2)], NOW).active).toBe(false);
    expect(blockedBackoff([failedBlocked(1), sent(2), failedBlocked(3), failedBlocked(4)], NOW).active).toBe(false);
    // Skipped rows (quiet hours, the pause itself) are not attempts and do not break the run.
    expect(blockedBackoff([{ status: 'skipped', reason: 'blocked_backoff', createdAt: hoursAgo(1) }, failedBlocked(2), failedBlocked(3), failedBlocked(4)], NOW).active).toBe(true);
    expect(BACKOFF_AFTER).toBe(3);
  });

  test('blocked: last failure time, cards missed in 7 days, the pause end', () => {
    const conv = { conversationId: null, lastError: BLOCKED, disconnectedAt: null };
    const rows = [failedBlocked(2), failedBlocked(5), failedBlocked(9), { status: 'skipped', reason: 'blocked_backoff', createdAt: hoursAgo(1) }, failedBlocked(24 * 8)];
    rows.sort((a, b) => b.createdAt - a.createdAt);
    const s = deriveTeamsStatus({ conv, rows, now: NOW });
    expect(s.state).toBe('blocked');
    expect(new Date(s.lastBlockedAt).toISOString()).toBe(hoursAgo(2).toISOString());
    expect(s.missed7d).toBe(4); // three failed + one paused; the 8-day-old one is out of the week
    expect(s.backoffUntil).not.toBeNull();
  });

  test('connected, disconnected (by whom) and never connected', () => {
    expect(deriveTeamsStatus({ conv: { conversationId: 'c', disconnectedAt: null }, rows: [sent(1)], now: NOW }).state).toBe('connected');
    const off = deriveTeamsStatus({ conv: { conversationId: null, disconnectedAt: hoursAgo(50), disconnectedBy: 'admin@example.com' }, rows: [{ status: 'skipped', reason: 'disconnected', createdAt: hoursAgo(3) }], now: NOW });
    expect(off).toMatchObject({ state: 'disconnected', missed7d: 1, disconnectedBy: 'admin@example.com' });
    expect(deriveTeamsStatus({ conv: null, rows: [], now: NOW }).state).toBe('not_connected');
    expect(deriveTeamsStatus({ conv: { conversationId: null, lastError: 'timeout of 15000ms exceeded' }, rows: [], now: NOW }).state).toBe('not_connected');
    // A chat on file but the last card was refused by the policy: still blocked.
    expect(deriveTeamsStatus({ conv: { conversationId: 'c' }, rows: [failedBlocked(1), sent(5)], now: NOW }).state).toBe('blocked');
  });
});

describe('the pause and the e-mail instead, inside the send path', () => {
  const PERSON = 'alex.rivera@example.com';
  const blockedConv = { email: PERSON, conversationId: null, aadObjectId: 'aad-1', lastError: BLOCKED, disconnectedAt: null };

  test('after three blocked sends nothing is tried for a day: a skipped row, no Graph calls', async () => {
    prismaMock.teamsConversation.findUnique.mockResolvedValue(blockedConv);
    prismaMock.teamsDelivery.findMany.mockResolvedValue([failedBlocked(0.5), failedBlocked(1), failedBlocked(2)].map((r) => ({ ...r, createdAt: new Date(Date.now() - (NOW - r.createdAt)) })));
    const res = await svc._send(PERSON, { type: 'AdaptiveCard' }, { summary: 'Assigned — TP-11777', workspaceId: 1, technicianId: 9, ticketId: 5, eventKey: 'assigned' });
    expect(res).toBeNull();
    expect(botMock.installForUser).not.toHaveBeenCalled();
    expect(botMock.sendToConversation).not.toHaveBeenCalled();
    expect(prismaMock.teamsDelivery.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'skipped', reason: 'blocked_backoff', eventKey: 'assigned' }) });
  });

  test('during the pause, a notice with an e-mail equivalent goes by e-mail (once-only key kept)', async () => {
    prismaMock.teamsConversation.findUnique.mockResolvedValue(blockedConv);
    prismaMock.teamsDelivery.findMany.mockResolvedValue([0.5, 1, 2].map((h) => ({ status: 'failed', reason: BLOCKED, createdAt: new Date(Date.now() - h * 3600_000) })));
    const emailFallback = jest.fn().mockResolvedValue(true);
    const outcome = {};
    const res = await svc._send(PERSON, { type: 'AdaptiveCard' }, { summary: 'x', workspaceId: 1, eventKey: 'av_approval_waiting', refKey: 'av:approver:alex.rivera@example.com:2026-11-16', emailFallback, outcome });
    expect(res).toBeNull();
    expect(emailFallback).toHaveBeenCalledTimes(1);
    expect(outcome.via).toBe('email');
    expect(prismaMock.teamsDelivery.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'emailed', reason: 'av:approver:alex.rivera@example.com:2026-11-16' }) });
  });

  test('blocked right now (not paused yet): the failure is recorded once and the e-mail goes instead', async () => {
    prismaMock.teamsConversation.findUnique.mockResolvedValue(blockedConv);
    prismaMock.teamsDelivery.findMany.mockResolvedValue([]); // no earlier attempts
    const emailFallback = jest.fn().mockResolvedValue(true);
    const outcome = {};
    const res = await svc._send(PERSON, { type: 'AdaptiveCard' }, { summary: 'x', workspaceId: 1, eventKey: 'av_approval_waiting', refKey: 'av:approver:k', emailFallback, outcome });
    expect(res).toBeNull();
    expect(botMock.installForUser).toHaveBeenCalledTimes(1);
    const statuses = prismaMock.teamsDelivery.create.mock.calls.map((c) => c[0].data.status);
    expect(statuses).toEqual(['failed', 'emailed']);
    expect(outcome.via).toBe('email');
  });

  test('a notice without an e-mail equivalent still throws on a blocked send (the caller records it)', async () => {
    prismaMock.teamsConversation.findUnique.mockResolvedValue(blockedConv);
    prismaMock.teamsDelivery.findMany.mockResolvedValue([]);
    await expect(svc._send(PERSON, { type: 'AdaptiveCard' }, { summary: 'x', workspaceId: 1, eventKey: 'assigned' })).rejects.toThrow(/blocked by app permission policy/);
    expect(prismaMock.teamsDelivery.create).not.toHaveBeenCalled();
  });

  test('disconnected: e-mail when the notice has one, else the usual skipped row', async () => {
    prismaMock.teamsConversation.findUnique.mockResolvedValue({ ...blockedConv, lastError: null, disconnectedAt: new Date() });
    const emailFallback = jest.fn().mockResolvedValue(true);
    expect(await svc._send(PERSON, {}, { eventKey: 'av_approval_waiting', refKey: 'k1', emailFallback })).toBeNull();
    expect(prismaMock.teamsDelivery.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ status: 'emailed', reason: 'k1' }) });
    expect(await svc._send(PERSON, {}, { eventKey: 'assigned' })).toBeNull();
    expect(prismaMock.teamsDelivery.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ status: 'skipped', reason: 'disconnected' }) });
  });

  test('an e-mail that fails too leaves the skipped row, never throws', async () => {
    prismaMock.teamsConversation.findUnique.mockResolvedValue({ ...blockedConv, lastError: null, disconnectedAt: new Date() });
    const emailFallback = jest.fn().mockRejectedValue(new Error('mail down'));
    expect(await svc._send(PERSON, {}, { eventKey: 'av_approval_waiting', refKey: 'k2', emailFallback })).toBeNull();
    expect(prismaMock.teamsDelivery.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ status: 'skipped', reason: 'disconnected' }) });
  });

  test('connected again (the admin allowed the app): no pause, the card goes', async () => {
    prismaMock.teamsConversation.findUnique.mockResolvedValue({ email: PERSON, conversationId: 'conv-1', serviceUrl: 'https://smba/', aadObjectId: 'aad-1', disconnectedAt: null });
    prismaMock.teamsDelivery.findMany.mockResolvedValue([0.5, 1, 2].map((h) => ({ status: 'failed', reason: BLOCKED, createdAt: new Date(Date.now() - h * 3600_000) })));
    expect(await svc._send(PERSON, {}, { eventKey: 'assigned', workspaceId: 1 })).toBe('act-1');
    expect(prismaMock.teamsDelivery.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'sent' }) });
  });

  test('"Send me a test" always tries, even during the pause', async () => {
    prismaMock.teamsConversation.findUnique.mockResolvedValue(blockedConv);
    prismaMock.teamsDelivery.findMany.mockResolvedValue([0.5, 1, 2].map((h) => ({ status: 'failed', reason: BLOCKED, createdAt: new Date(Date.now() - h * 3600_000) })));
    await expect(svc._send(PERSON, {}, { eventKey: 'test' })).rejects.toThrow(/blocked/);
    expect(botMock.installForUser).toHaveBeenCalled();
  });
});

describe('Settings → Teams: a status per person and a count at the top', () => {
  test('adminStatus lists each person\'s status and counts the blocked ones', async () => {
    prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue({ workspaceId: 1, teamsEnabled: true });
    prismaMock.technician.findMany.mockResolvedValue([
      { id: 1, name: 'Alex Rivera', email: 'alex.rivera@example.com' },
      { id: 2, name: 'Sam Ortiz', email: 'sam.ortiz@example.com' },
      { id: 3, name: 'Jo Park', email: 'jo.park@example.com' },
    ]);
    prismaMock.teamsConversation.findMany.mockResolvedValue([
      { email: 'alex.rivera@example.com', conversationId: null, lastError: BLOCKED },
      { email: 'sam.ortiz@example.com', conversationId: 'conv-2' },
      { email: 'jo.park@example.com', conversationId: null, disconnectedAt: new Date(), disconnectedBy: 'admin@example.com' },
    ]);
    prismaMock.teamsDelivery.groupBy.mockResolvedValue([]);
    prismaMock.teamsDelivery.findFirst.mockResolvedValue(null);
    const recent = new Date(Date.now() - 3600_000);
    prismaMock.teamsDelivery.findMany.mockResolvedValue([
      { email: 'alex.rivera@example.com', status: 'failed', reason: BLOCKED, createdAt: recent },
      { email: 'alex.rivera@example.com', status: 'failed', reason: BLOCKED, createdAt: new Date(recent - 1000) },
      { email: 'sam.ortiz@example.com', status: 'sent', reason: null, createdAt: recent },
      { email: 'jo.park@example.com', status: 'skipped', reason: 'disconnected', createdAt: recent },
    ]);
    const out = await svc.adminStatus(1);
    expect(out.health).toEqual({ blocked: 1, disconnected: 1, notConnected: 0 });
    const by = Object.fromEntries(out.agents.map((a) => [a.name, a]));
    expect(by['Alex Rivera']).toMatchObject({ status: 'blocked', missed7d: 2 });
    expect(by['Alex Rivera'].lastBlockedAt).toEqual(recent);
    expect(by['Sam Ortiz']).toMatchObject({ status: 'connected', missed7d: 0 });
    expect(by['Jo Park']).toMatchObject({ status: 'disconnected', missed7d: 1, disconnectedBySelf: false });
  });

  test('a failed read of the deliveries only loses the counts', async () => {
    prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue({ workspaceId: 1, teamsEnabled: true });
    prismaMock.technician.findMany.mockResolvedValue([{ id: 1, name: 'Alex Rivera', email: 'alex.rivera@example.com' }]);
    prismaMock.teamsConversation.findMany.mockResolvedValue([{ email: 'alex.rivera@example.com', conversationId: null, lastError: BLOCKED }]);
    prismaMock.teamsDelivery.groupBy.mockResolvedValue([]);
    prismaMock.teamsDelivery.findFirst.mockResolvedValue(null);
    prismaMock.teamsDelivery.findMany.mockRejectedValue(new Error('db busy'));
    const out = await svc.adminStatus(1);
    expect(out.agents[0]).toMatchObject({ status: 'blocked', missed7d: 0 });
    expect(out.health.blocked).toBe(1);
  });
});
