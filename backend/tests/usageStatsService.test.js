import { jest } from '@jest/globals';
import { EventEmitter } from 'events';

/**
 * Site stats collection (Settings -> Site stats, 8 Oct 2026). The rules that
 * decide whether the numbers can be trusted: a silent token renewal is not a
 * sign-in, a re-sent page view is not a second view, a request that changed
 * nothing is not an action, and no URL or token ever reaches the tables.
 */
const prismaMock = {
  usageEvent: { findMany: jest.fn(), createMany: jest.fn(), update: jest.fn(), deleteMany: jest.fn() },
  usagePerson: { findMany: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
  usageSignIn: { create: jest.fn(), deleteMany: jest.fn() },
  usageDailyUser: { deleteMany: jest.fn(), createMany: jest.fn() },
  usageDailyUserItem: { deleteMany: jest.fn(), createMany: jest.fn() },
  usageStatsView: { deleteMany: jest.fn() },
  $transaction: jest.fn(),
};
const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: logger }));

const svc = await import('../src/services/usageStatsService.js');
const { actionKeyFor, actionLabel } = await import('../src/services/usageCatalog.js');

const NOW = Date.parse('2026-10-08T18:00:00.000Z'); // 11:00 Pacific
const USER = { email: 'Susan.Xu@BGCEngineering.ca', name: 'Susan Xu' };
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const VISIT = '99999999-9999-4999-8999-999999999999';
const page = (over = {}) => ({ id: ID1, t: NOW - 30000, kind: 'page', key: 'tickets.detail', section: '', ws: 1, eng: 20, open: 30, ...over });
const batch = (events, over = {}) => ({ sentAt: NOW, visitId: VISIT, appVersion: '4.2.26-preview', viewport: 'laptop', events, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  svc.internals.reset();
  svc.setEnabledForTests(true);
  prismaMock.usageEvent.findMany.mockResolvedValue([]);
  prismaMock.usagePerson.findMany.mockResolvedValue([]);
  for (const model of ['usageEvent', 'usagePerson', 'usageSignIn', 'usageDailyUser', 'usageDailyUserItem']) {
    for (const fn of Object.values(prismaMock[model])) if (fn !== prismaMock[model].findMany) fn.mockImplementation((args) => ({ args }));
  }
  prismaMock.$transaction.mockResolvedValue([]);
});
afterAll(() => svc.setEnabledForTests(null));

