import { jest } from '@jest/globals';

/**
 * 4.4.08 review: the attachment-names catch-up is on the clock in
 * scheduledSyncService: 3 minutes after boot and daily at 03:40 Pacific
 * (plain cron values), kill switch ATTACHMENT_NAMING_CATCHUP=false, stopped
 * with the rest.
 */
const jobs = [];
const cronScheduleMock = jest.fn(() => {
  const job = { stop: jest.fn() };
  jobs.push(job);
  return job;
});
const catchUpMock = jest.fn();
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('node-cron', () => ({ default: { schedule: cronScheduleMock } }));
jest.unstable_mockModule('../src/services/syncService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({ default: { getConfig: jest.fn() } }));
jest.unstable_mockModule('../src/services/vacationTrackerService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/vacationTrackerRepository.js', () => ({ default: { getConfig: jest.fn() } }));
jest.unstable_mockModule('../src/services/calendarLeaveService.js', () => ({ default: { getConfig: jest.fn() } }));
jest.unstable_mockModule('../src/services/syncLogRepository.js', () => ({
  default: { createLog: jest.fn(), completeLog: jest.fn(), failLog: jest.fn(), getLatestSuccessful: jest.fn() },
}));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({ default: { getAllActive: jest.fn() } }));
jest.unstable_mockModule('../src/services/emailPollingService.js', () => ({ default: { startAll: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentDailyReviewService.js', () => ({ default: { maybeRunScheduledReview: jest.fn() } }));
jest.unstable_mockModule('../src/services/attachmentNamingService.js', () => ({ catchUpRecentAttachments: catchUpMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));

const { default: scheduledSyncService } = await import('../src/services/scheduledSyncService.js');

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jobs.length = 0;
  delete process.env.ATTACHMENT_NAMING_CATCHUP;
  scheduledSyncService.stopAttachmentNamingCatchUp();
});
afterEach(() => {
  scheduledSyncService.stopAttachmentNamingCatchUp();
  jest.useRealTimers();
});

describe('startAttachmentNamingCatchUp', () => {
  test('daily at 03:40 Pacific, plain cron values', () => {
    scheduledSyncService.startAttachmentNamingCatchUp();
    const [expression, , options] = cronScheduleMock.mock.calls[0];
    expect(expression).toBe('40 3 * * *');
    expect(expression).not.toMatch(/[-/]/);
    expect(options).toEqual({ scheduled: true, timezone: 'America/Vancouver' });
  });

  test('runs once 3 minutes after boot; a failure is only a warning', async () => {
    catchUpMock.mockResolvedValue({ workspaces: 1, found: 4, queued: 4 });
    scheduledSyncService.startAttachmentNamingCatchUp();
    expect(catchUpMock).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(3 * 60_000);
    expect(catchUpMock).toHaveBeenCalledTimes(1);
    expect(loggerMock.info).toHaveBeenCalledWith('Attachment naming catch-up (boot): 4 of 4 file(s) queued');

    catchUpMock.mockRejectedValue(new Error('boom'));
    const tick = cronScheduleMock.mock.calls[0][1];
    await expect(tick()).resolves.toBeUndefined();
    expect(loggerMock.warn).toHaveBeenCalledWith('Attachment naming catch-up (daily) failed (non-fatal): boom');
  });

  test('the kill switch registers nothing; stopAll stops it and the boot run', async () => {
    process.env.ATTACHMENT_NAMING_CATCHUP = 'false';
    scheduledSyncService.startAttachmentNamingCatchUp();
    expect(cronScheduleMock).not.toHaveBeenCalled();
    delete process.env.ATTACHMENT_NAMING_CATCHUP;
    scheduledSyncService.startAttachmentNamingCatchUp();
    scheduledSyncService.stopAll();
    expect(jobs[0].stop).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(catchUpMock).not.toHaveBeenCalled();
  });
});
