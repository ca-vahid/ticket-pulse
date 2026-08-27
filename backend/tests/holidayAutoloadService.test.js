import { jest } from '@jest/globals';

/**
 * Phase HD4 (QA 08-25 #3) — holidayAutoloadService: boot + Jan-1 backfill
 * that keeps this year + next loaded for every active workspace with
 * business hours. Idempotent, per-workspace fault-isolated, kill switch.
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
  test('loads this year + next for every active workspace with business hours', async () => {
    const result = await holidayAutoloadService.ensureHolidaysLoaded({ reason: 'boot' });

    expect(prismaMock.businessHour.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspace: { isActive: true } },
      distinct: ['workspaceId'],
    }));
    expect(availabilityServiceMock.loadCanadianHolidaysForYears).toHaveBeenCalledTimes(2);
    expect(availabilityServiceMock.loadCanadianHolidaysForYears).toHaveBeenCalledWith(null, 1);
    expect(availabilityServiceMock.loadCanadianHolidaysForYears).toHaveBeenCalledWith(null, 2);
    expect(result).toEqual(expect.objectContaining({
      skipped: false,
      years: [thisYear, thisYear + 1],
      created: 12,
      workspaces: [{ workspaceId: 1, created: 6, skipped: 18 }, { workspaceId: 2, created: 6, skipped: 18 }],
    }));
  });

  test('is idempotent: a second run creates nothing and stays quiet', async () => {
    availabilityServiceMock.loadCanadianHolidaysForYears.mockResolvedValue({ years: [thisYear, thisYear + 1], created: 0, skipped: 24, perYear: [] });

    const result = await holidayAutoloadService.ensureHolidaysLoaded({ reason: 'yearly-cron' });

    expect(result.created).toBe(0);
    // No per-workspace "+N" lines when nothing changed; one summary line only.
    expect(loggerMock.info).toHaveBeenCalledTimes(1);
    expect(loggerMock.info.mock.calls[0][0]).toContain('0 holiday(s) created');
  });

  test('one workspace failing does not stop the others', async () => {
    availabilityServiceMock.loadCanadianHolidaysForYears
      .mockRejectedValueOnce(new Error('db hiccup'))
      .mockResolvedValueOnce({ years: [thisYear, thisYear + 1], created: 2, skipped: 22, perYear: [] });

    const result = await holidayAutoloadService.ensureHolidaysLoaded({ reason: 'boot' });

    expect(result.created).toBe(2);
    expect(result.workspaces[0]).toEqual(expect.objectContaining({ workspaceId: 1, error: 'db hiccup' }));
    expect(result.workspaces[1]).toEqual({ workspaceId: 2, created: 2, skipped: 22 });
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('workspace 1'));
  });

  test('HOLIDAY_AUTOLOAD=false is a hard kill switch', async () => {
    process.env.HOLIDAY_AUTOLOAD = 'false';
    expect(isHolidayAutoloadEnabled()).toBe(false);

    const result = await holidayAutoloadService.ensureHolidaysLoaded({ reason: 'boot' });

    expect(result).toEqual({ skipped: true, years: [], workspaces: [], created: 0 });
    expect(prismaMock.businessHour.findMany).not.toHaveBeenCalled();
    expect(availabilityServiceMock.loadCanadianHolidaysForYears).not.toHaveBeenCalled();
  });

  test('explicit years are passed through (used by the prod repair)', async () => {
    await holidayAutoloadService.ensureHolidaysLoaded({ years: [2026, 2027], reason: 'manual' });
    expect(availabilityServiceMock.loadCanadianHolidaysForYears).toHaveBeenCalledWith([2026, 2027], 1);
  });
});
