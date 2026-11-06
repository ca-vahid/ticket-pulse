/** @vitest-environment jsdom */
import { beforeEach, describe, expect, test } from 'vitest';
import { agoWords, formatPacificFull, formatPacificWhen, isRecent, whenOnce } from './ticketDates';
import { isTicketListPath, readTicketList, rememberTicketList } from './lastTicketList';

const NOW = new Date('2026-11-05T20:00:00Z'); // Thu 5 Nov 2026, midday in BC

describe('ticket header dates (QA 11-05 #7)', () => {
  test('Pacific weekday-day-month with the time; the year only off-year', () => {
    expect(formatPacificWhen('2026-10-20T16:14:00Z', NOW)).toBe('Tue 20 Oct, 9:14 AM');
    // 00:30 UTC on the 21st is still the 20th in Vancouver.
    expect(formatPacificWhen('2026-10-21T00:30:00Z', NOW)).toBe('Tue 20 Oct, 5:30 PM');
    expect(formatPacificWhen('2025-12-31T18:00:00Z', NOW)).toBe('Wed 31 Dec 2025, 10:00 AM');
    expect(formatPacificWhen(null)).toBe('—');
  });

  test('tooltip has the year and the zone', () => {
    // (Dates before 1 Nov 2026 only: BC's permanent-time switch changes the
    // zone name and offset after that, depending on the runtime's tzdata.)
    expect(formatPacificFull('2026-10-20T16:14:00Z')).toBe('Tue 20 Oct 2026, 9:14 AM PDT');
  });

  test('ages in words', () => {
    const at = (ms) => new Date(NOW.getTime() - ms).toISOString();
    expect(agoWords(at(10 * 1000), NOW.getTime())).toBe('just now');
    expect(agoWords(at(5 * 60 * 1000), NOW.getTime())).toBe('5 min ago');
    expect(agoWords(at(2 * 3600 * 1000), NOW.getTime())).toBe('2 h ago');
    expect(agoWords(at(26 * 3600 * 1000), NOW.getTime())).toBe('1 day ago');
    expect(agoWords('2026-10-20T16:14:00Z', NOW.getTime())).toBe('16 days ago');
    expect(agoWords('2026-05-01T16:14:00Z', NOW.getTime())).toBe('6 months ago');
  });

  test('one reading: relative while recent, the date after a day', () => {
    const twoHours = new Date(NOW.getTime() - 2 * 3600 * 1000).toISOString();
    expect(isRecent(twoHours, NOW.getTime())).toBe(true);
    expect(whenOnce(twoHours, NOW.getTime())).toBe('2 h ago');
    expect(whenOnce('2026-10-22T20:05:00Z', NOW.getTime())).toBe('Thu 22 Oct, 1:05 PM');
  });
});

describe('last ticket list (QA 11-05 #4)', () => {
  beforeEach(() => sessionStorage.clear());

  test('only list addresses count', () => {
    expect(isTicketListPath('/tickets')).toBe(true);
    expect(isTicketListPath('/tickets?status=Open')).toBe(true);
    expect(isTicketListPath('/tickets/123')).toBe(false);
    expect(isTicketListPath('/dashboard')).toBe(false);
    rememberTicketList(1, '/tickets/123');
    expect(readTicketList(1)).toBeNull();
  });

  test('kept per workspace, without the peek preview', () => {
    rememberTicketList(1, '/tickets?status=Open&peek=9');
    rememberTicketList(2, '/tickets?status=Pending');
    expect(readTicketList(1)).toBe('/tickets?status=Open');
    expect(readTicketList(2)).toBe('/tickets?status=Pending');
    expect(readTicketList(4)).toBeNull();
  });
});
