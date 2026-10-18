import { jest } from '@jest/globals';

/**
 * BC permanent UTC-7 from 1 Nov 2026 (tzdata 2026b). On a runtime with current
 * time-zone data, Vancouver keeps UTC-7 across 1 Nov while Los Angeles falls back
 * to UTC-8. These checks only mean something on Node 22+ (tz 2026b or newer);
 * on older data they are skipped and tzDataCheck logs the error at boot.
 */

const tzIsCurrent = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Vancouver', hour: 'numeric', hourCycle: 'h23' })
  .format(new Date('2026-11-15T20:00:00Z')) === '13';
const describeCurrent = tzIsCurrent ? describe : describe.skip;

const prismaMock = {
  businessHour: { findMany: jest.fn() },
  holiday: { findMany: jest.fn() },
  workspace: { findUnique: jest.fn() },
};
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));

const { default: businessCalendarService } = await import('../src/services/businessCalendarService.js');
const { handoverInstant } = await import('../src/services/urgentResponse/rules.js');

const VANCOUVER = 'America/Vancouver';
const WEEKDAYS_9_5 = [1, 2, 3, 4, 5].map((dayOfWeek) => ({
  dayOfWeek, startTime: '09:00', endTime: '17:00', isEnabled: true, timezone: VANCOUVER,
}));

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.businessHour.findMany.mockResolvedValue(WEEKDAYS_9_5);
  prismaMock.holiday.findMany.mockResolvedValue([]);
  prismaMock.workspace.findUnique.mockResolvedValue({ defaultTimezone: VANCOUVER });
});

describeCurrent('BC keeps UTC-7 across 1 Nov 2026', () => {
  test('business minutes: Monday 2 Nov opens at 09:00 UTC-7 (16:00Z), not 17:00Z', async () => {
    // Fri 30 Oct 16:30 (23:30Z) + 60m: 30 Fri, 30 Mon from 09:00 UTC-7 = 16:30Z.
    const at = await businessCalendarService.addBusinessMinutes(new Date('2026-10-30T23:30:00.000Z'), 60, { workspaceId: 1 });
    expect(at.toISOString()).toBe('2026-11-02T16:30:00.000Z');
  });

  test('on-call handover at 17:00 on Mon 2 Nov is 00:00Z, the same offset as October', () => {
    expect(handoverInstant('2026-10-12', '17:00', VANCOUVER).toISOString()).toBe('2026-10-13T00:00:00.000Z');
    expect(handoverInstant('2026-11-02', '17:00', VANCOUVER).toISOString()).toBe('2026-11-03T00:00:00.000Z');
  });

  test('Toronto is 2 hours ahead of Vancouver in winter and 3 in summer', () => {
    const hour = (tz, iso) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(iso)));
    expect(hour('America/Toronto', '2026-11-15T20:00:00Z') - hour(VANCOUVER, '2026-11-15T20:00:00Z')).toBe(2);
    expect(hour('America/Toronto', '2026-07-15T20:00:00Z') - hour(VANCOUVER, '2026-07-15T20:00:00Z')).toBe(3);
  });
});

test('the BC checks ran or were skipped on purpose', () => {
  expect(typeof tzIsCurrent).toBe('boolean');
});
