import { afterEach, describe, expect, test } from 'vitest';
import {
  formatHolidayDate,
  getDateStyling,
  getHolidayInfo,
  getHolidayTooltip,
  registerDynamicHolidays,
  toCalendarDateKey,
} from './holidays';

/**
 * Phase HD (QA 08-25 #3) — holidays util: UTC-safe date rendering and the
 * precedence flip (DB feed wins over the hardcoded 2025-2027 tables, which
 * remain an offline fallback for years the feed does not cover).
 */

afterEach(() => registerDynamicHolidays([]));

describe('formatHolidayDate / toCalendarDateKey — UTC-safe', () => {
  test('a DATE column serialized as UTC midnight keeps its calendar day in every timezone', () => {
    // The literal QA bug: "2025-09-01T00:00:00.000Z" rendered as 8/31 in Pacific.
    expect(toCalendarDateKey('2025-09-01T00:00:00.000Z')).toBe('2025-09-01');
    expect(formatHolidayDate('2025-09-01T00:00:00.000Z', 'en-US')).toBe('9/1/2025');
    expect(formatHolidayDate('2026-09-07T00:00:00.000Z', 'en-US')).toBe('9/7/2026');
    expect(formatHolidayDate('2025-12-25T00:00:00.000Z', 'en-US')).toBe('12/25/2025');
  });

  test('Date instances use their UTC calendar day; garbage stays visible rather than "Invalid Date"', () => {
    expect(toCalendarDateKey(new Date(Date.UTC(2026, 8, 7)))).toBe('2026-09-07');
    expect(toCalendarDateKey('not a date')).toBe('');
    expect(formatHolidayDate('not a date')).toBe('not a date');
    expect(formatHolidayDate(null)).toBe('');
  });
});

describe('precedence: DB feed wins, hardcoded tables are the fallback', () => {
  test('with no feed registered the hardcoded table still lights Labour Day 2026 (dashboard dots)', () => {
    const info = getHolidayInfo('2026-09-07');
    expect(info.isCanadian).toBe(true);
    expect(info.canadianName).toBe('Labour Day');
    expect(getDateStyling('2026-09-07').indicatorClass).toBe('bg-rose-500');
  });

  test('a CA feed row is authoritative for its date (name from the DB, styled as Canadian)', () => {
    registerDynamicHolidays([
      { name: 'Labour Day (from DB)', date: '2026-09-07T00:00:00.000Z', country: 'CA', isRecurring: false },
    ]);
    const info = getHolidayInfo('2026-09-07');
    expect(info.canadianName).toBe('Labour Day (from DB)');
    expect(info.isCanadian).toBe(true);
    expect(info.isDynamic).toBe(false);
    // The US table still contributes its own Labor Day for the same date (CA coverage never hides US).
    expect(getHolidayTooltip('2026-09-07')).toContain('🍁 Labour Day (from DB) (CA)');
  });

  test('once the feed covers a year, a hardcoded-only date in that year is NOT a holiday', () => {
    // Feed has 2026 (Labour Day only) → the table's Civic Holiday 2026-08-03 must not mask the DB.
    registerDynamicHolidays([
      { name: 'Labour Day', date: '2026-09-07T00:00:00.000Z', country: 'CA', isRecurring: false },
    ]);
    expect(getHolidayInfo('2026-08-03').isHoliday).toBe(false);
    // …while an uncovered year still falls back to the table.
    expect(getHolidayInfo('2027-09-06').canadianName).toBe('Labour Day');
    expect(getHolidayInfo('2025-09-01').canadianName).toBe('Labour Day');
  });

  test('recurring feed rows match on month-day across years', () => {
    registerDynamicHolidays([
      { name: 'Canada Day', date: '2025-07-01T00:00:00.000Z', country: 'CA', isRecurring: true },
      { name: 'Labour Day', date: '2026-09-07T00:00:00.000Z', country: 'CA', isRecurring: false },
    ]);
    expect(getHolidayInfo('2026-07-01').canadianName).toBe('Canada Day');
    expect(getHolidayInfo('2027-07-01').canadianName).toBe('Canada Day');
  });

  test('country-less custom rows stay the generic (violet) kind and never suppress the tables', () => {
    registerDynamicHolidays([
      { name: 'Office closure', date: '2026-03-13T00:00:00.000Z', country: null, isRecurring: false },
    ]);
    const custom = getHolidayInfo('2026-03-13');
    expect(custom.isDynamic).toBe(true);
    expect(custom.isCanadian).toBe(false);
    expect(getDateStyling('2026-03-13').indicatorClass).toBe('bg-violet-500');
    // No CA coverage registered → hardcoded CA table still applies for 2026.
    expect(getHolidayInfo('2026-09-07').canadianName).toBe('Labour Day');
  });

  test('disabled rows are ignored; CA coverage does not hide the US table', () => {
    registerDynamicHolidays([
      { name: 'Labour Day', date: '2026-09-07T00:00:00.000Z', country: 'CA', isRecurring: false },
      { name: 'Ghost', date: '2026-09-08T00:00:00.000Z', country: 'CA', isRecurring: false, isEnabled: false },
    ]);
    expect(getHolidayInfo('2026-09-08').isHoliday).toBe(false);
    expect(getHolidayInfo('2026-07-04').usName).toBe('Independence Day');
  });
});
