/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Overview redesign (15 Nov 2026): people are ranked by how much they affect
// the team. Away first, part of the day next, working from home last and
// small; a multi-day absence is one bar; past days are not listed.

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date();
const TODAY = keyOf(now);
const plus = (n) => { const d = new Date(now); d.setDate(d.getDate() + n); return keyOf(d); };

let calendarData;
let approvalsData;
const api = vi.hoisted(() => ({}));
Object.assign(api, {
  calendar: vi.fn(async () => ({ success: true, data: calendarData })),
  roster: vi.fn(async () => ({ success: true, data: { people: [
    { email: 'a@x.ca', name: 'Ann Lo' }, { email: 'b@x.ca', name: 'Bo Chen' }, { email: 'c@x.ca', name: 'Cy Diaz' }, { email: 'd@x.ca', name: 'Di Egan' },
  ], groups: [], offices: [] } })),
  upcomingHolidays: vi.fn(async () => ({ success: true, data: [] })),
  myRequests: vi.fn(async () => ({ success: true, data: [] })),
  approvals: vi.fn(async () => ({ success: true, data: approvalsData })),
});
vi.mock('../../services/api', () => ({ get availabilityAPI() { return api; }, getWorkspaceId: () => 1 }));

const { default: OverviewPanel, buildWeek, pictogramFor } = await import('./OverviewPanel');
const { resetRosterCache } = await import('./teamViews');

const TYPES = [
  { id: 1, key: 'vacation', name: 'Vacation', unit: 'day', availability: 'OFF', sortOrder: 10 },
  { id: 2, key: 'wfh', name: 'Working from home', unit: 'day', availability: 'WFH', sortOrder: 30 },
  { id: 3, key: 'appointment', name: 'Appointment', unit: 'hour', availability: 'OFF', sortOrder: 20 },
];
const ME = {
  person: { name: 'Kim Lee', email: 'k@x.ca' },
  leaveTypes: TYPES,
  balances: [{ leaveTypeId: 1, name: 'Vacation', year: 2026, entitled: 10, adjustments: 0, taken: 26, scheduled: 0, pending: 0, remaining: -16 }],
  pendingApprovals: 0,
};
const entry = (over) => ({ dayPart: 'full', status: 'approved', label: 'Vacation', color: 'emerald', availability: 'OFF', ...over });
const show = (me = ME, props = {}) => render(<MemoryRouter><OverviewPanel me={me} {...props} /></MemoryRouter>);

beforeEach(() => {
  resetRosterCache();
  approvalsData = [];
  calendarData = { people: [{ email: 'a@x.ca' }, { email: 'b@x.ca' }, { email: 'c@x.ca' }, { email: 'd@x.ca' }], holidayNames: {}, entries: [] };
});
afterEach(() => cleanup());

describe('buildWeek', () => {
  // A fixed week: Monday 16 to Friday 20 November 2026.
  const MON = '2026-11-16';
  const week = (entries, today = MON) => buildWeek(entries, MON, today, new Set());

  test('a multi-day absence is one lane; single days, part days and home days sit in their day', () => {
    const w = week([
      entry({ id: 1, email: 'a@x.ca', startDate: '2026-11-16', endDate: '2026-11-20' }),
      entry({ id: 2, email: 'b@x.ca', startDate: '2026-11-16', endDate: '2026-11-16', label: 'Sick' }),
      entry({ id: 3, email: 'c@x.ca', startDate: '2026-11-16', endDate: '2026-11-16', label: 'Appointment', dayPart: 'hours', startMinute: 900, endMinute: 990 }),
      entry({ id: 4, email: 'd@x.ca', startDate: '2026-11-16', endDate: '2026-11-16', label: 'Working from home', availability: 'WFH' }),
    ]);
    expect(w.days.map((d) => d.key)).toEqual(['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20']);
    expect(w.lanes.map((l) => [l.entry.email, l.start, l.end])).toEqual([['a@x.ca', 0, 4]]);
    const mon = w.perDay.get(MON);
    expect(mon.away.filter((x) => !x.inLane).map((x) => x.entry.email)).toEqual(['b@x.ca']);
    expect(mon.part.map((x) => x.entry.email)).toEqual(['c@x.ca']);
    expect(mon.remote.map((x) => x.entry.email)).toEqual(['d@x.ca']);
    // Out = off all day. An appointment or a home day does not take the person out.
    expect([...mon.out].sort()).toEqual(['a@x.ca', 'b@x.ca']);
    expect([...w.perDay.get('2026-11-18').out]).toEqual(['a@x.ca']);
  });

  test('a waiting request is counted as waiting, not as out; "no change" types are left out', () => {
    const w = week([
      entry({ id: 1, email: 'a@x.ca', startDate: '2026-11-17', endDate: '2026-11-17', status: 'pending' }),
      entry({ id: 2, email: 'b@x.ca', startDate: '2026-11-17', endDate: '2026-11-17', availability: 'NONE', label: 'Training' }),
    ]);
    const tue = w.perDay.get('2026-11-17');
    expect(tue.waiting).toBe(1);
    expect(tue.out.size).toBe(0);
    expect(tue.away).toHaveLength(1);
  });

  test('a weekend day shows only when it is today or someone is booked on it; a long absence skips it', () => {
    expect(week([]).days).toHaveLength(5);
    expect(week([], '2026-11-21').days.map((d) => d.key)).toContain('2026-11-21');
    const w = week([entry({ id: 1, email: 'a@x.ca', startDate: '2026-11-19', endDate: '2026-11-24' })]);
    expect(w.days).toHaveLength(5);
    expect(w.lanes[0]).toMatchObject({ start: 3, end: 4 });
  });

  test('two overlapping absences get their own rows', () => {
    const w = week([
      entry({ id: 1, email: 'a@x.ca', startDate: '2026-11-16', endDate: '2026-11-18' }),
      entry({ id: 2, email: 'b@x.ca', startDate: '2026-11-17', endDate: '2026-11-20' }),
      entry({ id: 3, email: 'c@x.ca', startDate: '2026-11-19', endDate: '2026-11-20' }),
    ]);
    expect(w.lanes.map((l) => l.row)).toEqual([0, 1, 0]);
    expect(w.laneRows).toBe(2);
  });
});

