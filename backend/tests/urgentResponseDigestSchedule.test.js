import { jest } from '@jest/globals';

/**
 * The weekly Urgent response e-mail is on the clock in scheduledSyncService:
 * Mondays 08:10 Pacific, plain cron values (node-cron 3.0.3 mishandles stepped
 * ranges), kill switch URGENT_RESPONSE_DIGEST=false, stopped with the rest.
 */
const jobs = [];
const cronScheduleMock = jest.fn(() => {
  const job = { stop: jest.fn() };
  jobs.push(job);
  return job;
});
const digestMock = { sendDigests: jest.fn() };
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
jest.unstable_mockModule('../src/services/urgentResponse/urgentResponseDigestService.js', () => ({ default: digestMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));

const { default: scheduledSyncService } = await import('../src/services/scheduledSyncService.js');

beforeEach(() => {
  jest.clearAllMocks();
  jobs.length = 0;
  delete process.env.URGENT_RESPONSE_DIGEST;
  scheduledSyncService.urgentResponseDigestJob = null;
});

describe('startUrgentResponseDigest', () => {
  test('Mondays at 08:10 Pacific, with plain cron values', () => {
    scheduledSyncService.startUrgentResponseDigest();
    expect(cronScheduleMock).toHaveBeenCalledTimes(1);
    const [expression, , options] = cronScheduleMock.mock.calls[0];
    expect(expression).toBe('10 8 * * 1');
    expect(expression).not.toMatch(/[-/]/);
    expect(options).toEqual({ scheduled: true, timezone: 'America/Los_Angeles' });
  });

  test('the tick sends the digests and logs how many went out; a failure is only a warning', async () => {
    scheduledSyncService.startUrgentResponseDigest();
    const tick = cronScheduleMock.mock.calls[0][1];
    digestMock.sendDigests.mockResolvedValue([{ workspaceId: 1, sent: true }, { workspaceId: 2, skipped: 'nothing_to_report' }]);
    await tick();
    expect(digestMock.sendDigests).toHaveBeenCalledTimes(1);
    expect(loggerMock.info).toHaveBeenCalledWith('Urgent response digest: 1 workspace digest(s) sent');

    digestMock.sendDigests.mockRejectedValue(new Error('boom'));
    await expect(tick()).resolves.toBeUndefined();
    expect(loggerMock.warn).toHaveBeenCalledWith('Urgent response digest tick failed (non-fatal): boom');
  });

  test('the kill switch registers nothing', () => {
    process.env.URGENT_RESPONSE_DIGEST = 'false';
    scheduledSyncService.startUrgentResponseDigest();
    expect(cronScheduleMock).not.toHaveBeenCalled();
  });

  test('starting twice keeps one job; stopAll stops it', () => {
    scheduledSyncService.startUrgentResponseDigest();
    scheduledSyncService.startUrgentResponseDigest();
    expect(jobs).toHaveLength(2);
    expect(jobs[0].stop).toHaveBeenCalledTimes(1);
    scheduledSyncService.stopAll();
    expect(jobs[1].stop).toHaveBeenCalledTimes(1);
    expect(scheduledSyncService.urgentResponseDigestJob).toBeNull();
  });
});
