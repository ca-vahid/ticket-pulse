import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Site stats reports. The two things that make a usage number wrong without
 * anyone noticing: adding daily counts into a weekly one (the same person is
 * counted every day), and a count with no "out of how many".
 */
const prismaMock = {
  workspace: { findMany: jest.fn() },
  workspaceAccess: { findMany: jest.fn() },
  technician: { findMany: jest.fn() },
  usageDailyUser: { findMany: jest.fn(), findFirst: jest.fn() },
  usageDailyUserItem: { groupBy: jest.fn() },
  usagePerson: { findMany: jest.fn() },
  usageSignIn: { findMany: jest.fn() },
  usageStatsView: { create: jest.fn() },
};
const settingsRepository = { get: jest.fn() };
const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepository }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: logger }));

const report = await import('../src/services/usageReportService.js');
const { default: siteStatsRoutes } = await import('../src/routes/siteStats.routes.js');

const NOW = new Date('2026-10-08T18:00:00.000Z'); // Thursday 8 Oct, 11:00 Pacific
const day = (d) => new Date(`${d}T00:00:00.000Z`);
const row = (d, email, over = {}) => ({ day: day(d), email, visits: 1, engagedSeconds: 600, openSeconds: 1200, pageViews: 5, actions: 2, hoursMask: 1 << 9, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  settingsRepository.get.mockResolvedValue('vahid@x.ca');
  prismaMock.workspace.findMany.mockResolvedValue([{ id: 1, name: 'IT' }, { id: 2, name: 'Accounting' }]);
  prismaMock.workspaceAccess.findMany.mockResolvedValue([
    { email: 'Ann@x.ca', workspaceId: 1, role: 'admin' },
    { email: 'bob@x.ca', workspaceId: 1, role: 'viewer' },
    { email: 'cat@x.ca', workspaceId: 2, role: 'readonly' },
    { email: 'gone@x.ca', workspaceId: 99, role: 'viewer' }, // inactive workspace
  ]);
  prismaMock.technician.findMany.mockResolvedValue([
    { email: 'bob@x.ca', name: 'Bob B', workspaceId: 1 },
    { email: 'dan@x.ca', name: 'Dan D', workspaceId: 1 },
  ]);
  prismaMock.usageDailyUser.findMany.mockResolvedValue([
    row('2026-10-08', 'ann@x.ca'),
    row('2026-10-07', 'ann@x.ca'),
    row('2026-10-06', 'ann@x.ca'),
    row('2026-10-07', 'bob@x.ca'),
    row('2026-09-10', 'dan@x.ca'), // four weeks ago, nothing since
  ]);
  prismaMock.usageDailyUser.findFirst.mockResolvedValue({ day: day('2026-09-10') });
  prismaMock.usageDailyUserItem.groupBy.mockResolvedValue([]);
  prismaMock.usagePerson.findMany.mockResolvedValue([
    { email: 'ann@x.ca', name: 'Ann A', firstSeenAt: new Date('2026-10-06T16:00:00Z'), lastSeenAt: new Date('2026-10-08T17:00:00Z'), lastSignInAt: new Date('2026-10-06T16:00:00Z'), signInCount: 1, browser: 'Edge', device: 'desktop', viewport: 'laptop' },
    { email: 'bob@x.ca', name: 'Bob B', firstSeenAt: new Date('2026-08-01T16:00:00Z'), lastSeenAt: new Date('2026-10-07T17:00:00Z'), lastSignInAt: null, signInCount: 0, browser: 'Chrome', device: 'desktop', viewport: 'wide' },
    { email: 'dan@x.ca', name: 'Dan D', firstSeenAt: new Date('2026-08-01T16:00:00Z'), lastSeenAt: new Date('2026-09-10T17:00:00Z'), lastSignInAt: null, signInCount: 0, browser: 'Chrome', device: 'phone', viewport: 'phone' },
  ]);
  prismaMock.usageSignIn.findMany.mockResolvedValue([{ at: new Date('2026-10-06T16:05:00Z'), outcome: 'success' }]);
  prismaMock.usageStatsView.create.mockResolvedValue({});
});

describe('loadRoster', () => {
  test('access rows, technicians and super admins become one list keyed by lower-case e-mail', async () => {
    const { roster } = await report.loadRoster();
    const byEmail = Object.fromEntries(roster.map((p) => [p.email, p]));
    expect(Object.keys(byEmail).sort()).toEqual(['ann@x.ca', 'bob@x.ca', 'cat@x.ca', 'dan@x.ca', 'vahid@x.ca']);
    expect(byEmail['ann@x.ca'].role).toBe('admin');
    expect(byEmail['bob@x.ca']).toMatchObject({ role: 'standard', name: 'Bob B' });
    expect(byEmail['cat@x.ca'].role).toBe('read-only');
    expect(byEmail['dan@x.ca'].role).toBe('agent');
    expect(byEmail['vahid@x.ca'].role).toBe('super admin');
  });

  test('never reads a photo', async () => {
    await report.loadRoster();
    expect(prismaMock.technician.findMany.mock.calls[0][0].select).toEqual({ email: true, name: true, workspaceId: true });
  });
});

