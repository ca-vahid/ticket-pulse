import { jest } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Phase HD (QA 08-25 #3) — availabilityService Canadian holiday generator:
 * dates are built with Date.UTC so the DATE column receives the right
 * calendar day regardless of the server's timezone, the loader is
 * idempotent and reports counts, and the multi-year variant defaults to
 * this year + next.
 */

const prismaMock = {
  holiday: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn() },
  businessHour: { count: jest.fn(), findMany: jest.fn() },
};
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../src/services/llmConfigService.js', () => ({ default: {} }));

const { default: availabilityService, normalizeHolidayYears, MAX_HOLIDAY_LOAD_YEARS } = await import('../src/services/availabilityService.js');

const iso = (date) => date.toISOString().slice(0, 10);
const byName = (year) => Object.fromEntries(availabilityService.canadianHolidaysForYear(year).map((h) => [h.name, iso(h.date)]));

const EXPECTED_2026 = {
  'Family Day': '2026-02-16',
  'Good Friday': '2026-04-03',
  'Victoria Day': '2026-05-18',
  'Civic Holiday': '2026-08-03',
  'Labour Day': '2026-09-07',
  'Thanksgiving': '2026-10-12',
  'New Year\'s Day': '2026-01-01',
  'Canada Day': '2026-07-01',
  'Truth and Reconciliation': '2026-09-30',
  'Remembrance Day': '2026-11-11',
  'Christmas Day': '2026-12-25',
  'Boxing Day': '2026-12-26',
};

// A running Node does not retarget its timezone when process.env.TZ changes
// (verified: the offset stayed at the host's), so the timezone proof spawns
// a child per zone with TZ in its env and reads the generator's output back.
// UTC, Pacific (west of UTC — the bug's home) and Sydney (east) together
// bracket every drift direction a server-local `new Date(y, m, d)` had.
const probeScript = `
  const { default: s } = await import('./src/services/availabilityService.js');
  const off = new Date(Date.UTC(2026, 0, 15, 12)).getTimezoneOffset();
  const years = {};
  for (const year of [2025, 2026, 2027]) {
    years[year] = Object.fromEntries(s.canadianHolidaysForYear(year).map((h) => [h.name, h.date.toISOString()]));
  }
  process.stdout.write(JSON.stringify({ off, years }));
  process.exit(0);
`;
const probe = (tz) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probeScript], {
  cwd: path.resolve(__dirname, '..'),
  env: { ...process.env, TZ: tz },
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
  timeout: 60000,
}));
const dayOf = (map) => Object.fromEntries(Object.entries(map).map(([name, isoDate]) => [name, isoDate.slice(0, 10)]));

describe.each([
  ['UTC', 0],
  ['America/Vancouver', 480],
  ['Australia/Sydney', -660],
])('canadianHolidaysForYear in a TZ=%s process', (tz, expectedOffset) => {
  const result = probe(tz);

  test('the child really runs in that zone', () => {
    expect(result.off).toBe(expectedOffset);
  });

  test('2026: Family Day 02-16, Good Friday 04-03, Victoria Day 05-18, Civic 08-03, Labour Day 09-07, Thanksgiving 10-12', () => {
    expect(dayOf(result.years[2026])).toEqual(EXPECTED_2026);
    // Every generated instant is EXACTLY UTC midnight (what a @db.Date expects).
    for (const isoDate of Object.values(result.years[2026])) {
      expect(isoDate).toMatch(/T00:00:00\.000Z$/);
    }
  });

  test('2025 and 2027 floating holidays (regression anchors for the hardcoded frontend tables)', () => {
    expect(dayOf(result.years[2025])).toEqual(expect.objectContaining({
      'Family Day': '2025-02-17', 'Good Friday': '2025-04-18', 'Victoria Day': '2025-05-19',
      'Civic Holiday': '2025-08-04', 'Labour Day': '2025-09-01', 'Thanksgiving': '2025-10-13',
    }));
    expect(dayOf(result.years[2027])).toEqual(expect.objectContaining({
      'Family Day': '2027-02-15', 'Good Friday': '2027-03-26', 'Victoria Day': '2027-05-24',
      'Civic Holiday': '2027-08-02', 'Labour Day': '2027-09-06', 'Thanksgiving': '2027-10-11',
    }));
  });
});