describe('acceptBatch', () => {
  test('stores the page name, the person in lower case and the seconds', () => {
    expect(svc.acceptBatch(USER, batch([page()]), { userAgent: 'Mozilla/5.0 Chrome/141.0 Safari/537.36', now: NOW })).toBe(1);
    expect(svc.internals.buffered()[0]).toMatchObject({
      eventUuid: ID1, email: 'susan.xu@bgcengineering.ca', kind: 'page', key: 'tickets.detail', workspaceId: 1,
      visitId: VISIT, engagedSeconds: 20, openSeconds: 30, browser: 'Chrome', device: 'desktop', viewport: 'laptop',
    });
  });

  test('rejects anything that is not a page name: URLs, ids, tokens, unknown UI events', () => {
    const bad = [
      page({ key: '/tickets/245830' }),
      page({ key: 'tickets.detail?peek=1' }),
      page({ key: 'Approval/AbC123tokenXYZ' }),
      page({ section: 'a b<script>' }),
      page({ id: 'not-a-uuid' }),
      page({ kind: 'action' }),
      { id: ID2, t: NOW, kind: 'ui', key: 'anything.else' },
    ];
    expect(svc.acceptBatch(USER, batch(bad), { now: NOW })).toBe(0);
    expect(svc.internals.buffered()).toHaveLength(0);
  });

  test('a known UI event is accepted without time counters', () => {
    svc.acceptBatch(USER, batch([{ id: ID2, t: NOW, kind: 'ui', key: 'palette.open', eng: 500 }]), { now: NOW });
    expect(svc.internals.buffered()[0]).toMatchObject({ kind: 'ui', key: 'palette.open', engagedSeconds: 0 });
  });

  test('nobody signed in, or collection switched off: nothing is kept', () => {
    expect(svc.acceptBatch(null, batch([page()]), { now: NOW })).toBe(0);
    svc.setEnabledForTests(false);
    expect(svc.acceptBatch(USER, batch([page()]), { now: NOW })).toBe(0);
  });

  test('a browser clock two hours fast is corrected by the send time', () => {
    const skew = 2 * 3600 * 1000;
    svc.acceptBatch(USER, batch([page({ t: NOW + skew - 30000 })], { sentAt: NOW + skew }), { now: NOW });
    expect(svc.internals.buffered()[0].occurredAt.getTime()).toBe(NOW - 30000);
  });

  test('events older than a day are dropped; time counters are capped at a day', () => {
    svc.acceptBatch(USER, batch([page({ t: NOW - 25 * 3600 * 1000 }), page({ id: ID2, open: 9e9 })]), { now: NOW });
    const kept = svc.internals.buffered();
    expect(kept).toHaveLength(1);
    expect(kept[0].openSeconds).toBe(86400);
  });

  test('at most 100 events from one batch', () => {
    const many = Array.from({ length: 150 }, (_, i) => page({ id: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111` }));
    expect(svc.acceptBatch(USER, batch(many), { now: NOW })).toBe(100);
  });
});

describe('flush', () => {
  test('one transaction: new events are inserted and the person is upserted', async () => {
    svc.acceptBatch(USER, batch([page()]), { now: NOW });
    await svc.flush();
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    const created = prismaMock.usageEvent.createMany.mock.calls[0][0];
    expect(created.skipDuplicates).toBe(true);
    expect(created.data).toEqual([expect.objectContaining({ eventUuid: ID1, email: 'susan.xu@bgcengineering.ca', key: 'tickets.detail' })]);
    expect(created.data[0]).not.toHaveProperty('browser');
    expect(prismaMock.usagePerson.upsert.mock.calls[0][0]).toMatchObject({
      where: { email: 'susan.xu@bgcengineering.ca' },
      create: { name: 'Susan Xu', browser: 'Other', viewport: 'laptop' },
    });
    expect(svc.internals.buffered()).toHaveLength(0);
    expect(svc.internals.dirtyDays()).toEqual(['2026-10-08']);
  });

  test('the same page view sent again keeps the larger counters and stays one row', async () => {
    svc.acceptBatch(USER, batch([page({ eng: 20, open: 30 })]), { now: NOW });
    svc.acceptBatch(USER, batch([page({ eng: 50, open: 90 })]), { now: NOW });
    prismaMock.usageEvent.findMany.mockResolvedValue([{ eventUuid: ID1, engagedSeconds: 40, openSeconds: 60 }]);
    await svc.flush();
    expect(prismaMock.usageEvent.createMany).not.toHaveBeenCalled();
    expect(prismaMock.usageEvent.update).toHaveBeenCalledWith({ where: { eventUuid: ID1 }, data: { engagedSeconds: 50, openSeconds: 90 } });
  });

  test('a re-send with nothing new writes no event row', async () => {
    svc.acceptBatch(USER, batch([page({ eng: 20, open: 30 })]), { now: NOW });
    prismaMock.usageEvent.findMany.mockResolvedValue([{ eventUuid: ID1, engagedSeconds: 20, openSeconds: 30 }]);
    await svc.flush();
    expect(prismaMock.usageEvent.createMany).not.toHaveBeenCalled();
    expect(prismaMock.usageEvent.update).not.toHaveBeenCalled();
  });

  test('last seen never moves backwards', async () => {
    const later = new Date(NOW + 3600 * 1000);
    prismaMock.usagePerson.findMany.mockResolvedValue([{ email: 'susan.xu@bgcengineering.ca', lastSeenAt: later }]);
    svc.acceptBatch(USER, batch([page()]), { now: NOW });
    await svc.flush();
    expect(prismaMock.usagePerson.upsert.mock.calls[0][0].update.lastSeenAt).toBe(later);
  });

  test('a failed write is retried once, then dropped, and never throws', async () => {
    svc.acceptBatch(USER, batch([page()]), { now: NOW });
    prismaMock.$transaction.mockRejectedValue(new Error('pool timeout'));
    await expect(svc.flush()).resolves.toBe(0);
    expect(svc.internals.buffered()).toHaveLength(1);
    await expect(svc.flush()).resolves.toBe(0);
    expect(svc.internals.buffered()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  test('the buffer is capped: the oldest events go first', () => {
    for (let i = 0; i < svc.BUFFER_CAP + 5; i += 1) {
      prismaMock.usageEvent.findMany.mockReturnValue(new Promise(() => {})); // a flush that never finishes
      svc.acceptBatch(USER, batch([page({ id: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111` })]), { now: NOW });
    }
    expect(svc.internals.buffered().length).toBeLessThanOrEqual(svc.BUFFER_CAP);
  });
});

