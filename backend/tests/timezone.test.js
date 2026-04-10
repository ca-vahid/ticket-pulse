import {
  formatDateInTimezone,
  getLocalDateBounds,
  getTodayRange,
} from '../src/utils/timezone.js';

describe('timezone helpers', () => {
  test('resolves Vancouver local date correctly when UTC is already the next day', () => {
    const reference = new Date('2026-04-10T02:30:00.000Z');

    expect(formatDateInTimezone(reference, 'America/Vancouver')).toBe('2026-04-09');
  });

  test('getLocalDateBounds returns UTC-midnight bounds for DATE-column matching', () => {
    const reference = new Date('2026-04-10T02:30:00.000Z');
    const { start, end, dateStr } = getLocalDateBounds('America/Vancouver', reference);

    expect(dateStr).toBe('2026-04-09');
    expect(start.toISOString()).toBe('2026-04-09T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-04-09T23:59:59.999Z');
  });

  test('getTodayRange returns timezone-aware UTC bounds for timestamp queries', () => {
    const reference = new Date('2026-04-10T02:30:00.000Z');
    const { start, end } = getTodayRange('America/Vancouver', reference);

    expect(start.toISOString()).toBe('2026-04-09T07:00:00.000Z');
    expect(end.toISOString()).toBe('2026-04-10T06:59:59.999Z');
  });
});
