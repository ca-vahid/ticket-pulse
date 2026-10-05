/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { fmtRange, nameFromEmail } from './availabilityUi';
import { describeCondition } from './admin/RulesSection';

// Team views (5 Oct 2026 redesign): Wallchart (grouped rows, bars split
// around weekends, waiting requests for approvers, holidays named, coverage),
// Calendar (named bars) and Overview (out this week, holidays, coverage).

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const key = (d) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(d)}`;
const todayK = key(now.getDate());
// First Friday of this month and the Monday after it (a weekend in between).
const firstFri = (() => { for (let d = 1; d <= 7; d += 1) if (new Date(now.getFullYear(), now.getMonth(), d).getDay() === 5) return d; return 2; })();
const fri = key(firstFri);
const sat = key(firstFri + 1);
const mon = key(firstFri + 3);
const tue = key(firstFri + 4);

const PEOPLE = [{ email: 'a@x.ca', name: 'ann', officeId: 1 }, { email: 'b@x.ca', name: 'Bo Chen', officeId: 2 }];
let calendarData;
const api = vi.hoisted(() => ({}));
Object.assign(api, {
  calendar: vi.fn(async () => ({ success: true, data: calendarData })),
  roster: vi.fn(async () => ({ success: true, data: {
    people: [
      { email: 'a@x.ca', name: 'Ann Lo', officeId: 1, photoUrl: 'data:image/png;base64,AAAA', groupIds: [7] },
      { email: 'b@x.ca', name: 'Bo Chen', officeId: 2, photoUrl: null, groupIds: [8] },
    ],
    groups: [{ id: 7, name: 'Service desk' }, { id: 8, name: 'Infrastructure' }],
    offices: [{ id: 1, name: 'Vancouver' }, { id: 2, name: 'Calgary' }],
  } })),
  upcomingHolidays: vi.fn(async () => ({ success: true, data: [{ date: key(Math.min(28, now.getDate() + 3)), name: 'Founders Day' }] })),
  myRequests: vi.fn(async () => ({ success: true, data: [] })),
});
vi.mock('../../services/api', () => ({ get availabilityAPI() { return api; }, getWorkspaceId: () => 1 }));

const { default: TeamCalendarPanel } = await import('./TeamCalendarPanel');
const { default: MonthCalendarPanel } = await import('./MonthCalendarPanel');
const { default: OverviewPanel } = await import('./OverviewPanel');
const { resetRosterCache } = await import('./teamViews');

const ME = { offices: [{ id: 1, name: 'Vancouver' }, { id: 2, name: 'Calgary' }], leaveTypes: [], balances: [] };
const inRouter = (ui, path = '/availability/calendar') => render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>);

beforeEach(() => {
  resetRosterCache();
  calendarData = {
    people: PEOPLE,
    entries: [
      { id: 1, email: 'a@x.ca', startDate: fri, endDate: tue, dayPart: 'full', status: 'approved', label: 'Vacation', color: 'emerald', availability: 'OFF' },
      { id: 2, email: 'b@x.ca', startDate: mon, endDate: mon, dayPart: 'am', status: 'approved', label: 'Training', color: 'violet', availability: 'OFF' },
      { id: 3, email: 'b@x.ca', startDate: tue, endDate: tue, dayPart: 'full', status: 'pending', label: 'Vacation', color: 'emerald', availability: 'OFF' },
    ],
    holidays: [key(15)],
    holidayNames: { [key(15)]: 'Founders Day' },
    canSeePending: true,
  };
});
afterEach(() => cleanup());

describe('Wallchart', () => {
  test('rows grouped by office with faces; a Fri–Tue leave is one bar per working stretch', async () => {
    inRouter(<TeamCalendarPanel me={ME} />);
    await screen.findAllByText('Ann Lo');
    expect(screen.getByText('Calgary')).toBeInTheDocument();
    expect(screen.getByText('Vancouver')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('cal-row-a@x.ca').querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,AAAA'));
    expect(screen.getByTestId(`cal-bar-a@x.ca-${fri}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`cal-bar-a@x.ca-${sat}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`cal-bar-a@x.ca-${mon}`)).toHaveAttribute('aria-label', expect.stringContaining('Ann Lo, Vacation'));
  });

  test('waiting requests show dashed for approvers and hide with the switch', async () => {
    inRouter(<TeamCalendarPanel me={ME} />);
    const pending = await screen.findByTestId(`cal-bar-b@x.ca-${tue}`);
    expect(pending.className).toContain('border-dashed');
    fireEvent.click(screen.getByLabelText('Show waiting requests'));
    await waitFor(() => expect(screen.queryByTestId(`cal-bar-b@x.ca-${tue}`)).not.toBeInTheDocument());
  });

  test('no waiting requests and not an approver → no switch', async () => {
    calendarData = { ...calendarData, entries: calendarData.entries.filter((e) => e.status !== 'pending'), canSeePending: false };
    inRouter(<TeamCalendarPanel me={ME} />);
    await screen.findAllByText('Ann Lo');
    expect(screen.queryByLabelText('Show waiting requests')).not.toBeInTheDocument();
  });

  test('holidays are named in the date header; group by approval group', async () => {
    inRouter(<TeamCalendarPanel me={ME} />);
    await screen.findAllByText('Ann Lo');
    expect(screen.getAllByText('Founders Day').length).toBeGreaterThan(0);
    fireEvent.click(await screen.findByRole('button', { name: 'By approval group' }));
    expect(await screen.findByText('Service desk')).toBeInTheDocument();
    expect(screen.getByText('Infrastructure')).toBeInTheDocument();
  });

  test('today has its own column look, never the weekend grey', async () => {
    inRouter(<TeamCalendarPanel me={ME} />);
    await screen.findAllByText('Ann Lo');
    const cell = screen.getByTestId(`cal-cell-a@x.ca-${todayK}`);
    expect(cell).toHaveAttribute('data-today', 'true');
    expect(cell.className).toContain('bg-blue-100/80');
    expect(cell.className).not.toContain('bg-muted/60');
  });

  test('the strip under the dates counts who is away', async () => {
    inRouter(<TeamCalendarPanel me={ME} />);
    await screen.findAllByText('Ann Lo');
    const strip = screen.getByTestId('wallchart-coverage');
    expect(within(strip).getAllByText(/2 away: Ann Lo, Bo Chen/).length).toBe(1);
  });
});

describe('Calendar (month)', () => {
  test('bars carry the person\'s name', async () => {
    inRouter(<MonthCalendarPanel me={ME} />, '/availability/month');
    const cal = await screen.findByTestId('month-calendar');
    await waitFor(() => expect(within(cal).getAllByText('Ann Lo').length).toBeGreaterThan(0));
    expect(within(cal).getAllByText('Bo Chen').length).toBeGreaterThan(0);
  });
});

describe('Overview', () => {
  test('out this week, holidays coming up and the coverage strip', async () => {
    calendarData = {
      ...calendarData,
      entries: [{ id: 9, email: 'b@x.ca', startDate: todayK, endDate: todayK, dayPart: 'full', status: 'approved', label: 'Vacation', color: 'emerald', availability: 'OFF' }],
    };
    inRouter(<OverviewPanel me={ME} />, '/availability/overview');
    const list = await screen.findByTestId('out-this-week');
    await waitFor(() => expect(within(list).getByText('Bo Chen')).toBeInTheDocument());
    expect(within(list).getByText(/^back /)).toBeInTheDocument();
    expect(await screen.findByTestId('upcoming-holidays')).toHaveTextContent('Founders Day');
    expect(screen.getByTestId('coverage-strip')).toBeInTheDocument();
  });
});

describe('formatting helpers', () => {
  test('ranges, names and rule conditions read in plain words', () => {
    expect(fmtRange({ startDate: '2026-10-05', endDate: '2026-10-05', dayPart: 'pm' })).toMatch(/afternoon$/);
    expect(fmtRange({ startDate: '2026-10-05', endDate: '2026-10-05', dayPart: 'hours', startMinute: 540, endMinute: 630 })).toMatch(/9am–10:30am$/);
    expect(nameFromEmail('jane.doe@x.ca')).toBe('Jane Doe');
    expect(describeCondition({ kind: 'capacity', max: 2, window: 'day', scope: 'office' })).toBe('more than 2 away per day in the office');
    expect(describeCondition({ kind: 'advance_notice', minDaysAhead: 14 })).toBe("less than 14 days' notice");
  });
});
