import { jest } from '@jest/globals';

/**
 * MB-2c/2d — subscription manager decisions + the notification worker.
 * Graph and Prisma are mocked; mailboxIngestService is mocked so we only
 * assert the hand-off (one ingestSingleMessage per message id).
 */

const prismaMock = {
  mailboxConnection: { findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
};
const graphMock = {
  isConfigured: jest.fn(() => true),
  createMailSubscription: jest.fn(),
  renewSubscription: jest.fn(),
  deleteSubscription: jest.fn(),
  reauthorizeSubscription: jest.fn(),
  getInboxDeltaChanges: jest.fn(),
  getMessageForIngest: jest.fn(),
};
const ingestMock = { ingestSingleMessage: jest.fn(), requestCatchUp: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({
  default: graphMock,
  graphErrorStatus: (e) => e?.statusCode || null,
}));
jest.unstable_mockModule('../src/services/mailboxIngestService.js', () => ({ default: ingestMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  default: service, decideSubscriptionAction, normalizeNotification, notificationsDisabledReason,
  notificationBaseUrl, SUBSCRIPTION_TTL_MS, RENEW_THRESHOLD_MS,
} = await import('../src/services/graphSubscriptionService.js');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-09-01T12:00:00Z');

const connection = {
  id: 7, workspaceId: 5, address: 'patickets@example.com', isEnabled: true, mode: 'both',
  subscriptionId: 'sub-7', clientState: 'cs-7', subscriptionExpiresAt: new Date(NOW + 5 * DAY),
  notificationStatus: 'active', deltaLink: 'https://graph.microsoft.com/v1.0/delta?token=1', lastMessageAt: null,
};

const notification = (over = {}) => ({
  subscriptionId: 'sub-7', clientState: 'cs-7', changeType: 'created',
  resourceData: { id: 'msg-A' }, ...over,
});

function enable() {
  process.env.GRAPH_NOTIFICATIONS_ENABLED = 'true';
  process.env.GRAPH_NOTIFICATION_BASE_URL = 'https://api.ticketpulse.example';
}

beforeEach(() => {
  jest.clearAllMocks();
  service._resetForTests();
  delete process.env.GRAPH_NOTIFICATIONS_ENABLED;
  delete process.env.GRAPH_NOTIFICATION_BASE_URL;
  delete process.env.PUBLIC_API_URL;
  prismaMock.mailboxConnection.findFirst.mockResolvedValue(connection);
  prismaMock.mailboxConnection.update.mockImplementation(({ data }) => Promise.resolve({ ...connection, ...data }));
  prismaMock.mailboxConnection.updateMany.mockResolvedValue({ count: 1 });
  graphMock.getMessageForIngest.mockResolvedValue({ id: 'msg-A', internetMessageId: '<a@x>', receivedAt: new Date(NOW), from: 'rita@example.com' });
  ingestMock.ingestSingleMessage.mockResolvedValue('reply');
  graphMock.deleteSubscription.mockResolvedValue({ deleted: true });
  graphMock.getInboxDeltaChanges.mockResolvedValue({ items: [], deltaLink: 'https://graph.microsoft.com/v1.0/delta?token=boot' });
});

describe('feature gate', () => {
  test('off by default; requires flag + https base URL', () => {
    expect(notificationsDisabledReason({}, true)).toMatch(/GRAPH_NOTIFICATIONS_ENABLED/);
    expect(notificationsDisabledReason({ GRAPH_NOTIFICATIONS_ENABLED: 'true' }, false)).toMatch(/credentials/);
    expect(notificationsDisabledReason({ GRAPH_NOTIFICATIONS_ENABLED: 'true', GRAPH_NOTIFICATION_BASE_URL: 'http://localhost:3000' }, true)).toMatch(/https/);
    expect(notificationsDisabledReason({ GRAPH_NOTIFICATIONS_ENABLED: 'true', GRAPH_NOTIFICATION_BASE_URL: 'https://api.example/' }, true)).toBeNull();
  });

  test('base URL: explicit > PUBLIC_API_URL > prod default > empty', () => {
    expect(notificationBaseUrl({ GRAPH_NOTIFICATION_BASE_URL: 'https://a.example//' })).toBe('https://a.example');
    expect(notificationBaseUrl({ PUBLIC_API_URL: 'https://b.example' })).toBe('https://b.example');
    expect(notificationBaseUrl({ NODE_ENV: 'production' })).toBe('https://api.ticketpulse.bgcsaas.com');
    expect(notificationBaseUrl({ NODE_ENV: 'development' })).toBe('');
  });

  test('ensureSubscriptions is a no-op when disabled', async () => {
    const out = await service.ensureSubscriptions(NOW);
    expect(out.skipped).toMatch(/GRAPH_NOTIFICATIONS_ENABLED/);
    expect(prismaMock.mailboxConnection.findMany).not.toHaveBeenCalled();
    expect(graphMock.createMailSubscription).not.toHaveBeenCalled();
  });
});

describe('decideSubscriptionAction (expiry math)', () => {
  test('no subscription → create', () => {
    expect(decideSubscriptionAction({ subscriptionId: null }, NOW)).toBe('create');
  });
  test('healthy (> 48 h left) → none', () => {
    expect(decideSubscriptionAction({ subscriptionId: 's', subscriptionExpiresAt: new Date(NOW + RENEW_THRESHOLD_MS + HOUR) }, NOW)).toBe('none');
  });
  test('< 48 h left → renew; exactly at threshold → none', () => {
    expect(decideSubscriptionAction({ subscriptionId: 's', subscriptionExpiresAt: new Date(NOW + RENEW_THRESHOLD_MS - 1) }, NOW)).toBe('renew');
    expect(decideSubscriptionAction({ subscriptionId: 's', subscriptionExpiresAt: new Date(NOW + RENEW_THRESHOLD_MS) }, NOW)).toBe('none');
  });
  test('expired or missing expiry → recreate', () => {
    expect(decideSubscriptionAction({ subscriptionId: 's', subscriptionExpiresAt: new Date(NOW - 1) }, NOW)).toBe('recreate');
    expect(decideSubscriptionAction({ subscriptionId: 's', subscriptionExpiresAt: null }, NOW)).toBe('recreate');
  });
  test('lifecycle flags override: recreate > renew > resync', () => {
    const healthy = { subscriptionId: 's', subscriptionExpiresAt: new Date(NOW + 5 * DAY) };
    expect(decideSubscriptionAction(healthy, NOW, 'recreate')).toBe('recreate');
    expect(decideSubscriptionAction(healthy, NOW, 'renew')).toBe('renew');
    expect(decideSubscriptionAction(healthy, NOW, 'resync')).toBe('resync');
  });
  test('TTL sits under the 10,080-minute Outlook cap', () => {
    expect(SUBSCRIPTION_TTL_MS).toBeLessThan(10080 * 60 * 1000);
  });
});

describe('ensureSubscriptions (enabled)', () => {
  beforeEach(enable);

  test('creates a subscription with both URLs, a stored clientState and ~6-day expiry, then bootstraps delta', async () => {
    const fresh = { ...connection, subscriptionId: null, subscriptionExpiresAt: null, clientState: null, notificationStatus: null, deltaLink: null };
    prismaMock.mailboxConnection.update.mockImplementation(({ data }) => Promise.resolve({ ...fresh, ...data }));
    prismaMock.mailboxConnection.findMany.mockResolvedValueOnce([fresh]).mockResolvedValueOnce([]);
    graphMock.createMailSubscription.mockResolvedValue({ id: 'sub-new', expirationDateTime: new Date(NOW + SUBSCRIPTION_TTL_MS).toISOString() });

    const out = await service.ensureSubscriptions(NOW);
    expect(out).toMatchObject({ created: 1, errors: 0, deltaBootstrapped: 1 });

    const [mailbox, opts] = graphMock.createMailSubscription.mock.calls[0];
    expect(mailbox).toBe('patickets@example.com');
    expect(opts.notificationUrl).toBe('https://api.ticketpulse.example/api/graph-notifications');
    expect(opts.lifecycleNotificationUrl).toBe('https://api.ticketpulse.example/api/graph-lifecycle');
    expect(opts.clientState).toMatch(/^[a-f0-9]{48}$/);
    expect(new Date(opts.expirationDateTime).getTime()).toBe(NOW + SUBSCRIPTION_TTL_MS);

    // clientState persisted BEFORE the Graph create (Graph may notify at once)
    const updates = prismaMock.mailboxConnection.update.mock.calls.map((c) => c[0].data);
    expect(updates[0]).toMatchObject({ clientState: opts.clientState, notificationStatus: 'renewing' });
    expect(updates[1]).toMatchObject({ subscriptionId: 'sub-new', notificationStatus: 'active' });
    expect(updates[2]).toMatchObject({ deltaLink: 'https://graph.microsoft.com/v1.0/delta?token=boot' });
    expect(graphMock.getInboxDeltaChanges).toHaveBeenCalledWith('patickets@example.com', null, expect.objectContaining({ since: expect.any(Date) }));
  });

  test('renews when < 48 h remain; a 404 on renew falls through to recreate', async () => {
    const soon = { ...connection, subscriptionExpiresAt: new Date(NOW + 20 * HOUR) };
    prismaMock.mailboxConnection.findMany.mockResolvedValueOnce([soon]).mockResolvedValueOnce([]);
    graphMock.renewSubscription.mockResolvedValue({ id: 'sub-7', expirationDateTime: new Date(NOW + SUBSCRIPTION_TTL_MS).toISOString() });
    let out = await service.ensureSubscriptions(NOW);
    expect(out).toMatchObject({ renewed: 1, created: 0, recreated: 0 });
    expect(graphMock.renewSubscription).toHaveBeenCalledWith('sub-7', new Date(NOW + SUBSCRIPTION_TTL_MS));
    expect(graphMock.createMailSubscription).not.toHaveBeenCalled();

    jest.clearAllMocks();
    prismaMock.mailboxConnection.update.mockImplementation(({ data }) => Promise.resolve({ ...soon, ...data }));
    prismaMock.mailboxConnection.findMany.mockResolvedValueOnce([soon]).mockResolvedValueOnce([]);
    graphMock.renewSubscription.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    graphMock.deleteSubscription.mockResolvedValue({ deleted: false, missing: true });
    graphMock.createMailSubscription.mockResolvedValue({ id: 'sub-8', expirationDateTime: new Date(NOW + SUBSCRIPTION_TTL_MS).toISOString() });
    out = await service.ensureSubscriptions(NOW);
    expect(out).toMatchObject({ renewed: 1, errors: 0 });
    expect(graphMock.createMailSubscription).toHaveBeenCalledTimes(1);
  });

  test('healthy subscription with a cursor is left alone', async () => {
    prismaMock.mailboxConnection.findMany.mockResolvedValueOnce([connection]).mockResolvedValueOnce([]);
    const out = await service.ensureSubscriptions(NOW);
    expect(out).toMatchObject({ unchanged: 1, created: 0, renewed: 0 });
    expect(graphMock.createMailSubscription).not.toHaveBeenCalled();
    expect(graphMock.renewSubscription).not.toHaveBeenCalled();
    expect(graphMock.getInboxDeltaChanges).not.toHaveBeenCalled();
  });

  test('a Graph failure marks the row error and does not stop the walk', async () => {
    const fresh = { ...connection, id: 8, address: 'b@example.com', subscriptionId: null, subscriptionExpiresAt: null };
    prismaMock.mailboxConnection.findMany.mockResolvedValueOnce([fresh, connection]).mockResolvedValueOnce([]);
    graphMock.createMailSubscription.mockRejectedValue(new Error('Forbidden'));
    const out = await service.ensureSubscriptions(NOW);
    expect(out).toMatchObject({ errors: 1, unchanged: 1 });
    expect(prismaMock.mailboxConnection.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 8 }, data: { notificationStatus: 'error' },
    }));
  });

  test('releases the subscription of a connection that is no longer ingest-eligible', async () => {
    prismaMock.mailboxConnection.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...connection, isEnabled: false }]);
    const out = await service.ensureSubscriptions(NOW);
    expect(out.released).toBe(1);
    expect(graphMock.deleteSubscription).toHaveBeenCalledWith('sub-7');
    expect(prismaMock.mailboxConnection.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ subscriptionId: null, clientState: null, notificationStatus: 'disabled' }),
    }));
  });
});

