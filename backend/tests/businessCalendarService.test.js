import { jest } from '@jest/globals';

/**
 * Phase SLA (QA 08-17 #9) — businessCalendarService.addBusinessMinutes /
 * nextBusinessInstant: the walker that makes SLA clocks skip weekends,
 * disabled days and holidays. All expectations are exact UTC instants
 * computed by hand from the America/Los_Angeles calendar (PDT = UTC-7,
 * PST = UTC-8; 2026 DST: spring forward Mar 8, fall back Nov 1).
 */

const prismaMock = {
  businessHour: { findMany: jest.fn() },
  holiday: { findMany: jest.fn() },
  workspace: { findUnique: jest.fn() },
};
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));

const { default: businessCalendarService, MAX_WALK_DAYS } = await import('../src/services/businessCalendarService.js');

// Mon–Fri 09:00–17:00 Pacific — the seeded default calendar.
const WEEKDAYS_9_5 = [1, 2, 3, 4, 5].map((dayOfWeek) => ({
  dayOfWeek, startTime: '09:00', endTime: '17:00', isEnabled: true, timezone: 'America/Los_Angeles',
}));

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.businessHour.findMany.mockResolvedValue(WEEKDAYS_9_5);
  prismaMock.holiday.findMany.mockResolvedValue([]);
  prismaMock.workspace.findUnique.mockResolvedValue({ defaultTimezone: 'America/Los_Angeles' });
});

const add = (fromIso, minutes) => businessCalendarService.addBusinessMinutes(new Date(fromIso), minutes, { workspaceId: 1 });
const addDays = (fromIso, minutes) => businessCalendarService.addBusinessDayMinutes(new Date(fromIso), minutes, { workspaceId: 1 });

describe('addBusinessMinutes — core walk', () => {
  test('stays inside the same day when the window has room', async () => {
    // Tue 2026-08-18 10:00 PDT (17:00Z) + 90m → 11:30 PDT.
    expect((await add('2026-08-18T17:00:00.000Z', 90)).toISOString()).toBe('2026-08-18T18:30:00.000Z');
  });

  test('weekend spillover: Friday-late minutes land Monday morning', async () => {
    // Fri 2026-08-21 16:00 PDT + 120m: 60 consumed Fri, 60 land Mon 09:00 → Mon 10:00 PDT (17:00Z).
    expect((await add('2026-08-21T23:00:00.000Z', 120)).toISOString()).toBe('2026-08-24T17:00:00.000Z');
  });

  test('start outside hours: weekend start snaps to Monday open', async () => {
    // Sat 2026-08-22 12:00 PDT + 60m → Mon 09:00 + 60m = 10:00 PDT.
    expect((await add('2026-08-22T19:00:00.000Z', 60)).toISOString()).toBe('2026-08-24T17:00:00.000Z');
  });

  test('start before open on a business day snaps to that day\'s open', async () => {
    // Wed 2026-08-19 07:00 PDT (14:00Z) + 30m → 09:30 PDT (16:30Z).
    expect((await add('2026-08-19T14:00:00.000Z', 30)).toISOString()).toBe('2026-08-19T16:30:00.000Z');
  });

  test('minutes larger than a week walk across multiple weekends', async () => {
    // Mon 2026-08-17 09:00 PDT + 2460m (5 full 480m days + 60) →
    // consumes Mon–Fri entirely, lands next Mon 10:00 PDT (2026-08-24T17:00Z).
    expect((await add('2026-08-17T16:00:00.000Z', 2460)).toISOString()).toBe('2026-08-24T17:00:00.000Z');
  });
});

describe('addBusinessMinutes — holidays', () => {
  test('an exact-date holiday is skipped', async () => {
    // Monday 2026-08-24 is a holiday → Friday-late spillover lands Tuesday.
    prismaMock.holiday.findMany.mockResolvedValue([
      { date: new Date('2026-08-24T00:00:00.000Z'), isRecurring: false },
    ]);
    expect((await add('2026-08-21T23:00:00.000Z', 120)).toISOString()).toBe('2026-08-25T17:00:00.000Z');
  });

  test('a recurring holiday matches by month-day across years', async () => {
    // Stored 2024-08-24, recurring → blocks Monday 2026-08-24 too.
    prismaMock.holiday.findMany.mockResolvedValue([
      { date: new Date('2024-08-24T00:00:00.000Z'), isRecurring: true },
    ]);
    expect((await add('2026-08-21T23:00:00.000Z', 120)).toISOString()).toBe('2026-08-25T17:00:00.000Z');
  });
});