describe('usageActionCapture', () => {
  function run({ method = 'POST', route = { path: '/:id/replies' }, baseUrl = '/api/tickets', status = 200, user = USER, headers = { 'x-workspace-id': '2' } } = {}) {
    const req = { method, route, baseUrl, headers, user };
    const res = new EventEmitter();
    res.statusCode = status;
    const next = jest.fn();
    svc.usageActionCapture()(req, res, next);
    expect(next).toHaveBeenCalled();
    res.emit('finish');
    return svc.internals.buffered();
  }

  test('a successful write is one action, keyed by the route pattern', () => {
    const [event] = run();
    expect(event).toMatchObject({ kind: 'action', key: 'POST /api/tickets/:id/replies', email: 'susan.xu@bgcengineering.ca', workspaceId: 2 });
    expect(actionLabel(event.key)).toBe('Reply to a ticket');
  });

  test('the session identity wins over the Bearer identity', () => {
    const req = { method: 'POST', route: { path: '/:id/assign' }, baseUrl: '/api/tickets', headers: {}, user: { email: 'jwt@x.ca' }, session: { user: { email: 'cookie@x.ca', selectedWorkspaceId: 5 } } };
    const res = new EventEmitter();
    res.statusCode = 200;
    svc.usageActionCapture()(req, res, () => {});
    res.emit('finish');
    expect(svc.internals.buffered()[0]).toMatchObject({ email: 'cookie@x.ca', workspaceId: 5 });
  });

  test.each([
    ['a failed request', { status: 403 }],
    ['a plain page load', { method: 'GET', route: { path: '/:id' } }],
    ['a saved preference', { method: 'PUT', route: { path: '/preferences/:key' } }],
    ['a presence ping', { route: { path: '/:id/presence' } }],
    ['the stats intake itself', { baseUrl: '/api/usage', route: { path: '/batch' } }],
    ['sign-in', { baseUrl: '/api/auth', route: { path: '/sso' } }],
    ['an unmatched route', { route: null }],
    ['nobody signed in', { user: null }],
  ])('%s is not an action', (_name, over) => {
    expect(run(over)).toHaveLength(0);
  });

  test('search is the one read that counts', () => {
    expect(actionKeyFor('GET', '/api/search/')).toBe('GET /api/search/');
    expect(actionKeyFor('GET', '/api/tickets/')).toBeNull();
  });
});