describe('notification queue + worker', () => {
  test('enqueue is synchronous and touches neither Graph nor the DB before returning', () => {
    const result = service.enqueueNotifications([notification()]);
    expect(result).toEqual({ queued: 1, duplicates: 0, invalid: 0, dropped: 0 });
    expect(graphMock.getMessageForIngest).not.toHaveBeenCalled();
    expect(prismaMock.mailboxConnection.findFirst).not.toHaveBeenCalled();
    expect(service.queueSize()).toBe(1);
  });

  test('drain fetches by id once per message and hands it to ingestSingleMessage — duplicates collapse', async () => {
    service.enqueueNotifications([notification(), notification(), notification({ resourceData: { id: 'msg-B' } })]);
    // retry from Graph a moment later, still queued → duplicate
    const retry = service.enqueueNotifications([notification()]);
    expect(retry.duplicates).toBe(1);

    await service.drain();
    expect(graphMock.getMessageForIngest).toHaveBeenCalledTimes(2);
    expect(graphMock.getMessageForIngest).toHaveBeenCalledWith('patickets@example.com', 'msg-A');
    expect(graphMock.getMessageForIngest).toHaveBeenCalledWith('patickets@example.com', 'msg-B');
    expect(ingestMock.ingestSingleMessage).toHaveBeenCalledTimes(2);
    expect(ingestMock.ingestSingleMessage.mock.calls[0][0]).toMatchObject({ id: 7, address: 'patickets@example.com' });
    // the per-sender create cap map is shared across notifications (rolling window), not per call
    expect(ingestMock.ingestSingleMessage.mock.calls[0][2]).toBeInstanceOf(Map);
    expect(ingestMock.ingestSingleMessage.mock.calls[1][2]).toBe(ingestMock.ingestSingleMessage.mock.calls[0][2]);
    // lastNotificationAt + lastMessageAt advanced
    expect(prismaMock.mailboxConnection.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 7 }, data: { lastNotificationAt: expect.any(Date) },
    }));
    expect(prismaMock.mailboxConnection.updateMany).toHaveBeenCalled();
    expect(service.queueSize()).toBe(0);
  });

  test('clientState mismatch is ignored (no fetch, no ingest)', async () => {
    service.enqueueNotifications([notification({ clientState: 'forged' })]);
    await service.drain();
    expect(graphMock.getMessageForIngest).not.toHaveBeenCalled();
    expect(ingestMock.ingestSingleMessage).not.toHaveBeenCalled();
    expect(service.getStats().rejectedClientState).toBe(1);
  });

  test('unknown subscription is ignored', async () => {
    prismaMock.mailboxConnection.findFirst.mockResolvedValue(null);
    service.enqueueNotifications([notification({ subscriptionId: 'sub-zzz' })]);
    await service.drain();
    expect(ingestMock.ingestSingleMessage).not.toHaveBeenCalled();
    expect(service.getStats().unknownSubscription).toBe(1);
  });

  test('message already gone (404 → null) is a no-op; a Graph error requests poller catch-up', async () => {
    graphMock.getMessageForIngest.mockResolvedValueOnce(null);
    service.enqueueNotifications([notification()]);
    await service.drain();
    expect(ingestMock.ingestSingleMessage).not.toHaveBeenCalled();

    graphMock.getMessageForIngest.mockRejectedValueOnce(new Error('503'));
    service.enqueueNotifications([notification({ resourceData: { id: 'msg-C' } })]);
    await service.drain();
    expect(ingestMock.requestCatchUp).toHaveBeenCalledWith(7);
    expect(service.queueSize()).toBe(0);
  });

  test('normalizeNotification falls back to parsing the resource path', () => {
    expect(normalizeNotification({ subscriptionId: 's', clientState: 'c', resource: 'Users/u1/Messages/AAMk=' }))
      .toMatchObject({ resourceMessageId: 'AAMk=', changeType: 'created' });
    expect(normalizeNotification({ subscriptionId: 's', clientState: 'c', resource: "Users('u')/Messages('AAMk=')" }))
      .toMatchObject({ resourceMessageId: 'AAMk=' });
    expect(normalizeNotification({ subscriptionId: 's' })).toBeNull();
    expect(normalizeNotification(null)).toBeNull();
  });
});

