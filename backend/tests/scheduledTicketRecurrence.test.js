import { jest } from '@jest/globals';

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { nextOccurrence } = await import('../src/services/scheduledTicketService.js');
const TZ = 'America/Los_Angeles';

describe('nextOccurrence', () => {
  test('weekly advances 7 days on the wall clock', () => {
    const from = new Date('2026-07-31T12:00:00.000Z'); // Fri Jul 31, 5:00 AM PDT
    const next = nextOccurrence(from, { recurrence: 'weekly' }, TZ);
    expect(next.toISOString()).toBe('2026-08-07T12:00:00.000Z');
  });

  test('monthly clamps day 31 to shorter months and springs back', () => {
    const from = new Date('2026-07-31T12:00:00.000Z'); // Jul 31, 5:00 AM PDT
    const aug = nextOccurrence(from, { recurrence: 'monthly', recurrenceDay: 31 }, TZ);
    expect(aug.toISOString()).toBe('2026-08-31T12:00:00.000Z');
    const sep = nextOccurrence(aug, { recurrence: 'monthly', recurrenceDay: 31 }, TZ);
    // September has 30 days — clamped, still 5:00 AM local
    expect(sep.toISOString()).toBe('2026-09-30T12:00:00.000Z');
    const oct = nextOccurrence(sep, { recurrence: 'monthly', recurrenceDay: 31 }, TZ);
    // Anchor day 31 restores once the month allows it
    expect(oct.toISOString()).toBe('2026-10-31T12:00:00.000Z');
  });

  test('monthly keeps the local time across a DST boundary', () => {
    const from = new Date('2026-10-17T16:00:00.000Z'); // Oct 17, 9:00 AM PDT
    const next = nextOccurrence(from, { recurrence: 'monthly', recurrenceDay: 17 }, TZ);
    // Nov 17 is PST (UTC-8): 9:00 AM local = 17:00Z, not 16:00Z
    expect(next.toISOString()).toBe('2026-11-17T17:00:00.000Z');
  });

  test('yearly fires on the anchored month/day the following year', () => {
    const from = new Date('2026-09-17T16:00:00.000Z'); // Sep 17, 9:00 AM PDT
    const next = nextOccurrence(from, { recurrence: 'yearly', recurrenceDay: 17, recurrenceMonth: 9 }, TZ);
    expect(next.toISOString()).toBe('2027-09-17T16:00:00.000Z');
  });

  test("'none' and unknown recurrences yield null", () => {
    expect(nextOccurrence(new Date(), { recurrence: 'none' }, TZ)).toBeNull();
    expect(nextOccurrence(new Date(), { recurrence: 'sometimes' }, TZ)).toBeNull();
  });
});
