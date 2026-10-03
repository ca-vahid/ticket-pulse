import { afterEach, describe, expect, test, vi } from 'vitest';
import { nextWorkdayKey } from './availabilityUi';

// 3 Oct 2026: the booking form opened on a Saturday ("no working days").
describe('nextWorkdayKey', () => {
  afterEach(() => vi.useRealTimers());
  test('a Saturday or Sunday moves to Monday', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 3, 10, 0)); // Sat 3 Oct 2026
    expect(nextWorkdayKey()).toBe('2026-10-05');
    vi.setSystemTime(new Date(2026, 9, 4, 10, 0)); // Sun
    expect(nextWorkdayKey()).toBe('2026-10-05');
  });
  test('a weekday stays', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 7, 10, 0)); // Wed
    expect(nextWorkdayKey()).toBe('2026-10-07');
  });
});