describe('lifecycle events', () => {
  beforeEach(enable);

  test('reauthorizationRequired → pending renew + status renewing', async () => {
    const handled = await service.handleLifecycleEvents([{ subscriptionId: 'sub-7', clientState: 'cs-7', lifecycleEvent: 'reauthorizationRequired' }]);
    expect(handled).toEqual([{ connectionId: 7, event: 'reauthorizationRequired' }]);
    expect(service.pendingActionFor('sub-7')).toBe('renew');
    expect(prismaMock.mailboxConnection.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { notificationStatus: 'renewing' } });
    expect(decideSubscriptionAction(connection, NOW, service.pendingActionFor('sub-7'))).toBe('renew');
  });

  test('subscriptionRemoved → pending recreate + poller catch-up', async () => {
    await service.handleLifecycleEvents([{ subscriptionId: 'sub-7', clientState: 'cs-7', lifecycleEvent: 'subscriptionRemoved' }]);
    expect(service.pendingActionFor('sub-7')).toBe('recreate');
    expect(ingestMock.requestCatchUp).toHaveBeenCalledWith(7);
    expect(decideSubscriptionAction(connection, NOW, service.pendingActionFor('sub-7'))).toBe('recreate');
  });

  test('missed → pending resync + poller catch-up (subscription untouched)', async () => {
    await service.handleLifecycleEvents([{ subscriptionId: 'sub-7', clientState: 'cs-7', lifecycleEvent: 'missed' }]);
    expect(service.pendingActionFor('sub-7')).toBe('resync');
    expect(ingestMock.requestCatchUp).toHaveBeenCalledWith(7);
    expect(prismaMock.mailboxConnection.update).not.toHaveBeenCalled();
  });

  test('clientState mismatch on a lifecycle event is rejected', async () => {
    const handled = await service.handleLifecycleEvents([{ subscriptionId: 'sub-7', clientState: 'nope', lifecycleEvent: 'subscriptionRemoved' }]);
    expect(handled).toEqual([]);
    expect(service.pendingActionFor('sub-7')).toBeNull();
    expect(ingestMock.requestCatchUp).not.toHaveBeenCalled();
  });

  test('the pending flag is consumed by the next ensure pass (renew path)', async () => {
    await service.handleLifecycleEvents([{ subscriptionId: 'sub-7', clientState: 'cs-7', lifecycleEvent: 'reauthorizationRequired' }]);
    prismaMock.mailboxConnection.findMany.mockResolvedValueOnce([connection]).mockResolvedValueOnce([]);
    graphMock.renewSubscription.mockResolvedValue({ id: 'sub-7', expirationDateTime: new Date(NOW + SUBSCRIPTION_TTL_MS).toISOString() });
    const out = await service.ensureSubscriptions(NOW);
    expect(out.renewed).toBe(1);
    expect(service.pendingActionFor('sub-7')).toBeNull();
  });
});
