/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { describeCondition } from './RulesSection';
import MyRequestsList from '../MyRequestsList';

vi.mock('../../../services/api', () => ({ availabilityAPI: {} }));

// 3 Oct 2026: WFH rules (this week and next, 1 day a week, office caps) and
// leave synced from Vacation Tracker.
afterEach(() => cleanup());

describe('describeCondition', () => {
  test('booking window', () => {
    expect(describeCondition({ kind: 'booking_window', weeksAhead: 1 })).toBe('booked beyond this week and next');
    expect(describeCondition({ kind: 'booking_window', weeksAhead: 0 })).toBe('booked beyond this week');
    expect(describeCondition({ kind: 'booking_window', weeksAhead: 3 })).toBe('booked beyond this week and the next 3 weeks');
  });
  test('per person and office limits', () => {
    expect(describeCondition({ kind: 'per_person', window: 'week', maxDays: 1 })).toBe('more than 1 day per week for one person');
    expect(describeCondition({ kind: 'capacity', window: 'day', max: 1, scope: 'office', officeMax: { 7: 3 } }))
      .toBe('more than 1 away per day in the office (1 office with their own limit)');
  });
});

describe('MyRequestsList', () => {
  const types = [{ id: 1, name: 'Vacation', color: 'emerald', unit: 'day' }];
  const base = { leaveTypeId: 1, startDate: '2099-03-02', endDate: '2099-03-06', dayPart: 'full', days: 5, hours: 40, status: 'approved', decision: null };
  test('leave from Vacation Tracker is labelled and cannot be cancelled here', () => {
    render(<MyRequestsList requests={[{ ...base, id: 1, source: 'vacation_tracker' }, { ...base, id: 2, source: 'app', startDate: '2099-04-06', endDate: '2099-04-06' }]} typeById={new Map(types.map((t) => [t.id, t]))} onCancel={vi.fn()} />);
    const vt = screen.getByTestId('my-request-1');
    expect(vt).toHaveTextContent('Vacation Tracker');
    expect(vt.querySelector('button')?.textContent || '').not.toMatch(/Cancel/);
    expect(screen.getByTestId('my-request-2')).toHaveTextContent('Cancel');
  });
});