describe('addBusinessMinutes — DST boundaries', () => {
  test('spring forward (Mar 8 2026): Monday hours use the PDT offset', async () => {
    // Fri 2026-03-06 16:30 PST (-08 → 00:30Z Sat) + 60m: 30 Fri, 30 Mon
    // 2026-03-09 09:00 PDT (-07 → 16:00Z) + 30m = 16:30Z.
    expect((await add('2026-03-07T00:30:00.000Z', 60)).toISOString()).toBe('2026-03-09T16:30:00.000Z');
  });

  test('fall back (Nov 1 2026): Monday hours use the PST offset', async () => {
    // Fri 2026-10-30 16:30 PDT (-07 → 23:30Z) + 60m: 30 Fri, 30 Mon
    // 2026-11-02 09:00 PST (-08 → 17:00Z) + 30m = 17:30Z.
    expect((await add('2026-10-30T23:30:00.000Z', 60)).toISOString()).toBe('2026-11-02T17:30:00.000Z');
  });
});

describe('addBusinessMinutes — fallbacks', () => {
  test('zero enabled business-hour days → pure wall-clock', async () => {
    prismaMock.businessHour.findMany.mockResolvedValue([]);
    expect((await add('2026-08-21T23:00:00.000Z', 120)).toISOString()).toBe('2026-08-22T01:00:00.000Z');
  });

  test('walk cap: zero-width windows exhaust the cap and fall back to wall-clock', async () => {
    prismaMock.businessHour.findMany.mockResolvedValue([
      { dayOfWeek: 1, startTime: '09:00', endTime: '09:00', isEnabled: true, timezone: 'America/Los_Angeles' },
    ]);
    expect((await add('2026-08-18T17:00:00.000Z', 60)).toISOString()).toBe('2026-08-18T18:00:00.000Z');
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('walk exceeded cap'),
      expect.objectContaining({ capDays: MAX_WALK_DAYS }),
    );
  });

  test('timezone falls back to the workspace default when rows carry none', async () => {
    prismaMock.businessHour.findMany.mockResolvedValue(
      WEEKDAYS_9_5.map((h) => ({ ...h, timezone: null })),
    );
    prismaMock.workspace.findUnique.mockResolvedValue({ defaultTimezone: 'America/New_York' });
    // Tue 2026-08-18 10:00 EDT (14:00Z) + 60m → 11:00 EDT (15:00Z).
    expect((await add('2026-08-18T14:00:00.000Z', 60)).toISOString()).toBe('2026-08-18T15:00:00.000Z');
  });
});

describe('nextBusinessInstant', () => {
  test('identity when already inside business hours', async () => {
    const from = new Date('2026-08-18T17:00:00.000Z'); // Tue 10:00 PDT
    expect((await businessCalendarService.nextBusinessInstant(from, { workspaceId: 1 })).toISOString())
      .toBe('2026-08-18T17:00:00.000Z');
  });

  test('weekend start rolls to Monday open', async () => {
    const from = new Date('2026-08-22T19:00:00.000Z'); // Sat noon PDT
    expect((await businessCalendarService.nextBusinessInstant(from, { workspaceId: 1 })).toISOString())
      .toBe('2026-08-24T16:00:00.000Z'); // Mon 09:00 PDT
  });

  test('after close rolls to the next day open', async () => {
    const from = new Date('2026-08-19T00:30:00.000Z'); // Tue 17:30 PDT
    expect((await businessCalendarService.nextBusinessInstant(from, { workspaceId: 1 })).toISOString())
      .toBe('2026-08-19T16:00:00.000Z'); // Wed 09:00 PDT
  });
});