test('in-process generator (host zone) agrees with the UTC child', () => {
  expect(byName(2026)).toEqual(EXPECTED_2026);
});

describe('loadCanadianHolidays — idempotent with counts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.holiday.create.mockImplementation(({ data }) => Promise.resolve({ id: 1, ...data }));
  });

  test('empty table → all 12 created, scoped to the workspace, with UTC-midnight dates', async () => {
    prismaMock.holiday.findFirst.mockResolvedValue(null);

    const result = await availabilityService.loadCanadianHolidays(2026, 2);

    expect(result).toEqual(expect.objectContaining({ year: 2026, created: 12, skipped: 0 }));
    expect(result.createdNames).toContain('Labour Day');
    expect(prismaMock.holiday.create).toHaveBeenCalledTimes(12);
    expect(prismaMock.holiday.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Labour Day', date: new Date('2026-09-07T00:00:00.000Z'), isRecurring: false, country: 'CA', workspaceId: 2,
      }),
    });
    // Dedupe looks at the workspace's rows AND shared (workspaceId null) rows.
    expect(prismaMock.holiday.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({ name: 'Labour Day', date: new Date('2026-09-07T00:00:00.000Z'), OR: [{ workspaceId: 2 }, { workspaceId: null }] }),
    });
  });

  test('second run → nothing created, everything reported as skipped', async () => {
    prismaMock.holiday.findFirst.mockResolvedValue({ id: 9 });

    const result = await availabilityService.loadCanadianHolidays(2026, 2);

    expect(result).toEqual(expect.objectContaining({ created: 0, skipped: 12 }));
    expect(prismaMock.holiday.create).not.toHaveBeenCalled();
  });

  test('recurring holidays dedupe by name (any year) so a second year does not duplicate Canada Day', async () => {
    // Existing rows: the 6 recurring ones (loaded with 2025 dates). The 6 floating 2026 ones are new.
    prismaMock.holiday.findFirst.mockImplementation(({ where }) => Promise.resolve(where.isRecurring ? { id: 1 } : null));

    const result = await availabilityService.loadCanadianHolidays(2026, 2);

    expect(result.created).toBe(6);
    expect(result.skipped).toBe(6);
    expect(result.createdNames).toEqual(['Family Day', 'Good Friday', 'Victoria Day', 'Civic Holiday', 'Labour Day', 'Thanksgiving']);
    expect(prismaMock.holiday.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({ name: 'Canada Day', isRecurring: true }),
    });
  });
});

describe('loadCanadianHolidaysForYears + normalizeHolidayYears', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.holiday.findFirst.mockResolvedValue(null);
    prismaMock.holiday.create.mockImplementation(({ data }) => Promise.resolve({ id: 1, ...data }));
  });

  test('defaults to this year + next and aggregates counts', async () => {
    const thisYear = new Date().getUTCFullYear();
    const result = await availabilityService.loadCanadianHolidaysForYears(null, 1);

    expect(result.years).toEqual([thisYear, thisYear + 1]);
    expect(result.created).toBe(24);
    expect(result.skipped).toBe(0);
    expect(result.perYear.map((p) => p.year)).toEqual([thisYear, thisYear + 1]);
  });

  test('normalizeHolidayYears: legacy single year, strings, dupes, garbage, ordering and the cap', () => {
    const thisYear = new Date().getUTCFullYear();
    expect(normalizeHolidayYears(2026)).toEqual([2026]);
    expect(normalizeHolidayYears(['2027', 2026, 2026, 'x', 1999, 2101])).toEqual([2026, 2027]);
    expect(normalizeHolidayYears([])).toEqual([thisYear, thisYear + 1]);
    expect(normalizeHolidayYears(undefined)).toEqual([thisYear, thisYear + 1]);
    expect(normalizeHolidayYears([2020, 2021, 2022, 2023, 2024, 2025, 2026])).toHaveLength(MAX_HOLIDAY_LOAD_YEARS);
  });
});
