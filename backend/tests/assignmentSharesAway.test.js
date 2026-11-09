import { jest } from '@jest/globals';

/**
 * Ticket shares report — days away per person (QA 11-06 #4): in the report
 * window and the next 14 days, working days only, from the same approved
 * leave rows as "Out now". Invented people: Alex (50), Sam (20), Jo (20), Kit (10).
 */
const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { findUnique: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  ticketLink: { findMany: jest.fn() },
  technician: { findMany: jest.fn() },
  technicianLeave: { findMany: jest.fn() },
  ticketAssignmentEpisode: { findMany: jest.fn() },
  competencyCategory: { findMany: jest.fn() },
  $queryRaw: jest.fn(),
};
const store = new Map();
const settingsRepositoryMock = {
  get: jest.fn(async (key) => (store.has(key) ? store.get(key) : null)),
  set: jest.fn(async (key, value) => { store.set(key, value); }),
};
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
// Business hours Mon–Fri; 11 Nov is a (recurring) holiday.
const calendarMock = {
  loadCalendar: jest.fn(async () => ({
    timezone: 'America/Vancouver',
    byDay: new Map([1, 2, 3, 4, 5].map((d) => [d, { dayOfWeek: d, endTime: '17:00' }])),
    isHolidayDate: (d) => d.slice(5) === '11-11',
  })),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepositoryMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../src/services/businessCalendarService.js', () => ({ default: calendarMock }));

const { default: shares, settingsKey } = await import('../src/services/assignmentShares/sharesService.js');
const { awayDays, awayWindows } = await import('../src/services/assignmentShares/rules.js');

const WS = 5;
const NOW = new Date('2026-11-09T19:00:00Z'); // Monday 11:00 Pacific
const A = 1; const S = 2; const J = 3; const K = 4;
const PEOPLE = [
  { id: A, name: 'Alex Doe' }, { id: S, name: 'Sam Lee' }, { id: J, name: 'Jo Park' }, { id: K, name: 'Kit Moss' },
];
const MEMBERS = [{ techId: A, pct: 50 }, { techId: S, pct: 20 }, { techId: J, pct: 20 }, { techId: K, pct: 10 }];
const day = (d) => new Date(`${d}T00:00:00Z`);
const leave = (technicianId, d, extra = {}) => ({ technicianId, leaveDate: day(d), category: 'OFF', status: 'APPROVED', isFullDay: true, ...extra });
// 10 tickets to the list: Alex 6 (60%), Sam 1 (10%), Jo 2 (20%), Kit 1 (10%).
const TICKETS = [A, A, A, A, A, A, S, J, J, K].map((holder, i) => ({ id: 100 + i, assignedTechId: holder, assignedBy: null, assignedTech: null }));

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  shares._reset();
  store.set(settingsKey(WS), JSON.stringify({ v: 1, mode: 'shadow', period: 'week', categoryIds: [10], members: MEMBERS }));
  prismaMock.workspace.findUnique.mockResolvedValue({ defaultTimezone: 'America/Vancouver' });
  prismaMock.ticket.findMany.mockResolvedValue(TICKETS);
  prismaMock.technician.findMany.mockResolvedValue(PEOPLE);
  prismaMock.$queryRaw.mockResolvedValue([]);
  prismaMock.technicianLeave.findMany.mockResolvedValue([
    // Sam: Mon–Wed off, a Sunday (not a working day), WFH (not away), a half day.
    leave(S, '2026-11-01'), leave(S, '2026-11-02'), leave(S, '2026-11-03'), leave(S, '2026-11-04'),
    leave(S, '2026-11-05', { category: 'WFH' }), leave(S, '2026-11-06', { isFullDay: false }),
    // Coming up: the holiday does not count, Wed–Thu next week do.
    leave(S, '2026-11-11'), leave(S, '2026-11-18'), leave(S, '2026-11-19'),
    // Alex: one day, written twice (Vacation Tracker and a native request).
    leave(A, '2026-10-28'), leave(A, '2026-10-28', { category: 'OTHER' }),
  ]);
});