describe('recordSignIn', () => {
  const signIn = (over = {}) => svc.recordSignIn({ email: USER.email, name: USER.name, userAgent: 'Mozilla/5.0 (iPhone) Mobile Safari/604.1', now: NOW, ...over });

  test('a real sign-in is written with the person', async () => {
    await expect(signIn()).resolves.toBe(true);
    expect(prismaMock.usageSignIn.create.mock.calls[0][0].data).toMatchObject({
      email: 'susan.xu@bgcengineering.ca', method: 'sso', outcome: 'success', browser: 'Safari', device: 'phone',
    });
    expect(prismaMock.usagePerson.upsert.mock.calls[0][0].update).toMatchObject({ signInCount: { increment: 1 } });
  });

  test('a silent renewal (a live session already exists) is not a sign-in', async () => {
    await expect(signIn({ hadSession: true })).resolves.toBe(false);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  test('several tabs exchanging tokens at once count once', async () => {
    await signIn();
    await expect(signIn({ now: NOW + 60 * 1000 })).resolves.toBe(false);
    await expect(signIn({ now: NOW + svc.SIGN_IN_DEDUPE_MS + 1 })).resolves.toBe(true);
    expect(prismaMock.usageSignIn.create).toHaveBeenCalledTimes(2);
  });

  test('a Microsoft account with no access here is recorded as such', async () => {
    await signIn({ hasAccess: false });
    expect(prismaMock.usageSignIn.create.mock.calls[0][0].data.outcome).toBe('no_access');
  });

  test('a database error never reaches the sign-in route', async () => {
    prismaMock.$transaction.mockRejectedValue(new Error('down'));
    await expect(signIn()).resolves.toBe(false);
  });
});

describe('summariseDay', () => {
  const at = (iso) => new Date(iso);
  const ev = (over = {}) => ({ email: 'a@x.ca', workspaceId: 1, visitId: 'v1', kind: 'page', key: 'tickets.list', section: '', engagedSeconds: 10, openSeconds: 20, occurredAt: at('2026-10-08T16:00:00Z'), ...over });

  test('buckets by Pacific day, not UTC day', () => {
    const events = [
      ev({ occurredAt: at('2026-10-08T06:30:00Z') }), // 23:30 on the 7th, Pacific
      ev({ occurredAt: at('2026-10-08T07:30:00Z') }), // 00:30 on the 8th
      ev({ occurredAt: at('2026-10-09T06:59:00Z') }), // 23:59 on the 8th
      ev({ occurredAt: at('2026-10-09T07:01:00Z') }), // the 9th
    ];
    const { users } = svc.summariseDay('2026-10-08', events);
    expect(users).toHaveLength(1);
    expect(users[0].pageViews).toBe(2);
    expect(users[0].hoursMask).toBe((1 << 0) | (1 << 23));
    expect(users[0].day.toISOString()).toBe('2026-10-08T00:00:00.000Z');
  });

  test('one row per person; visits are distinct visit ids; pages and actions are separate', () => {
    const events = [
      ev(),
      ev({ visitId: 'v1', key: 'tickets.detail' }),
      ev({ visitId: 'v2', occurredAt: at('2026-10-08T20:00:00Z') }),
      ev({ kind: 'action', key: 'POST /api/tickets/:id/replies', visitId: null, engagedSeconds: 0, openSeconds: 0 }),
      ev({ email: 'b@x.ca', visitId: null, kind: 'action', key: 'POST /api/tickets/:id/assign', engagedSeconds: 0, openSeconds: 0 }),
    ];
    const { users, items } = svc.summariseDay('2026-10-08', events);
    const a = users.find((u) => u.email === 'a@x.ca');
    expect(a).toMatchObject({ visits: 2, pageViews: 3, actions: 1, engagedSeconds: 30, openSeconds: 60 });
    // Actions with the tracker blocked still make an active day with one visit.
    expect(users.find((u) => u.email === 'b@x.ca')).toMatchObject({ visits: 1, pageViews: 0, actions: 1 });
    expect(items.find((i) => i.email === 'a@x.ca' && i.key === 'tickets.list')).toMatchObject({ count: 2, openSeconds: 40, workspaceId: 1 });
    expect(items).toHaveLength(4);
  });
});

describe('rollupDay and prune', () => {
  test('rebuilds the day in one transaction: delete, then insert', async () => {
    prismaMock.usageEvent.findMany.mockResolvedValue([
      { email: 'a@x.ca', workspaceId: 1, visitId: 'v1', kind: 'page', key: 'dashboard', section: '', engagedSeconds: 5, openSeconds: 9, occurredAt: new Date('2026-10-08T17:00:00Z') },
    ]);
    const result = await svc.rollupDay('2026-10-08');
    expect(result).toEqual({ day: '2026-10-08', people: 1, items: 1 });
    const where = prismaMock.usageEvent.findMany.mock.calls[0][0].where.occurredAt;
    expect(where.gte.toISOString()).toBe('2026-10-08T00:00:00.000Z');
    expect(where.lt.toISOString()).toBe('2026-10-10T00:00:00.000Z');
    expect(prismaMock.usageDailyUser.deleteMany).toHaveBeenCalledWith({ where: { day: new Date('2026-10-08T00:00:00.000Z') } });
    expect(prismaMock.$transaction.mock.calls[0][0]).toHaveLength(4);
  });

  test('an empty day only deletes', async () => {
    await svc.rollupDay('2026-10-08');
    expect(prismaMock.usageDailyUser.createMany).not.toHaveBeenCalled();
    expect(prismaMock.$transaction.mock.calls[0][0]).toHaveLength(2);
  });

  test('raw events go after 90 days, everything else after a year', async () => {
    await svc.prune(NOW);
    const days = (call) => Math.round((NOW - Object.values(call[0].where)[0].lt.getTime()) / 86400000);
    expect(days(prismaMock.usageEvent.deleteMany.mock.calls[0])).toBe(90);
    expect(days(prismaMock.usageDailyUser.deleteMany.mock.calls[0])).toBe(365);
    expect(days(prismaMock.usageSignIn.deleteMany.mock.calls[0])).toBe(365);
    expect(days(prismaMock.usagePerson.deleteMany.mock.calls[0])).toBe(365);
  });
});

test('collection is off under Jest unless a test turns it on', () => {
  svc.setEnabledForTests(null);
  expect(svc.isEnabled()).toBe(false);
});