/**
 * QA 09-17 #1 — addBusinessDayMinutes: a 24-hour clock that skips whole
 * non-working days. Project Accounting's actual ask: "a ticket that arrives
 * 2pm Friday should be due Monday 2pm". addBusinessMinutes would answer
 * Wednesday, because it only counts the 8 hours inside the window.
 */
describe('addBusinessDayMinutes — whole-day clock', () => {
  test('the Friday-afternoon case QA asked about: Fri 2pm + 24h = Mon 2pm', async () => {
    // Fri 2026-08-21 14:00 PDT (21:00Z) + 1440m -> Mon 2026-08-24 14:00 PDT.
    expect((await addDays('2026-08-21T21:00:00.000Z', 1440)).toISOString()).toBe('2026-08-24T21:00:00.000Z');
  });

  test('stays inside the same day when the minutes fit', async () => {
    // Tue 2026-08-18 10:00 PDT + 180m -> 13:00 PDT, same day.
    expect((await addDays('2026-08-18T17:00:00.000Z', 180)).toISOString()).toBe('2026-08-18T20:00:00.000Z');
  });

  test('counts hours OUTSIDE business hours on a working day', async () => {
    // Tue 2026-08-18 20:00 PDT (past 17:00 close) + 120m -> Tue 22:00 PDT.
    // addBusinessMinutes would push this to Wednesday morning.
    expect((await addDays('2026-08-19T03:00:00.000Z', 120)).toISOString()).toBe('2026-08-19T05:00:00.000Z');
  });

  test('a start on a non-working day begins at the next working midnight', async () => {
    // Sat 2026-08-22 12:00 PDT + 60m -> Mon 2026-08-24 00:00 PDT + 60m = 01:00.
    expect((await addDays('2026-08-22T19:00:00.000Z', 60)).toISOString()).toBe('2026-08-24T08:00:00.000Z');
  });

  test('a holiday in the middle of the run is skipped whole', async () => {
    // Mon 2026-08-24 is a holiday: Fri 2026-08-21 14:00 + 1440m lands Tue 14:00.
    prismaMock.holiday.findMany.mockResolvedValue([{ date: new Date('2026-08-24T00:00:00.000Z'), isRecurring: false }]);
    expect((await addDays('2026-08-21T21:00:00.000Z', 1440)).toISOString()).toBe('2026-08-25T21:00:00.000Z');
  });

  test('multi-day targets skip every weekend on the way', async () => {
    // Mon 2026-08-17 09:00 PDT + 7200m (5 days) -> Mon 2026-08-24 09:00 PDT.
    expect((await addDays('2026-08-17T16:00:00.000Z', 7200)).toISOString()).toBe('2026-08-24T16:00:00.000Z');
  });

  test('zero enabled business-hour rows falls back to wall-clock', async () => {
    prismaMock.businessHour.findMany.mockResolvedValue([]);
    expect((await addDays('2026-08-21T21:00:00.000Z', 1440)).toISOString()).toBe('2026-08-22T21:00:00.000Z');
  });

  test('an unusual calendar is honoured, not assumed to be Mon-Fri', async () => {
    // Sunday is the only working day: Fri 2026-08-21 14:00 + 60m waits until
    // Sun 2026-08-23 00:00 and lands at 01:00 PDT.
    prismaMock.businessHour.findMany.mockResolvedValue([
      { dayOfWeek: 0, startTime: '09:00', endTime: '17:00', isEnabled: true, timezone: 'America/Los_Angeles' },
    ]);
    expect((await addDays('2026-08-21T21:00:00.000Z', 60)).toISOString()).toBe('2026-08-23T08:00:00.000Z');
  });

  test('a DST fall-back day is 25 hours long', async () => {
    // 2026-11-01 is the fall-back Sunday (not a working day here), so run over
    // it: Fri 2026-10-30 12:00 PDT + 1440m -> Mon 2026-11-02 12:00 PST.
    expect((await addDays('2026-10-30T19:00:00.000Z', 1440)).toISOString()).toBe('2026-11-02T20:00:00.000Z');
  });

  test('MAX_WALK_DAYS is still the shared cap', () => {
    expect(MAX_WALK_DAYS).toBe(400);
  });
});
