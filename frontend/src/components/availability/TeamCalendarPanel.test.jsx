/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { fmtRange, nameFromEmail } from './availabilityUi';
import { describeCondition } from './admin/RulesSection';

// Team calendar cells: a half day fills half the cell, a pending entry is
// striped (dashed outline), weekends are skipped inside a multi-day range.

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const key = (d) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(d)}`;
// First Saturday of this month, and the Friday / Monday around it.
const firstSat = (() => { for (let d = 1; d <= 7; d += 1) if (new Date(now.getFullYear(), now.getMonth(), d).getDay() === 6) return d; return 6; })();
const sat = key(firstSat);
const mon = key(firstSat + 2);
const fri = firstSat > 1 ? key(firstSat - 1) : key(firstSat + 6);

const api = vi.hoisted(() => ({}));
Object.assign(api, {
  calendar: vi.fn(async () => ({ success: true, data: {
    people: [{ email: 'a@x.ca', name: 'Ann Lo' }, { email: 'b@x.ca', name: 'Bo Chen' }],
    entries: [
      { id: 1, email: 'a@x.ca', startDate: fri, endDate: fri, dayPart: 'am', status: 'approved', label: 'Vacation', color: 'emerald' },
      { id: 2, email: 'b@x.ca', startDate: firstSat > 1 ? fri : sat, endDate: mon, dayPart: 'full', status: 'pending', label: 'Training', color: 'violet' },
    ],
    holidays: [],
  } })),
  outToday: vi.fn(async () => ({ success: true, data: [] })),
});
vi.mock('../../services/api', () => ({ get availabilityAPI() { return api; } }));

const { default: TeamCalendarPanel } = await import('./TeamCalendarPanel');

afterEach(() => cleanup());

describe('TeamCalendarPanel', () => {
  test('half day, pending stripes, weekend skipped, nobody out today', async () => {
    render(<TeamCalendarPanel me={{ offices: [] }} />);
    const half = await screen.findByTestId(`cal-cell-a@x.ca-${fri}`);
    await waitFor(() => expect(half).toHaveAttribute('data-entry', 'Vacation'));
    expect(half.querySelector('span[aria-hidden="true"]').className).toContain('right-1/2');

    const pendingCell = screen.getByTestId(`cal-cell-b@x.ca-${mon}`);
    expect(pendingCell.querySelector('span[aria-hidden="true"]').className).toContain('border-dashed');
    expect(screen.getByTestId(`cal-cell-b@x.ca-${sat}`)).not.toHaveAttribute('data-entry');
    expect(await screen.findByText('Everyone is in today.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Approval group')).not.toBeInTheDocument();
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