describe('pictogramFor', () => {
  test('by what the type is, not by its position', () => {
    expect(pictogramFor(TYPES[0])).toBe('vacation');
    expect(pictogramFor(TYPES[1])).toBe('wfh');
    expect(pictogramFor(TYPES[2])).toBe('appointment');
    expect(pictogramFor({ key: 'sick', name: 'Sick', unit: 'day' })).toBe('sick');
    expect(pictogramFor({ key: 'site', name: 'Site visit', availability: 'ONSITE' })).toBe('site');
  });
});

describe('the page', () => {
  test('today: away and part-day people are named; home workers are a count', async () => {
    calendarData.entries = [
      entry({ id: 1, email: 'a@x.ca', startDate: TODAY, endDate: TODAY, label: 'Sick' }),
      entry({ id: 2, email: 'b@x.ca', startDate: TODAY, endDate: TODAY, label: 'Appointment', dayPart: 'hours', startMinute: 900, endMinute: 990 }),
      entry({ id: 3, email: 'c@x.ca', startDate: TODAY, endDate: TODAY, label: 'Working from home', availability: 'WFH' }),
    ];
    show();
    const board = await screen.findByTestId('out-this-week');
    await waitFor(() => expect(within(board).getByText('Ann Lo')).toBeInTheDocument());
    expect(within(board).getByText('Bo Chen')).toBeInTheDocument();
    expect(within(board).getByText(/3pm–4:30pm/)).toBeInTheDocument();
    expect(within(board).getByText('1 at home')).toBeInTheDocument();
    expect(within(board).getByText('3 of 4 in')).toBeInTheDocument();
    const summary = screen.getByTestId('week-summary');
    expect(summary).toHaveTextContent('1 away and 1 out for part of the day today');
  });

  test('a site visit is counted as in, and named apart from working at home', async () => {
    calendarData.entries = [
      entry({ id: 1, email: 'c@x.ca', startDate: TODAY, endDate: TODAY, label: 'Working from home', availability: 'WFH' }),
      entry({ id: 2, email: 'a@x.ca', startDate: TODAY, endDate: TODAY, label: 'Site visit', availability: 'ONSITE', place: 'Toronto' }),
    ];
    show();
    const board = await screen.findByTestId('out-this-week');
    await waitFor(() => expect(within(board).getByText('1 at home · 1 on a site visit')).toBeInTheDocument());
    // Nobody is out: every day of the week, today included, reads 4 of 4 in.
    expect(within(board).getAllByText('4 of 4 in')).toHaveLength(5);
    expect(within(board).queryByText(/working remotely/)).not.toBeInTheDocument();
  });

  test('a balance that has gone over says so in words, never as a negative number', async () => {
    show();
    const balances = await screen.findByTestId('my-balances');
    expect(balances).toHaveTextContent('16 over');
    expect(balances).toHaveTextContent('Vacation · 26 of 10 taken');
    expect(balances).not.toHaveTextContent('-16');
    await waitFor(() => expect(screen.getByTestId('my-next')).toHaveTextContent('Nothing booked for you, Kim.'));
  });

  test('one-click booking hands over the leave type, in the workspace order', async () => {
    const onBook = vi.fn();
    show(ME, { onBook });
    const names = within(screen.getByLabelText('Book time away')).getAllByRole('button').map((b) => b.textContent);
    expect(names).toEqual(['Vacation', 'Appointment', 'Working from home']);
    fireEvent.click(screen.getByRole('button', { name: 'Appointment' }));
    expect(onBook).toHaveBeenCalledWith(3);
  });

  test('requests waiting for me show only when there are some, with why each needs a person', async () => {
    show();
    await screen.findByTestId('out-this-week');
    expect(api.approvals).not.toHaveBeenCalled();
    expect(screen.queryByText('Waiting for you')).not.toBeInTheDocument();
    cleanup();
    approvalsData = [
      { id: 7, email: 'b@x.ca', name: 'Bo Chen', leaveTypeId: 2, startDate: plus(3), endDate: plus(3), dayPart: 'full', decision: { fired: [{ message: 'Second home day this week.' }] } },
      { id: 8, email: 'c@x.ca', leaveTypeId: 1, startDate: plus(9), endDate: plus(11), dayPart: 'full', mine: false },
    ];
    show({ ...ME, pendingApprovals: 1 });
    const list = await screen.findByTestId('overview-approvals');
    expect(within(list).getByText('Bo Chen')).toBeInTheDocument();
    expect(within(list).getByText('Second home day this week.')).toBeInTheDocument();
    expect(within(list).queryByText('Cy Diaz')).not.toBeInTheDocument();
  });

  test('next week is one click away and asks for that week', async () => {
    show();
    await screen.findByTestId('out-this-week');
    expect(screen.getByRole('heading', { name: 'This week' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Week after' }));
    expect(screen.getByRole('heading', { name: 'Next week' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'This week' }));
    expect(screen.getByRole('heading', { name: 'This week' })).toBeInTheDocument();
  });
});
