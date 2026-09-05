import { jest } from '@jest/globals';

/**
 * MB-2d — poller demotion + delta catch-up lane. A mailbox with a live Graph
 * subscription is polled only every CATCHUP_INTERVAL_MS (delta round when a
 * cursor exists); connections without one keep pollIntervalSec.
 */

const prismaMock = {
  mailboxConnection: { findMany: jest.fn(), update: jest.fn() },
  ticketThreadEntry: { findFirst: jest.fn(), create: jest.fn() },
  ticket: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  requester: { findUnique: jest.fn() },
  technician: { findMany: jest.fn() },
  notificationDelivery: { findFirst: jest.fn() },
};
const graphMock = {
  isConfigured: jest.fn(() => true),
  getInboxMessagesForIngest: jest.fn(),
  getInboxDeltaChanges: jest.fn(),
  getMessageForIngest: jest.fn(),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: graphMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: { createTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: { enqueueThreadEntry: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  default: service, hasActiveSubscription, effectivePollIntervalMs, CATCHUP_INTERVAL_MS,
} = await import('../src/services/mailboxIngestService.js');

const NOW = Date.parse('2026-09-01T12:00:00Z');
const base = { id: 1, workspaceId: 5, address: 'patickets@example.com', pollIntervalSec: 15, lastMessageAt: null, deltaLink: null };
const webhooked = {
  // The expiry must outrun the REAL clock: tick() reads Date.now(), so a fixture pinned to
  // NOW + 3 days silently expired on 2026-09-04 and the suite began failing by calendar.
  ...base, id: 2, subscriptionId: 'sub-2', notificationStatus: 'active', subscriptionExpiresAt: new Date(Math.max(NOW, Date.now()) + 3 * 24 * 3600 * 1000),
};

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.mailboxConnection.update.mockResolvedValue({});
  prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
  graphMock.getInboxMessagesForIngest.mockResolvedValue([]);
  graphMock.getInboxDeltaChanges.mockResolvedValue({ items: [], deltaLink: 'https://graph/delta?token=2' });
  jest.spyOn(service, 'ingestSingleMessage').mockResolvedValue('skipped');
});

afterEach(() => {
  service.ingestSingleMessage.mockRestore?.();
});

describe('cadence', () => {
  test('hasActiveSubscription needs id + active + unexpired', () => {
    expect(hasActiveSubscription(webhooked, NOW)).toBe(true);
    expect(hasActiveSubscription({ ...webhooked, notificationStatus: 'error' }, NOW)).toBe(false);
    expect(hasActiveSubscription({ ...webhooked, subscriptionExpiresAt: new Date(NOW - 1) }, NOW)).toBe(false);
    expect(hasActiveSubscription(base, NOW)).toBe(false);
  });

  test('effectivePollIntervalMs: catch-up interval with a live webhook, own cadence otherwise', () => {
    expect(effectivePollIntervalMs(webhooked, NOW)).toBe(CATCHUP_INTERVAL_MS);
    expect(CATCHUP_INTERVAL_MS).toBeGreaterThanOrEqual(60 * 1000);
    expect(CATCHUP_INTERVAL_MS).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(effectivePollIntervalMs(base, NOW)).toBe(15 * 1000);
    expect(effectivePollIntervalMs({ ...base, pollIntervalSec: null }, NOW)).toBe(60 * 1000);
  });

  test('tick polls the plain connection but demotes the webhooked one', async () => {
    const checkedRecently = new Date(Date.now() - 60 * 1000); // 60 s ago: due at 15 s, NOT due at 5 min
    prismaMock.mailboxConnection.findMany.mockResolvedValue([
      { ...base, lastCheckedAt: checkedRecently },
      { ...webhooked, lastCheckedAt: checkedRecently },
    ]);
    const spy = jest.spyOn(service, 'pollConnection').mockResolvedValue({});
    const out = await service.tick();
    expect(out.polled).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].id).toBe(1);
    spy.mockRestore();
  });

  test('requestCatchUp forces the webhooked connection onto the next tick', async () => {
    const checkedRecently = new Date(Date.now() - 10 * 1000);
    prismaMock.mailboxConnection.findMany.mockResolvedValue([{ ...webhooked, lastCheckedAt: checkedRecently }]);
    const spy = jest.spyOn(service, 'pollConnection').mockResolvedValue({});
    expect((await service.tick()).polled).toBe(0);
    service.requestCatchUp(2);
    expect((await service.tick()).polled).toBe(1);
    expect((await service.tick()).polled).toBe(0); // consumed
    spy.mockRestore();
  });
});

describe('delta catch-up lane', () => {
  test('with a cursor: delta round, skip removed + already-ingested, fetch the rest by id, persist the new cursor', async () => {
    const conn = { ...webhooked, deltaLink: 'https://graph/delta?token=1' };
    graphMock.getInboxDeltaChanges.mockResolvedValue({
      items: [
        { id: 'm-new', removed: false, receivedAt: new Date(NOW), internetMessageId: '<new@x>' },
        { id: 'm-seen', removed: false, receivedAt: new Date(NOW - 1000), internetMessageId: '<seen@x>' },
        { id: 'm-gone', removed: true },
      ],
      deltaLink: 'https://graph/delta?token=2',
    });
    prismaMock.ticketThreadEntry.findFirst.mockImplementation(({ where }) => Promise.resolve(where.emailMessageId === '<seen@x>' ? { id: 1 } : null));
    graphMock.getMessageForIngest.mockResolvedValue({ id: 'm-new', internetMessageId: '<new@x>', receivedAt: new Date(NOW), from: 'rita@example.com', subject: 'hi' });

    const out = await service.pollConnection(conn);
    expect(graphMock.getInboxDeltaChanges).toHaveBeenCalledWith('patickets@example.com', 'https://graph/delta?token=1');
    expect(graphMock.getInboxMessagesForIngest).not.toHaveBeenCalled();
    expect(graphMock.getMessageForIngest).toHaveBeenCalledTimes(1);
    expect(graphMock.getMessageForIngest).toHaveBeenCalledWith('patickets@example.com', 'm-new');
    expect(service.ingestSingleMessage).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ delta: true, changes: 3 });
    expect(prismaMock.mailboxConnection.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 2 },
      data: expect.objectContaining({ deltaLink: 'https://graph/delta?token=2', lastMessageAt: new Date(NOW) }),
    }));
  });

  test('a dead cursor (deltaReset) is cleared and the pass falls back to the inbox fetch', async () => {
    const conn = { ...webhooked, deltaLink: 'https://graph/delta?token=stale' };
    graphMock.getInboxDeltaChanges.mockRejectedValue(Object.assign(new Error('410 Gone'), { deltaReset: true }));
    await service.pollConnection(conn);
    expect(prismaMock.mailboxConnection.update).toHaveBeenCalledWith({ where: { id: 2 }, data: { deltaLink: null } });
    expect(graphMock.getInboxMessagesForIngest).toHaveBeenCalledTimes(1);
  });

  test('without a cursor the classic inbox fetch runs and feeds ingestSingleMessage', async () => {
    graphMock.getInboxMessagesForIngest.mockResolvedValue([
      { id: 'a', internetMessageId: '<a@x>', receivedAt: new Date(NOW), from: 'rita@example.com', subject: 's' },
    ]);
    await service.pollConnection({ ...base, lastCheckedAt: null });
    expect(graphMock.getInboxDeltaChanges).not.toHaveBeenCalled();
    expect(service.ingestSingleMessage).toHaveBeenCalledTimes(1);
  });
});