describe('overview', () => {
  test('a person active on three days is one person, not three', async () => {
    const data = await report.overview({ days: 7, now: NOW });
    expect(data.active.week.active).toBe(2); // ann + bob
    expect(data.active.today.active).toBe(1);
    expect(data.active.range).toBe(2);
    expect(data.peopleWithAccess).toBe(5);
    expect(data.series).toHaveLength(7);
    expect(data.series.find((d) => d.day === '2026-10-07').active).toBe(2);
  });

  test('weekend days are marked so the chart can leave them out', async () => {
    const data = await report.overview({ days: 7, now: NOW });
    expect(data.series.filter((d) => !d.weekday).map((d) => d.day)).toEqual(['2026-10-03', '2026-10-04']);
  });

  test('new, gone quiet and never seen', async () => {
    const data = await report.overview({ days: 7, now: NOW });
    expect(data.lists.newPeople.map((p) => p.email)).toEqual(['ann@x.ca']);
    expect(data.lists.quiet.map((p) => p.email)).toEqual(['dan@x.ca']);
    expect(data.lists.never.map((p) => p.email).sort()).toEqual(['cat@x.ca', 'vahid@x.ca']);
  });

  test('by role says how many people each count is out of', async () => {
    const data = await report.overview({ days: 7, now: NOW });
    expect(data.byRole).toEqual([
      { role: 'super admin', people: 1, active: 0 },
      { role: 'admin', people: 1, active: 1 },
      { role: 'standard', people: 1, active: 1 },
      { role: 'read-only', people: 1, active: 0 },
      { role: 'agent', people: 1, active: 0 },
    ]);
  });

  test('hours grid counts person-days in Pacific hours; sign-ins by Pacific hour', async () => {
    const data = await report.overview({ days: 7, now: NOW });
    expect(data.hours[3][9]).toBe(2); // Wednesday the 7th, 9 am: ann and bob
    expect(data.hours[4][9]).toBe(1); // Thursday
    expect(data.signInHours[9]).toBe(1); // 16:05 UTC = 9:05 Pacific
    expect(data.totals.signIns).toBe(1);
  });

  test('the range is clamped to one year and defaults to 28 days', async () => {
    expect((await report.overview({ days: 99999, now: NOW })).days).toBe(365);
    expect((await report.overview({ now: NOW })).days).toBe(28);
  });

  test('a workspace filter keeps only person-days with activity in that workspace', async () => {
    prismaMock.usageDailyUserItem.groupBy.mockResolvedValue([{ day: day('2026-10-07'), email: 'bob@x.ca', workspaceId: 1 }]);
    const data = await report.overview({ days: 7, workspaceId: 1, now: NOW });
    expect(data.active.range).toBe(1);
    // IT: ann, bob, dan, plus the super admin who can open every workspace.
    expect(data.peopleWithAccess).toBe(4);
  });
});

describe('peopleReport', () => {
  test('most recently seen first, never seen last; no ordering by time spent', async () => {
    const { people } = await report.peopleReport({ now: NOW });
    expect(people.map((p) => p.email)).toEqual(['ann@x.ca', 'bob@x.ca', 'dan@x.ca', 'cat@x.ca', 'vahid@x.ca']);
    const ann = people[0];
    expect(ann).toMatchObject({ activeDays: 3, visitsPerDay: 1, openMinutesPerDay: 20, engagedMinutesPerDay: 10, hasAccess: true });
    expect(ann.weeks[11]).toBe(3);
    expect(ann.hourCounts[9]).toBe(3);
    expect(people[3]).toMatchObject({ lastSeenAt: null, activeDays: 0 });
  });
});

describe('itemsReport', () => {
  test('people are distinct per page across the range; actions get their names', async () => {
    prismaMock.usageDailyUserItem.groupBy.mockResolvedValue([
      { kind: 'page', key: 'tickets.list', section: '', email: 'ann@x.ca', _sum: { count: 10, engagedSeconds: 600, openSeconds: 1800 } },
      { kind: 'page', key: 'tickets.list', section: '', email: 'bob@x.ca', _sum: { count: 2, engagedSeconds: 60, openSeconds: 120 } },
      { kind: 'page', key: 'settings', section: 'site-stats', email: 'ann@x.ca', _sum: { count: 1, engagedSeconds: 30, openSeconds: 60 } },
      { kind: 'action', key: 'POST /api/tickets/:id/replies', section: '', email: 'bob@x.ca', _sum: { count: 4, engagedSeconds: 0, openSeconds: 0 } },
    ]);
    const data = await report.itemsReport({ days: 28, now: NOW });
    expect(data.pages[0]).toMatchObject({ key: 'tickets.list', people: 2, count: 12, openMinutes: 32, engagedMinutes: 11 });
    expect(data.pages[1]).toMatchObject({ key: 'settings', section: 'site-stats', people: 1 });
    expect(data.actions).toEqual([expect.objectContaining({ label: 'Reply to a ticket', people: 1, count: 4 })]);
  });
});

describe('routes', () => {
  function app(user) {
    const a = express();
    a.use((req, _res, next) => { req.user = user; next(); });
    a.use('/api/site-stats', siteStatsRoutes);
    a.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, code: err.code }));
    return a;
  }

  test.each(['/overview', '/people', '/items'])('%s refuses a workspace admin with 403', async (path) => {
    const res = await request(app({ email: 'ann@x.ca', role: 'viewer' })).get(`/api/site-stats${path}`);
    expect(res.status).toBe(403);
    expect(prismaMock.usagePerson.findMany).not.toHaveBeenCalled();
  });

  test('a super admin gets the report and the view is logged with their e-mail', async () => {
    const res = await request(app({ email: 'Vahid@x.ca', role: 'admin' })).get('/api/site-stats/overview?days=7');
    expect(res.status).toBe(200);
    expect(res.body.data.days).toBe(7);
    await new Promise((resolve) => setImmediate(resolve));
    expect(prismaMock.usageStatsView.create).toHaveBeenCalledWith({ data: { viewerEmail: 'vahid@x.ca', view: 'overview' } });
  });
});
