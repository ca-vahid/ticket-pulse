/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * QA 11-25 #1: My time redesigned (the QA's mockup, refined). Booking as three
 * steps with an inline month calendar; "Coming up" lists only approved and
 * waiting requests that are not over; the long list is gone. Invented names.
 * "Today" is fixed at Wed 25 Nov 2026 so the calendar is stable.
 */

const api = vi.hoisted(() => ({
  preview: vi.fn(),
  createRequest: vi.fn(),
  updateRequest: vi.fn(),
  myRequests: vi.fn(),
  cancelRequest: vi.fn(),
  upcomingHolidays: vi.fn(),
}));
vi.mock('../../services/api', () => ({ availabilityAPI: api }));
vi.mock('../../hooks/useAvailabilityApprovalCount', () => ({ notifyAvailabilityChanged: vi.fn() }));

const { default: BookTimeForm } = await import('./BookTimeForm');
const { default: MonthPicker } = await import('./MonthPicker');
const { default: ComingUpCard } = await import('./ComingUpCard');
const { default: MyTimePanel } = await import('./MyTimePanel');
const { defaultTypes, mostUsedTypes, pickDay, rangeWords, countWorkingDays, upcomingRequests } = await import('./bookingModel');

const TODAY = '2026-11-25'; // a Wednesday

const TYPES = [
  { id: 1, key: 'vacation', name: 'Vacation', color: 'emerald', unit: 'day', availability: 'OFF', allowHalfDays: true, sortOrder: 1 },
  { id: 2, key: 'wfh', name: 'Working from home', color: 'sky', unit: 'day', availability: 'WFH', sortOrder: 2 },
  { id: 3, key: 'sick', name: 'Sick', color: 'rose', unit: 'day', availability: 'OFF', allowPastDated: true, sortOrder: 3 },
  { id: 4, key: 'site', name: 'Site visit', color: 'amber', unit: 'day', availability: 'ONSITE', allowHalfDays: true, sortOrder: 4 },
  { id: 5, key: 'training', name: 'Training', color: 'violet', unit: 'day', availability: 'OFF', sortOrder: 5, description: 'Courses and conferences' },
  { id: 6, key: 'bereavement', name: 'Bereavement', color: 'slate', unit: 'day', availability: 'OFF', requiresNote: true, sortOrder: 6 },
  { id: 7, key: 'appointment', name: 'Appointment', color: 'slate', unit: 'hour', availability: 'OFF', sortOrder: 7 },
];
const OFFICES = [{ id: 2, name: 'Toronto', isActive: true }, { id: 1, name: 'Vancouver', isActive: true }];
const ME = { leaveTypes: TYPES, offices: OFFICES, settings: {}, balances: [] };
const typeById = new Map(TYPES.map((t) => [t.id, t]));

const flushPreview = async () => { await act(async () => { vi.advanceTimersByTime(400); }); };
const day = (n, month = 'November') => screen.getByRole('gridcell', { name: new RegExp(`^\\w+ ${n} ${month}`) });
const send = () => screen.getByRole('button', { name: 'Send request' });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  api.preview.mockResolvedValue({ data: { outcome: 'pending', days: 3, dates: [] } });
  api.createRequest.mockResolvedValue({ data: { id: 501, status: 'pending' } });
  api.upcomingHolidays.mockResolvedValue({ data: [] });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

describe('the pure helpers', () => {
  test('a tap picks a day, a second makes the range (either way round), a third starts over', () => {
    let s = pickDay(null, '2026-11-30');
    expect(s).toEqual({ start: '2026-11-30', end: '2026-11-30', open: true });
    s = pickDay(s, '2026-11-26');
    expect(s).toEqual({ start: '2026-11-26', end: '2026-11-30', open: false });
    expect(pickDay(s, '2026-11-27')).toEqual({ start: '2026-11-27', end: '2026-11-27', open: true });
    expect(pickDay({ start: '2026-11-26', end: '2026-11-26', open: true }, '2026-11-30', { single: true })).toEqual({ start: '2026-11-30', end: '2026-11-30', open: false });
  });

  test('the words for a pick, and working days skip weekends and holidays', () => {
    expect(rangeWords('2026-12-01', '2026-12-05', { today: TODAY })).toBe('Tue 1 – Sat 5 Dec');
    expect(rangeWords('2026-11-30', '2026-12-04', { today: TODAY })).toBe('Mon 30 Nov – Fri 4 Dec');
    expect(rangeWords('2026-12-28', '2027-01-01', { today: TODAY })).toBe('Mon 28 Dec 2026 – Fri 1 Jan 2027');
    expect(countWorkingDays('2026-12-24', '2026-12-29', new Set(['2026-12-25']))).toBe(3);
  });

  test('most-used types: the person\'s own most-booked first, then the sort order', () => {
    const reqs = [
      { leaveTypeId: 5, status: 'approved' }, { leaveTypeId: 5, status: 'pending' }, { leaveTypeId: 3, status: 'approved' },
      { leaveTypeId: 6, status: 'cancelled' }, { leaveTypeId: 6, status: 'denied' },
    ];
    expect(mostUsedTypes(TYPES, reqs).map((t) => t.name)).toEqual(['Training', 'Sick', 'Vacation', 'Working from home']);
    expect(mostUsedTypes(TYPES, []).map((t) => t.name)).toEqual(['Vacation', 'Working from home', 'Sick', 'Site visit']);
  });

  test('QA 11-26 #1: the four tiles are Working from home, Appointment, Vacation, Sick, matched by key', () => {
    expect(defaultTypes(TYPES).map((t) => t.name)).toEqual(['Working from home', 'Appointment', 'Vacation', 'Sick']);
    // By key, not by name: renamed types keep their place.
    const renamed = TYPES.map((t) => (t.key === 'wfh' ? { ...t, name: 'Remote day' } : t));
    expect(defaultTypes(renamed)[0].name).toBe('Remote day');
    // A type switched off in the workspace leaves its slot to the next type in the admins' order.
    const noAppointment = TYPES.filter((t) => t.key !== 'appointment');
    expect(defaultTypes(noAppointment).map((t) => t.name)).toEqual(['Working from home', 'Vacation', 'Sick', 'Site visit']);
    const onlyTwo = TYPES.filter((t) => ['vacation', 'training'].includes(t.key));
    expect(defaultTypes(onlyTwo).map((t) => t.name)).toEqual(['Vacation', 'Training']);
    expect(defaultTypes([])).toEqual([]);
  });
});

