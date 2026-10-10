/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import UrgentClockLine, { URGENT_CLOCK_TICK_MS, urgentClockText } from './UrgentClockLine';

// Ticket page line for the Urgent "untouched" clock: plain words, a red dot,
// never a pill; refreshed every 30 seconds.

const NOW = Date.parse('2026-10-12T16:12:20Z');
const minutesAgo = (n) => new Date(NOW - n * 60000).toISOString();
const running = (extra = {}) => ({
  state: 'running', startedAt: minutesAgo(12), notifyAt: null, moveAt: null, notifiedAt: null, notifyMinutes: 15, moveMinutes: 30, ...extra,
});

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('UrgentClockLine', () => {
  test('running, before the team is told', () => {
    render(<UrgentClockLine clock={running()} />);
    const line = screen.getByRole('status');
    expect(line).toHaveTextContent('Urgent: untouched for about 12 min. The team is told at 15 min; it moves at 30 min.');
  });

  test('running, after the team was told', () => {
    render(<UrgentClockLine clock={running({ startedAt: minutesAgo(18), notifiedAt: minutesAgo(3) })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Urgent: untouched for about 18 min. The team has been told; it moves at 30 min.');
  });

  test('waiting: nobody is at work', () => {
    render(<UrgentClockLine clock={{ state: 'waiting', startedAt: minutesAgo(40), notifyMinutes: 15, moveMinutes: 30 }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Urgent: nobody is at work. It moves as soon as someone is.');
  });

  test('plain text with a dot, not a pill', () => {
    render(<UrgentClockLine clock={running()} />);
    const line = screen.getByTestId('urgent-clock-line');
    expect(line.className).not.toMatch(/rounded-full|border|bg-/);
    expect(line.querySelector('[aria-hidden="true"]').className).toMatch(/rounded-full/);
  });

  test('the minutes move on every 30 seconds', () => {
    render(<UrgentClockLine clock={running()} />);
    expect(screen.getByRole('status')).toHaveTextContent('about 12 min');
    act(() => { vi.advanceTimersByTime(URGENT_CLOCK_TICK_MS); });
    expect(screen.getByRole('status')).toHaveTextContent('about 12 min');
    act(() => { vi.advanceTimersByTime(URGENT_CLOCK_TICK_MS); });
    expect(screen.getByRole('status')).toHaveTextContent('about 13 min');
  });

  test('a waiting clock sets no timer, and the timer is cleared on unmount', () => {
    const waiting = render(<UrgentClockLine clock={{ state: 'waiting' }} />);
    expect(vi.getTimerCount()).toBe(0);
    waiting.unmount();
    const live = render(<UrgentClockLine clock={running()} />);
    expect(vi.getTimerCount()).toBe(1);
    live.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('nothing without a clock, or for a stopped one', () => {
    const { container, rerender } = render(<UrgentClockLine clock={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<UrgentClockLine clock={{ state: 'stopped', startedAt: minutesAgo(5) }} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('urgentClockText copes with missing numbers and clocks set ahead', () => {
    expect(urgentClockText({ state: 'running', startedAt: minutesAgo(-2), notifyMinutes: 15, moveMinutes: 30 }, NOW))
      .toBe('Urgent: untouched for about 0 min. The team is told at 15 min; it moves at 30 min.');
    expect(urgentClockText({ state: 'running', startedAt: minutesAgo(4) }, NOW))
      .toBe('Urgent: untouched for about 4 min. It moves if nobody touches it.');
  });
});