describe('days away in the Shares report', () => {
  test('each row gets days away in the window and coming up, working days only', async () => {
    const out = await shares.results(WS, { days: 14, now: NOW });
    const byId = new Map(out.rows.map((r) => [r.techId, r]));

    expect(byId.get(S).away.past).toMatchObject({ days: 3.5, heavy: true });
    expect(byId.get(S).away.past.dates).toEqual([
      { date: '2026-11-02', half: false }, { date: '2026-11-03', half: false }, { date: '2026-11-04', half: false }, { date: '2026-11-06', half: true },
    ]);
    expect(byId.get(S).away.ahead).toMatchObject({ days: 2, from: '2026-11-18', heavy: false });
    expect(byId.get(A).away.past).toMatchObject({ days: 1, heavy: false });
    expect(byId.get(J).away).toEqual({ past: { days: 0, dates: [], heavy: false }, ahead: { days: 0, dates: [], from: null, heavy: false } });

    expect(out.availability).toEqual({
      today: '2026-11-09',
      unit: 'working days',
      calendar: 'business hours',
      past: { days: 14, from: '2026-10-27', to: '2026-11-09', workingDays: 10 },
      ahead: { days: 14, from: '2026-11-10', to: '2026-11-23', workingDays: 9 },
      belowShareWithAway: 1, // Sam: 10% against 20%. Alex was away but is above his share.
      awaySoon: 1,
    });
    // Still ordered by share, never by count.
    expect(out.rows.map((r) => r.techId)).toEqual([A, J, S, K]);
  });

  test('the leave read is scoped to the workspace and the people on the list', async () => {
    await shares.results(WS, { days: 7, now: NOW });
    const { where, select } = prismaMock.technicianLeave.findMany.mock.calls[0][0];
    expect(where).toMatchObject({ workspaceId: WS, technicianId: { in: [A, J, S, K] }, status: 'APPROVED' });
    expect(where.leaveDate.gte.toISOString()).toBe('2026-11-03T00:00:00.000Z');
    expect(where.leaveDate.lte.toISOString()).toBe('2026-11-23T00:00:00.000Z');
    expect(select).not.toHaveProperty('photoUrl');
  });

  test('a failed leave read leaves the report as it was, with no availability', async () => {
    prismaMock.technicianLeave.findMany.mockRejectedValue(new Error('db down'));
    const out = await shares.results(WS, { days: 14, now: NOW });
    expect(out.availability).toBeNull();
    expect(out.rows).toHaveLength(4);
    expect(out.rows[0].away).toBeUndefined();
    expect(out.totals).toMatchObject({ tickets: 10, toMembers: 10 });
  });

  test('no business hours set: Monday to Friday', async () => {
    calendarMock.loadCalendar.mockResolvedValueOnce(null);
    const out = await shares.results(WS, { days: 14, now: NOW });
    expect(out.availability).toMatchObject({ calendar: 'Monday to Friday', ahead: { workingDays: 10 } });
    // 11 Nov is a working day without the holiday list.
    expect(out.rows.find((r) => r.techId === S).away.ahead.days).toBe(3);
  });

  test('nothing set up: no availability block', async () => {
    store.clear();
    const out = await shares.results(WS, { days: 14, now: NOW });
    expect(out.availability).toBeUndefined();
    expect(prismaMock.technicianLeave.findMany).not.toHaveBeenCalled();
  });
});

describe('the pure helpers', () => {
  test('awayWindows: the last N dates ending today and the 14 after', () => {
    const w = awayWindows(NOW, 'America/Vancouver', { pastDays: 7 });
    expect(w.today).toBe('2026-11-09');
    expect(w.past).toEqual(['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09']);
    expect(w.ahead).toHaveLength(14);
    expect(w.ahead[0]).toBe('2026-11-10');
  });

  test('awayDays: IGNORED, unapproved and out-of-span rows do not count; a full day beats a half day', () => {
    const out = awayDays([
      leave(S, '2026-11-02', { category: 'IGNORED' }),
      leave(S, '2026-11-03', { status: 'PENDING' }),
      leave(S, '2026-11-04', { isFullDay: false }), leave(S, '2026-11-04'),
      leave(S, '2026-12-01'),
    ], ['2026-11-02', '2026-11-03', '2026-11-04']);
    expect(out).toEqual({ days: 1, dates: [{ date: '2026-11-04', half: false }] });
  });
});