describe('the month picker on its own (props in)', () => {
  test('a grid with labelled days: today, weekends, holidays, booked dots; past days disabled', () => {
    const booked = new Map([[TODAY, [{ name: 'Working from home', color: 'sky', status: 'approved' }]], ['2026-12-02', [{ name: 'Vacation', color: 'emerald', status: 'pending' }]]]);
    render(<MonthPicker today={TODAY} minKey={TODAY} holidays={{ '2026-12-25': 'Christmas Day' }} booked={booked} onPick={vi.fn()} />);
    const grid = screen.getByRole('grid', { name: 'November 2026' });
    expect(grid).toBeInTheDocument();
    expect(day(25)).toHaveAccessibleName('Wednesday 25 November, today, Working from home booked');
    expect(day(25)).toHaveAttribute('title', 'Working from home booked');
    expect(day(28)).toHaveAccessibleName('Saturday 28 November, weekend');
    expect(day(24)).toHaveAttribute('aria-disabled', 'true');
    // The month buttons say where they go, and the heading is announced when the month changes.
    expect(screen.getByRole('button', { name: 'Previous month, October 2026' })).toBeInTheDocument();
    expect(screen.getByTestId('month-picker-month')).toHaveAttribute('aria-live', 'polite');
    fireEvent.click(screen.getByRole('button', { name: 'Next month, December 2026' }));
    expect(screen.getByTestId('month-picker-month')).toHaveTextContent('December 2026');
    expect(screen.getByRole('button', { name: 'Next month, January 2027' })).toBeInTheDocument();
    expect(screen.getByRole('grid', { name: 'December 2026' })).toBeInTheDocument();
    expect(day(25, 'December')).toHaveAccessibleName('Friday 25 December, holiday: Christmas Day');
    expect(day(2, 'December')).toHaveAccessibleName(/Vacation waiting for approval/);
    // Waiting is a hollow ring, booked a filled dot; the legend says which is which.
    expect(day(2, 'December').querySelector('[data-dot]')).toHaveAttribute('data-dot', 'waiting');
    expect(day(2, 'December').querySelector('[data-dot]').className).toMatch(/border-current/);
    expect(screen.getByTestId('month-picker-legend')).toHaveTextContent(/Booked.*Waiting for approval.*Today.*Weekend.*Holiday.*Grey numbers: past days/);
    // Past days and weekends look different: weekends shaded, past days plain muted numbers.
    expect(day(27, 'December').firstElementChild.className).toMatch(/bg-muted\/60/); // a Sunday
    expect(day(25, 'December').firstElementChild.className).toMatch(/bg-rose-50/);
    expect(screen.getByRole('grid')).toHaveAttribute('aria-multiselectable', 'true');
  });

  test('arrow keys move the focus a day or a week; Enter picks; a disabled day is not picked', () => {
    const onPick = vi.fn();
    render(<MonthPicker today={TODAY} minKey={TODAY} onPick={onPick} />);
    const start = day(25);
    expect(start).toHaveAttribute('tabindex', '0');
    start.focus();
    fireEvent.keyDown(start, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(day(26));
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(day(3, 'December'));
    fireEvent.keyDown(document.activeElement, { key: 'Enter' });
    expect(onPick).toHaveBeenLastCalledWith('2026-12-03');
    fireEvent.keyDown(document.activeElement, { key: 'PageUp' });
    expect(document.activeElement).toBe(day(3));
    fireEvent.keyDown(document.activeElement, { key: ' ' });
    expect(onPick).toHaveBeenCalledTimes(1); // 3 Nov is before minKey here
    // Like the disabled Previous button, the keyboard stops at minKey's month.
    expect(screen.getByRole('button', { name: /^Previous month/ })).toBeDisabled();
    fireEvent.keyDown(document.activeElement, { key: 'PageUp' });
    expect(document.activeElement).toBe(day(3));
  });
});

describe('Book time away', () => {
  test('1. What: the four set types, "More types" opens the rest in place, a pick takes the 4th tile', async () => {
    render(<BookTimeForm me={ME} today={TODAY} requests={[]} />);
    const tiles = screen.getByTestId('type-tiles');
    const names = () => within(tiles).getAllByRole('radio').map((r) => r.getAttribute('aria-label'));
    // QA 11-26 #1: Working from home, Appointment, Vacation, Sick, in that order.
    expect(names()).toEqual(['Working from home', 'Appointment', 'Vacation', 'Sick']);
    // With no history the first of the four in the admins' order starts picked (as before).
    expect(screen.getByRole('radio', { name: 'Vacation' })).toBeChecked();
    const more = screen.getByRole('button', { name: 'More types (3)' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(more);
    // The extra types are toggle buttons of their own (each a Tab stop), not radios of the four's group.
    const group = screen.getByRole('group', { name: 'More types' });
    const extra = within(group).getAllByRole('button');
    expect(extra.map((b) => b.getAttribute('aria-label'))).toEqual(['Site visit', 'Training', 'Bereavement']);
    expect(within(group).queryAllByRole('radio')).toHaveLength(0);
    for (const b of extra) {
      expect(b).toHaveAttribute('aria-pressed', 'false');
      expect(b).not.toHaveAttribute('tabindex', '-1');
    }
    expect(within(group).getByRole('button', { name: 'Training' })).toHaveAccessibleDescription('Courses and conferences');
    fireEvent.click(within(group).getByRole('button', { name: 'Training' }));
    // More stays open, the four tiles stay put, and Training shows as pressed.
    expect(screen.getByRole('group', { name: 'More types' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Training' })).toHaveAttribute('aria-pressed', 'true');
    expect(names()).toEqual(['Working from home', 'Appointment', 'Vacation', 'Sick']);
    expect(screen.getByRole('radio', { name: 'Vacation' })).not.toBeChecked();
    // Once More closes, the picked type takes the fourth tile.
    fireEvent.click(screen.getByRole('button', { name: 'Fewer types' }));
    expect(screen.queryByRole('group', { name: 'More types' })).toBeNull();
    expect(names()).toEqual(['Working from home', 'Appointment', 'Vacation', 'Training']);
    expect(screen.getByRole('radio', { name: 'Training' })).toBeChecked();
    // Training has its own glyph, not the Vacation picture.
    expect(screen.getByRole('radio', { name: 'Training' }).closest('label').querySelector('[data-glyph]')).not.toBeNull();
    expect(screen.getByRole('radio', { name: 'Vacation' }).closest('label').querySelector('img')).toHaveAttribute('src', '/brand/vacation-pulse/vacation.webp');
  });

  test('the default type stops following the most-used one once the person has done anything', () => {
    const { rerender } = render(<BookTimeForm me={ME} today={TODAY} requests={[]} />);
    fireEvent.click(day(26));
    rerender(<BookTimeForm me={ME} today={TODAY} requests={[{ id: 1, leaveTypeId: 2, status: 'approved', startDate: '2026-11-18', endDate: '2026-11-18' }]} />);
    expect(screen.getByRole('radio', { name: 'Vacation' })).toBeChecked();
  });

  test('the picked tile follows the person\'s most-used of the four once their requests arrive', () => {
    const { rerender } = render(<BookTimeForm me={ME} today={TODAY} requests={[]} />);
    rerender(<BookTimeForm me={ME} today={TODAY} requests={[{ id: 1, leaveTypeId: 3, status: 'approved', startDate: '2026-11-18', endDate: '2026-11-18' }]} />);
    expect(within(screen.getByTestId('type-tiles')).getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual(['Working from home', 'Appointment', 'Vacation', 'Sick']);
    expect(screen.getByRole('radio', { name: 'Sick' })).toBeChecked();
  });

  test('a most-used type kept under More types never pushes one of the four out', () => {
    const reqs = [5, 5, 5].map((leaveTypeId, i) => ({ id: i + 1, leaveTypeId, status: 'approved', startDate: '2026-11-18', endDate: '2026-11-18' }));
    render(<BookTimeForm me={ME} today={TODAY} requests={reqs} />);
    expect(within(screen.getByTestId('type-tiles')).getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual(['Working from home', 'Appointment', 'Vacation', 'Sick']);
    expect(screen.getByRole('button', { name: 'More types (3)' })).toBeInTheDocument();
  });

  test('only Site visit history: nothing ticked, Send disabled until the person picks what they are booking', async () => {
    const reqs = [4, 4].map((leaveTypeId, i) => ({ id: i + 1, leaveTypeId, status: 'approved', startDate: '2026-11-18', endDate: '2026-11-18' }));
    render(<BookTimeForm me={ME} today={TODAY} requests={reqs} />);
    for (const r of within(screen.getByTestId('type-tiles')).getAllByRole('radio')) expect(r).not.toBeChecked();
    expect(screen.getByTestId('booking-pick-type')).toHaveTextContent("Pick what you're booking");
    // A day alone does not make it sendable, and nothing is checked with the server.
    fireEvent.click(day(26));
    expect(send()).toBeDisabled();
    expect(screen.getByTestId('booking-pick-type')).toBeInTheDocument();
    await flushPreview();
    expect(api.preview).not.toHaveBeenCalled();
    // Picking the type (here from More types) makes it sendable.
    fireEvent.click(screen.getByRole('button', { name: /More types/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Site visit' }));
    expect(screen.queryByTestId('booking-pick-type')).toBeNull();
    fireEvent.change(screen.getByLabelText(/^Which office\?/), { target: { value: '1' } });
    await flushPreview();
    await waitFor(() => expect(send()).toBeEnabled());
  });

  test('history mostly among the four keeps the most-used one ticked, even with some More types use', () => {
    const reqs = [3, 3, 4].map((leaveTypeId, i) => ({ id: i + 1, leaveTypeId, status: 'approved', startDate: '2026-11-18', endDate: '2026-11-18' }));
    render(<BookTimeForm me={ME} today={TODAY} requests={reqs} />);
    expect(screen.getByRole('radio', { name: 'Sick' })).toBeChecked();
    expect(screen.queryByTestId('booking-pick-type')).toBeNull();
  });

  test('the four skip a type switched off in the workspace', () => {
    const me = { ...ME, leaveTypes: TYPES.map((t) => (t.key === 'appointment' ? { ...t, bookable: false } : t)) };
    render(<BookTimeForm me={me} today={TODAY} requests={[]} />);
    expect(within(screen.getByTestId('type-tiles')).getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual(['Working from home', 'Vacation', 'Sick', 'Site visit']);
    expect(screen.getByRole('button', { name: 'More types (2)' })).toBeInTheDocument();
  });

  test('Send is disabled until a day is picked; a range by clicking, highlighted end to end; the payload', async () => {
    const onBooked = vi.fn();
    render(<BookTimeForm me={ME} today={TODAY} requests={[]} onBooked={onBooked} toast={vi.fn()} />);
    expect(send()).toBeDisabled();
    expect(screen.getByTestId('booking-pick-first')).toHaveTextContent('Pick a day to continue');

    fireEvent.click(day(30));
    expect(screen.getByTestId('pick-summary')).toHaveTextContent('Mon 30 Nov · 1 working day · tap another day for a range');
    expect(screen.getByRole('radiogroup', { name: 'Part of the day' })).toBeInTheDocument();
    fireEvent.click(day(26)); // before the first: the ends swap
    expect(screen.getAllByRole('gridcell', { selected: true }).map((c) => c.dataset.day)).toEqual(['2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30']);
    expect(screen.getByTestId('pick-summary')).toHaveTextContent('Thu 26 – Mon 30 Nov · 3 working days');
    expect(screen.getByTestId('pick-spoken')).toHaveTextContent('Thu 26 to Mon 30 Nov, 3 working days');

    await flushPreview();
    expect(api.preview).toHaveBeenLastCalledWith({ leaveTypeId: 1, startDate: '2026-11-26', endDate: '2026-11-30', dayPart: 'full' });
    expect(await screen.findByTestId('request-check-amount')).toHaveTextContent('3 working days · Vacation ·');
    expect(screen.getByText('Goes to your approvers')).toBeInTheDocument();

    expect(send()).toBeEnabled();
    fireEvent.click(send());
    await waitFor(() => expect(api.createRequest).toHaveBeenCalledTimes(1));
    expect(api.createRequest.mock.calls[0][0]).toEqual({ leaveTypeId: 1, startDate: '2026-11-26', endDate: '2026-11-30', dayPart: 'full', note: undefined });
    // Reset, with a calm confirmation.
    expect(await screen.findByTestId('booking-sent')).toHaveTextContent('Vacation, Thu 26 – Mon 30 Nov: sent to your approvers.');
    expect(screen.queryAllByRole('gridcell', { selected: true })).toHaveLength(0);
    expect(send()).toBeDisabled();
    expect(onBooked).toHaveBeenCalled();
  });

  test('a single day and a range with the keyboard; a third pick starts over', () => {
    render(<BookTimeForm me={ME} today={TODAY} requests={[]} />);
    const cell = day(25);
    cell.focus();
    fireEvent.keyDown(cell, { key: 'ArrowRight' });
    fireEvent.keyDown(document.activeElement, { key: 'Enter' });
    expect(screen.getAllByRole('gridcell', { selected: true }).map((c) => c.dataset.day)).toEqual(['2026-11-26']);
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement, { key: 'ArrowRight' });
    fireEvent.keyDown(document.activeElement, { key: 'Enter' });
    expect(screen.getByTestId('pick-spoken')).toHaveTextContent('Thu 26 Nov to Fri 4 Dec, 7 working days');
    fireEvent.keyDown(document.activeElement, { key: ' ' });
    expect(screen.getAllByRole('gridcell', { selected: true }).map((c) => c.dataset.day)).toEqual(['2026-12-04']);
  });

  test('Today, Tomorrow and Next week', () => {
    render(<BookTimeForm me={ME} today="2026-11-27" requests={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(screen.getByTestId('pick-summary')).toHaveTextContent(/^Fri 27 Nov · 1 working day/);
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }));
    expect(screen.getByTestId('pick-summary')).toHaveTextContent(/^Mon 30 Nov · 1 working day/); // the next working day
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    expect(screen.getByTestId('pick-summary')).toHaveTextContent('Mon 30 Nov – Fri 4 Dec · 5 working days');
  });

  test('half days on a range: Morning stays offered and is sent for every day', async () => {
    render(<BookTimeForm me={ME} today={TODAY} requests={[]} />);
    fireEvent.click(day(26));
    fireEvent.click(day(30));
    const parts = screen.getByRole('radiogroup', { name: 'Part of the day' });
    fireEvent.click(within(parts).getByRole('radio', { name: 'Morning' }));
    expect(screen.getByTestId('pick-summary')).toHaveTextContent('Thu 26 – Mon 30 Nov · 1.5 working days · mornings');
    fireEvent.click(day(27)); // a new pick keeps the part of the day
    fireEvent.click(day(30));
    expect(within(screen.getByRole('radiogroup', { name: 'Part of the day' })).getByRole('radio', { name: 'Morning' })).toBeChecked();
    await flushPreview();
    expect(api.preview).toHaveBeenLastCalledWith(expect.objectContaining({ startDate: '2026-11-27', endDate: '2026-11-30', dayPart: 'am' }));
    fireEvent.click(send());
    await waitFor(() => expect(api.createRequest).toHaveBeenCalledWith(expect.objectContaining({ startDate: '2026-11-27', endDate: '2026-11-30', dayPart: 'am' })));
  });

  test('the count comes from the server\'s check once it is back (a four-day week, say)', async () => {
    api.preview.mockResolvedValue({ data: { outcome: 'pending', days: 4, dates: [] } });
    render(<BookTimeForm me={ME} today={TODAY} requests={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    expect(screen.getByTestId('pick-summary')).toHaveTextContent('Mon 30 Nov – Fri 4 Dec · 5 working days');
    await flushPreview();
    await waitFor(() => expect(screen.getByTestId('pick-summary')).toHaveTextContent('Mon 30 Nov – Fri 4 Dec · 4 working days'));
    expect(screen.getByTestId('request-check-amount')).toHaveTextContent('4 working days · Vacation ·');
    // One polite live region for the card, saying the pick and the check.
    expect(screen.getByTestId('booking-live')).toHaveTextContent('Mon 30 Nov to Fri 4 Dec, 4 working days. 4 working days · Vacation · Goes to your approvers');
    // Two polite regions only: this one, and the calendar's month heading.
    expect([...document.querySelectorAll('[aria-live]')].map((n) => n.dataset.testid).sort()).toEqual(['booking-live', 'month-picker-month']);
  });

  test('past days can be picked for any type; when the type is not "after the fact" an approver confirms it, and the summary says so', () => {
    render(<BookTimeForm me={ME} today={TODAY} requests={[]} />);
    expect(day(20)).not.toHaveAttribute('aria-disabled');
    expect(day(20)).toHaveAccessibleName('Friday 20 November, past');
    expect(screen.getByRole('button', { name: /^Previous month/ })).toBeEnabled();
    // Pickable, so AA contrast: muted, not faded; and not shaded like a weekend (a past Sunday neither).
    expect(day(20).firstElementChild.className).toMatch(/(^|\s)text-muted-foreground(\s|$)/);
    expect(day(22).firstElementChild.className).not.toMatch(/bg-muted\/60/);
    expect(day(22)).toHaveAccessibleName('Sunday 22 November, past, weekend');
    expect(day(29).firstElementChild.className).toMatch(/bg-muted\/60/);
    fireEvent.click(day(20));
    expect(screen.getAllByRole('gridcell', { selected: true }).map((c) => c.dataset.day)).toEqual(['2026-11-20']);
    expect(screen.getByTestId('pick-past')).toHaveTextContent('It starts in the past, so an approver has to confirm it.');
    expect(send()).toBeEnabled();
    // Sick can be booked after the fact: no sentence.
    fireEvent.click(screen.getByRole('radio', { name: 'Sick' }));
    expect(screen.queryByTestId('pick-past')).toBeNull();
    expect(screen.getAllByRole('gridcell', { selected: true }).map((c) => c.dataset.day)).toEqual(['2026-11-20']);
  });

  test('the past-start sentence shows once, even when the server\'s check gives it as the reason', async () => {
    const PAST = 'It starts in the past, so an approver has to confirm it.';
    api.preview.mockResolvedValue({ data: { outcome: 'pending', days: 1, dates: [], reason: PAST, remaining: 4 } });
    render(<BookTimeForm me={ME} today={TODAY} requests={[]} />);
    fireEvent.click(day(20));
    await flushPreview();
    await screen.findByTestId('request-check-amount');
    // Seen once (the line under the summary); the live region says it once for screen readers.
    const seen = screen.getAllByText(PAST, { exact: false }).filter((el) => !el.closest('.sr-only, [hidden]'));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveAttribute('data-testid', 'pick-past');
    expect(screen.getByTestId('booking-live').textContent.split(PAST)).toHaveLength(2);
    expect(screen.getByTestId('availability-verdict')).toHaveTextContent('4 left after this');
    expect(screen.getByTestId('availability-verdict')).not.toHaveTextContent(PAST);
  });

  test('typing a note does not re-run the check: the footer, the label and Send stay as they are', async () => {
    api.preview.mockResolvedValue({ data: { outcome: 'approved', days: 1, dates: [] } });
    render(<BookTimeForm me={ME} today={TODAY} requests={[]} />);
    fireEvent.click(day(26));
    await flushPreview();
    expect(await screen.findByText('Will be approved automatically')).toBeInTheDocument();
    const calls = api.preview.mock.calls.length;
    const live = screen.getByTestId('booking-live').textContent;
    fireEvent.change(screen.getByLabelText(/3\. Note/), { target: { value: 'Back by noon' } });
    expect(screen.queryByText('Checking…')).toBeNull();
    expect(screen.getByText('Will be approved automatically')).toBeInTheDocument();
    expect(send()).toBeEnabled();
    expect(screen.getByTestId('booking-live').textContent).toBe(live);
    await flushPreview();
    expect(api.preview.mock.calls.length).toBe(calls);
    expect(api.preview.mock.calls.at(-1)[0]).not.toHaveProperty('note');
  });

  test('changing a waiting request that has already started: opens on its range, and the end can be moved', async () => {
    api.updateRequest.mockResolvedValue({ data: { id: 77, status: 'pending' } });
    // Vacation Mon 23 – Fri 27 Nov, still waiting; today is Wed 25.
    const started = { id: 77, leaveTypeId: 1, startDate: '2026-11-23', endDate: '2026-11-27', dayPart: 'full', status: 'pending', source: 'app', editable: true, waitingOn: [{ email: 'robin@example.com', name: 'Robin Vale' }] };
    render(<BookTimeForm me={ME} today={TODAY} requests={[started]} editing={started} onStopEditing={vi.fn()} onBooked={vi.fn()} toast={vi.fn()} />);
    expect(screen.getAllByRole('gridcell', { selected: true }).map((c) => c.dataset.day)).toEqual(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27']);
    expect(screen.getByText(/Now: Vacation, Mon 23 – Fri 27 Nov · waiting for Robin Vale/)).toBeInTheDocument();
    expect(day(23)).not.toHaveAttribute('aria-disabled');
    // Monday, then Thursday: the same request, ending a day earlier.
    fireEvent.click(day(23));
    fireEvent.click(day(26));
    expect(screen.getAllByRole('gridcell', { selected: true }).map((c) => c.dataset.day)).toEqual(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26']);
    expect(screen.getByTestId('pick-past')).toHaveTextContent('It starts in the past, so an approver has to confirm it.');
    await flushPreview();
    expect(api.preview).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: 77, startDate: '2026-11-23', endDate: '2026-11-26' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send changes for approval' }));
    await waitFor(() => expect(api.updateRequest).toHaveBeenCalledWith(77, expect.objectContaining({ startDate: '2026-11-23', endDate: '2026-11-26', dayPart: 'full' })));
  });

  test('booked days carry a dot with words, from the person\'s approved and waiting requests', () => {
    const reqs = [
      { id: 9, leaveTypeId: 2, status: 'approved', startDate: TODAY, endDate: TODAY },
      { id: 10, leaveTypeId: 1, status: 'cancelled', startDate: '2026-11-26', endDate: '2026-11-26' },
    ];
    render(<BookTimeForm me={ME} today={TODAY} requests={reqs} />);
    expect(day(25)).toHaveAccessibleName(/Working from home booked/);
    expect(day(26)).not.toHaveAccessibleName(/booked/);
  });

  test('a site visit needs an office before it is sent', async () => {
    render(<BookTimeForm me={ME} today={TODAY} requests={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /More types/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Site visit' }));
    expect(screen.getByLabelText(/^Which office\?/)).toBeRequired();
    fireEvent.click(day(26));
    await flushPreview();
    fireEvent.click(send());
    expect(await screen.findByRole('alert')).toHaveTextContent('Pick which office the site visit is at');
    expect(api.createRequest).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/^Which office\?/), { target: { value: '2' } });
    fireEvent.click(send());
    await waitFor(() => expect(api.createRequest).toHaveBeenCalledWith(expect.objectContaining({ leaveTypeId: 4, siteOfficeId: 2, startDate: '2026-11-26' })));
  });

  test('a required note is labelled so, and an empty one stops the send with an error under it', async () => {
    render(<BookTimeForm me={ME} today={TODAY} requests={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /More types/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Bereavement' }));
    const note = screen.getByLabelText(/3\. Note/);
    expect(note.labels[0]).toHaveTextContent('3. Note (required)');
    fireEvent.click(day(26));
    await flushPreview();
    fireEvent.click(send());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Bereavement needs a note');
    expect(note).toHaveAttribute('aria-invalid', 'true');
    expect(note).toHaveAccessibleDescription('Bereavement needs a note');
    expect(api.createRequest).not.toHaveBeenCalled();
    fireEvent.change(note, { target: { value: 'Family funeral' } });
    fireEvent.click(send());
    await waitFor(() => expect(api.createRequest).toHaveBeenCalledWith(expect.objectContaining({ leaveTypeId: 6, note: 'Family funeral' })));
  });

  test('an hours type picks one day and asks for the times', async () => {
    render(<BookTimeForm me={ME} today={TODAY} requests={[]} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Appointment' }));
    expect(screen.getByRole('grid')).not.toHaveAttribute('aria-multiselectable');
    expect(screen.queryByRole('button', { name: 'Next week' })).toBeNull();
    fireEvent.click(day(26));
    fireEvent.click(day(27));
    expect(screen.getAllByRole('gridcell', { selected: true }).map((c) => c.dataset.day)).toEqual(['2026-11-27']);
    fireEvent.change(screen.getByLabelText('End time'), { target: { value: '08:00' } });
    expect(send()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('End time'), { target: { value: '11:30' } });
    await flushPreview();
    expect(api.preview).toHaveBeenLastCalledWith(expect.objectContaining({ leaveTypeId: 7, startDate: '2026-11-27', endDate: '2026-11-27', dayPart: 'hours', startMinute: 540, endMinute: 690 }));
  });
});

describe('Coming up', () => {
  const ROWS = [
    { id: 1, leaveTypeId: 2, status: 'approved', startDate: TODAY, endDate: TODAY, dayPart: 'full', source: 'app', inVacationTracker: true },
    { id: 2, leaveTypeId: 1, status: 'cancelled', startDate: '2026-10-13', endDate: '2026-11-28', dayPart: 'full', source: 'app' },
    { id: 3, leaveTypeId: 1, status: 'denied', startDate: '2026-12-10', endDate: '2026-12-10', dayPart: 'full', source: 'app', decisionNote: 'Team is short' },
    { id: 4, leaveTypeId: 2, status: 'approved', startDate: '2026-11-18', endDate: '2026-11-18', dayPart: 'full', source: 'app' },
    { id: 5, leaveTypeId: 4, status: 'pending', startDate: '2026-12-02', endDate: '2026-12-02', dayPart: 'full', source: 'app', siteOfficeId: 2, editable: true, waitingOn: [{ email: 'robin@example.com', name: 'Robin Vale' }] },
    { id: 6, leaveTypeId: 1, status: 'approved', startDate: '2026-12-21', endDate: '2026-12-24', dayPart: 'full', source: 'vacation_tracker' },
  ];

  test('only approved and waiting requests that are not over: never cancelled, denied or past', () => {
    expect(upcomingRequests(ROWS, TODAY).map((r) => r.id)).toEqual([1, 5, 6]);
    render(<ComingUpCard requests={ROWS} typeById={typeById} offices={OFFICES} today={TODAY} onCancel={vi.fn()} />);
    expect(screen.getByTestId('coming-up-count')).toHaveTextContent('3 requests');
    const list = screen.getByTestId('coming-up-list');
    expect(within(list).getAllByRole('listitem').map((li) => li.dataset.testid)).toEqual(['coming-up-1', 'coming-up-5', 'coming-up-6']);
    expect(screen.queryByTestId('coming-up-2')).toBeNull(); // the cancelled vacation in the QA's screenshot
    expect(screen.queryByTestId('coming-up-3')).toBeNull();
    expect(screen.queryByTestId('coming-up-4')).toBeNull();
  });

  test('each row: the date (today), type · source, the office, status as a dot and a word', () => {
    render(<ComingUpCard requests={ROWS} typeById={typeById} offices={OFFICES} today={TODAY} onCancel={vi.fn()} onEdit={vi.fn()} />);
    const today = screen.getByTestId('coming-up-1');
    expect(today).toHaveTextContent('Wed 25 Nov (today)');
    expect(today).toHaveTextContent('Working from home · synced to Vacation Tracker');
    expect(today).toHaveTextContent('Approved');
    const site = screen.getByTestId('coming-up-5');
    expect(site).toHaveTextContent('Site visit · Toronto');
    expect(site).toHaveTextContent(/Waiting for approval\s*· Robin Vale/);
    expect(within(site).getByRole('button', { name: 'Change Site visit · Toronto, Wed 2 Dec' })).toBeInTheDocument();
    const vt = screen.getByTestId('coming-up-6');
    expect(vt).toHaveTextContent('Mon 21 – Thu 24 Dec');
    expect(vt).toHaveTextContent('Vacation · from Vacation Tracker');
    expect(vt).toHaveTextContent('back Fri');
  });

  test('cancel: the × asks first, inline, with the Vacation Tracker note; "Keep it" leaves it', async () => {
    const onCancel = vi.fn().mockResolvedValue();
    render(<ComingUpCard requests={ROWS} typeById={typeById} offices={OFFICES} today={TODAY} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Vacation, Mon 21 – Thu 24 Dec' }));
    const confirm = screen.getByRole('group', { name: 'Confirm cancel' });
    expect(confirm).toHaveTextContent('Cancel vacation for Mon 21 – Thu 24 Dec?');
    expect(confirm).toHaveTextContent('It came from Vacation Tracker');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep it' }));
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Vacation, Mon 21 – Thu 24 Dec' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ id: 6 })));
  });

  test('admins: "Past and cancelled requests are in History" opens the History tab', () => {
    const onOpenHistory = vi.fn();
    render(<ComingUpCard requests={ROWS} typeById={typeById} today={TODAY} onOpenHistory={onOpenHistory} historyHref="/availability/history" />);
    const link = screen.getByRole('link', { name: 'Past and cancelled requests are in History' });
    expect(link).toHaveAttribute('href', '/availability/history');
    // Ctrl/Cmd-click opens a new tab as usual: the page does not take it over.
    fireEvent.click(link, { ctrlKey: true });
    fireEvent.click(link, { metaKey: true });
    expect(onOpenHistory).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
  });

  test('everyone else: past and cancelled requests open folded under Coming up', () => {
    render(<ComingUpCard requests={ROWS} typeById={typeById} today={TODAY} />);
    expect(screen.queryByRole('link', { name: /History/ })).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Past and cancelled requests (3)' });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const past = screen.getByRole('list', { name: 'Past and cancelled requests' });
    expect(within(past).queryByRole('button', { name: /^Cancel/ })).toBeNull();
    fireEvent.click(within(past).getByRole('button', { name: 'Details for Vacation, Thu 10 Dec' }));
    expect(within(past).getByTestId('coming-up-3-details')).toHaveTextContent('Approver: Team is short');
  });

  test('each row opens to its details: amount, the note, why it waits, the rules\' words, the approver\'s note', () => {
    const rows = [
      { id: 21, leaveTypeId: 1, status: 'pending', startDate: '2026-12-07', endDate: '2026-12-09', dayPart: 'full', days: 3, hours: 24, source: 'app', note: 'Family visit', decision: { reason: 'Vacation needs approval.', fired: [{ ruleId: 4, name: 'Busy week', message: 'Two others are away that week.' }] } },
      { id: 22, leaveTypeId: 7, status: 'approved', startDate: '2026-12-01', endDate: '2026-12-01', dayPart: 'hours', startMinute: 540, endMinute: 660, days: 0.25, hours: 2, source: 'app', decisionNote: 'Fine by me', decision: { reason: 'Approved by Robin Vale' } },
    ];
    render(<ComingUpCard requests={rows} typeById={typeById} today={TODAY} onCancel={vi.fn()} />);
    const waiting = screen.getByTestId('coming-up-21');
    const toggle = within(waiting).getByRole('button', { name: 'Details for Vacation, Mon 7 – Wed 9 Dec' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const d1 = screen.getByTestId('coming-up-21-details');
    expect(d1).toHaveTextContent('Amount: 3 days');
    expect(d1).toHaveTextContent('Your note: Family visit');
    expect(d1).toHaveTextContent('Why it is waiting: Vacation needs approval.');
    expect(d1).toHaveTextContent('Two others are away that week.');
    fireEvent.click(within(screen.getByTestId('coming-up-22')).getByRole('button', { name: /^Details for Appointment/ }));
    const d2 = screen.getByTestId('coming-up-22-details');
    expect(d2).toHaveTextContent('Amount: 2 hours');
    expect(d2).toHaveTextContent('Why: Approved by Robin Vale');
    expect(d2).toHaveTextContent('Approver: Fine by me');
  });

  test('a "·" never starts a wrapped line: each dot is glued to the word before it', () => {
    const rows = [...ROWS, { id: 9, leaveTypeId: 1, status: 'pending', startDate: '2026-12-16', endDate: '2026-12-16', dayPart: 'full', source: 'app', waitingOn: [{ email: 'robin@example.com', name: 'Robin Vale' }] }];
    render(<ComingUpCard requests={rows} typeById={typeById} offices={OFFICES} today={TODAY} onCancel={vi.fn()} />);
    const text = (id) => screen.getByTestId(id).textContent;
    // A no-break space before every dot, a plain space after: the line can only break after a dot.
    expect(text('coming-up-1-what')).toBe('Working from home · synced to Vacation Tracker');
    // 26 Nov 2026: the date comes with the day ("back Thu 17 Dec"), and a name or a date never
    // splits across lines (no-break spaces inside it).
    expect(text('coming-up-9-status')).toBe('Waiting for approval\u00A0· Robin\u00A0Vale\u00A0· back\u00A0Thu\u00A017\u00A0Dec');
    for (const id of ['coming-up-1-what', 'coming-up-6-what', 'coming-up-6-status', 'coming-up-9-status']) {
      expect(text(id)).not.toMatch(/[ \n\t]·/);
    }
    // The status dot is an inline box, so its trailing dot sits inside the same no-wrap span.
    const status = screen.getByTestId('coming-up-9-status').firstElementChild;
    expect(status).toHaveClass('whitespace-nowrap');
    expect(status.textContent).toBe('Waiting for approval ·');
  });

  test('a cancelled Vacation Tracker leave still there stays in view, saying what to do', () => {
    const rows = [...ROWS, { id: 8, leaveTypeId: 1, status: 'cancelled', startDate: '2026-12-14', endDate: '2026-12-15', dayPart: 'full', source: 'vacation_tracker', stillInVacationTracker: true }];
    render(<ComingUpCard requests={rows} typeById={typeById} today={TODAY} onOpenHistory={vi.fn()} historyHref="/availability/history" />);
    const box = screen.getByTestId('coming-up-still-in-vt');
    expect(within(box).getByTestId('still-in-vt-8')).toHaveTextContent('Cancelled in Ticket Pulse. Cancel it in Vacation Tracker too.');
    expect(screen.getByTestId('coming-up-count')).toHaveTextContent('3 requests');
  });

  test('empty, and at most five before "Show N more"', () => {
    const { unmount } = render(<ComingUpCard requests={[]} typeById={typeById} today={TODAY} />);
    expect(screen.getByText('Nothing booked yet.')).toBeInTheDocument();
    unmount();
    const many = Array.from({ length: 7 }, (_, i) => ({ id: 100 + i, leaveTypeId: 2, status: 'approved', startDate: `2026-12-0${i + 1}`, endDate: `2026-12-0${i + 1}`, source: 'app' }));
    render(<ComingUpCard requests={many} typeById={typeById} today={TODAY} />);
    expect(within(screen.getByTestId('coming-up-list')).getAllByRole('listitem')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more' }));
    expect(within(screen.getByTestId('coming-up-list')).getAllByRole('listitem')).toHaveLength(7);
  });
});

describe('My time, the page', () => {
  test('booking beside Coming up; the long "My requests" list is gone; nothing forces a phone to scroll sideways', async () => {
    window.innerWidth = 390;
    api.myRequests.mockResolvedValue({ data: [
      { id: 1, leaveTypeId: 2, status: 'approved', startDate: '2099-12-02', endDate: '2099-12-02', dayPart: 'full', source: 'app' },
      { id: 2, leaveTypeId: 1, status: 'cancelled', startDate: '2099-12-10', endDate: '2099-12-12', dayPart: 'full', source: 'app' },
    ] });
    const withBalance = { ...ME, balances: [{ leaveTypeId: 1, name: 'Vacation', year: 2026, entitled: 10, adjustments: 0, taken: 0, scheduled: 0, pending: 0, remaining: 10 }] };
    const { container } = render(<MyTimePanel me={withBalance} toast={vi.fn()} onChanged={vi.fn()} />);
    expect(await screen.findByTestId('coming-up-1')).toBeInTheDocument();
    // QA 11-26 #1: no balances strip ("10 days left") here; the Overview has it.
    expect(screen.queryByTestId('availability-balances')).toBeNull();
    expect(screen.queryByText(/days? left/)).toBeNull();
    // The calendar spans the booking card: full width, no fixed narrow box beside other content.
    const cal = screen.getByTestId('when-calendar');
    expect(cal.className).toMatch(/(^|\s)w-full(\s|$)/);
    expect(cal.className).not.toMatch(/w-\[20rem\]/);
    expect(cal).toContainElement(screen.getByRole('grid'));
    expect(screen.getByRole('grid').className).toMatch(/(^|\s)w-full(\s|$)/);
    expect(screen.getByTestId('when-layout').className).not.toMatch(/sm:flex-row/);
    // Seven equal columns across the card.
    expect(screen.getByRole('grid').className).toMatch(/table-fixed/);
    expect(within(screen.getByRole('grid')).getAllByRole('columnheader')).toHaveLength(7);
    // A real day (the 15th, never a filler cell): rows stay modest from sm up (40 px),
    // not the oversized calendar of before, and its face widens with the column.
    const fifteenth = screen.getByRole('gridcell', { name: /^\w+ 15 / });
    expect(fifteenth).toHaveAttribute('data-day');
    expect(fifteenth.className).toMatch(/(^|\s)sm:h-10(\s|$)/);
    expect(fifteenth.className).toMatch(/(^|\s)h-11(\s|$)/);
    expect(fifteenth.firstElementChild.className).toMatch(/(^|\s)sm:max-w-\[4\.5rem\](\s|$)/);
    expect(screen.queryByTestId('coming-up-2')).toBeNull();
    expect(screen.queryByRole('region', { name: 'My requests' })).toBeNull();
    // One column until lg; the booking card comes first.
    const cols = screen.getByTestId('my-time-columns');
    expect(cols.className).toMatch(/lg:grid-cols-\[minmax\(0,2fr\)_minmax\(0,1fr\)\]/);
    expect(cols.className).not.toMatch(/(^|\s)grid-cols-/);
    expect(cols.firstElementChild).toContainElement(screen.getByRole('form', { name: 'Book time away' }));
    // No fixed widths wider than a phone, no sideways scrollers.
    const classes = [...container.querySelectorAll('[class]')].map((el) => el.getAttribute('class')).join(' ');
    expect(classes).not.toMatch(/overflow-x-(auto|scroll)/);
    expect(classes).not.toMatch(/(^|\s)(min-)?w-\[(\d{3,}px|(2[5-9]|[3-9]\d)rem)\]/);
    expect(classes).not.toMatch(/(^|\s)w-(9[6-9]|\d{3,})(\s|$)/);
    // The footer with Send stays reachable: sticky above the tab bar and the safe area.
    expect(screen.getByTestId('booking-footer').className).toMatch(/sticky/);
    expect(screen.getByTestId('booking-footer').className).toMatch(/safe-area-inset-bottom/);
    // Calendar tap targets are at least 40 px tall (checked on the 15th above: h-11 on a phone, sm:h-10 up).
  });
});
