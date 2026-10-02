import { jest } from '@jest/globals';

/**
 * Phase HD4 (QA 08-25 #3) — holidayAutoloadService: boot + Jan-1 backfill
 * that keeps this year + next loaded for every active workspace with
 * business hours — one company-wide load since 1 Oct 2026. Idempotent, kill switch.
 */

const prismaMock = {
  businessHour: { findMany: jest.fn() },
};
const availabilityServiceMock = {
  loadCanadianHolidaysForYears: jest.fn(),
};
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/availabilityService.js', () => ({ default: availabilityServiceMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));

const { default: holidayAutoloadService, isHolidayAutoloadEnabled } = await import('../src/services/holidayAutoloadService.js');

const thisYear = new Date().getUTCFullYear();

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.HOLIDAY_AUTOLOAD;
  prismaMock.businessHour.findMany.mockResolvedValue([{ workspaceId: 1 }, { workspaceId: 2 }]);
  availabilityServiceMock.loadCanadianHolidaysForYears.mockResolvedValue({
    years: [thisYear, thisYear + 1], created: 6, skipped: 18, perYear: [],
  });
});

describe('holidayAutoloadService.ensureHolidaysLoaded', () => {
  test('loads this year + next ONCE, company-wide, when any active workspace has business hours (1 Oct 2026)', async () => {
    const result = await holidayAutoloadService.ensureHolidaysLoaded({ reason: 'boot' });

    expect(prismaMock.businessHour.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspace: { isActive: true } },
      distinct: ['workspaceId'],
    }));
    // One shared load — not one per workspace (that left five copies of each holiday).
    expect(availabilityServiceMock.loadCanadianHolidaysForYears).toHaveBeenCalledTimes(1);
    expect(availabilityServiceMock.loadCanadianHolidaysForYears).toHaveBeenCalledWith(null, null);
    expect(result).toEqual({ skipped: false, years: [thisYear, thisYear + 1], workspaceCount: 2, created: 6, skippedRows: 18 });
  });

  test('no active workspace with business hours: nothing is loaded', async () => {
    prismaMock.businessHour.findMany.mockResolvedValue([]);
    const result = await holidayAutoloadService.ensureHolidaysLoaded({ reason: 'boot' });
    expect(result).toEqual({ skipped: false, years: [], workspaceCount: 0, created: 0 });
    expect(availabilityServiceMock.loadCanadianHolidaysForYears).not.toHaveBeenCalled();
  });

  test('is idempotent: a second run creates nothing and logs one summary line', async () => {
    availabilityServiceMock.loadCanadianHolidaysForYears.mockResolvedValue({ years: [thisYear, thisYear + 1], created: 0, skipped: 24, perYear: [] });

    const result = await holidayAutoloadService.ensureHolidaysLoaded({ reason: 'yearly-cron' });

    expect(result.created).toBe(0);
    expect(loggerMock.info).toHaveBeenCalledTimes(1);
    expect(loggerMock.info.mock.calls[0][0]).toContain('0 company-wide holiday(s) created');
  });

  test('a failing load is non-fatal and reported', async () => {
    availabilityServiceMock.loadCanadianHolidaysForYears.mockRejectedValueOnce(new Error('db hiccup'));

    const result = await holidayAutoloadService.ensureHolidaysLoaded({ reason: 'boot' });

    expect(result).toEqual(expect.objectContaining({ created: 0, error: 'db hiccup' }));
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('db hiccup'));
  });

  test('HOLIDAY_AUTOLOAD=false is a hard kill switch', async () => {
    process.env.HOLIDAY_AUTOLOAD = 'false';
    expect(isHolidayAutoloadEnabled()).toBe(false);

    const result = await holidayAutoloadService.ensureHolidaysLoaded({ reason: 'boot' });

    expect(result).toEqual({ skipped: true, years: [], workspaceCount: 0, created: 0 });
    expect(prismaMock.businessHour.findMany).not.toHaveBeenCalled();
    expect(availabilityServiceMock.loadCanadianHolidaysForYears).not.toHaveBeenCalled();
  });

  test('explicit years are passed through (used by the prod repair)', async () => {
    await holidayAutoloadService.ensureHolidaysLoaded({ years: [2026, 2027], reason: 'manual' });
    expect(availabilityServiceMock.loadCanadianHolidaysForYears).toHaveBeenCalledWith([2026, 2027], null);
  });
});
