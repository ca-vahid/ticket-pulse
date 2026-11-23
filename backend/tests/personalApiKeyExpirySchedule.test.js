import { jest } from '@jest/globals';

/**
 * Personal API keys (4.4.05): the 7-day expiry warning is on the clock in
 * scheduledSyncService — daily 09:00 Pacific, plain cron values, kill switch
 * PERSONAL_KEY_EXPIRY_SWEEP=false, stopped with the rest.
 */
const jobs = [];
const cronScheduleMock = jest.fn(() => {
  const job = { stop: jest.fn() };
  jobs.push(job);
  return job;
});
const sweepMock = jest.fn();
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
jest.unstable_mockModule('../src/services/personalApiKeyService.js', () => ({ runExpirySweep: sweepMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));

const { default: scheduledSyncService } = await import('../src/services/scheduledSyncService.js');

beforeEach(() => {
  jest.clearAllMocks();
  jobs.length = 0;
  delete process.env.PERSONAL_KEY_EXPIRY_SWEEP;
  scheduledSyncService.personalKeyExpiryJob = null;
});

describe('startPersonalKeyExpirySweep', () => {
  test('daily at 09:00 Pacific, plain cron values', () => {
    scheduledSyncService.startPersonalKeyExpirySweep();
    const [expression, , options] = cronScheduleMock.mock.calls[0];
    expect(expression).toBe('0 9 * * *');
    expect(expression).not.toMatch(/[-/]/);
    expect(options).toEqual({ scheduled: true, timezone: 'America/Vancouver' });
  });

  test('the tick runs the sweep and logs; a failure is only a warning', async () => {
    scheduledSyncService.startPersonalKeyExpirySweep();
    const tick = cronScheduleMock.mock.calls[0][1];
    sweepMock.mockResolvedValue({ warned: 2, expired: 1 });
    await tick();
    expect(sweepMock).toHaveBeenCalledTimes(1);
    expect(loggerMock.info).toHaveBeenCalledWith('Personal API keys: 2 expiry warning(s) sent, 1 key(s) marked ended');
    sweepMock.mockRejectedValue(new Error('boom'));
    await expect(tick()).resolves.toBeUndefined();
    expect(loggerMock.warn).toHaveBeenCalledWith('Personal API key expiry sweep failed (non-fatal): boom');
  });

  test('the kill switch registers nothing; stopAll stops it', () => {
    process.env.PERSONAL_KEY_EXPIRY_SWEEP = 'false';
    scheduledSyncService.startPersonalKeyExpirySweep();
    expect(cronScheduleMock).not.toHaveBeenCalled();
    delete process.env.PERSONAL_KEY_EXPIRY_SWEEP;
    scheduledSyncService.startPersonalKeyExpirySweep();
    scheduledSyncService.stopAll();
    expect(jobs[0].stop).toHaveBeenCalledTimes(1);
    expect(scheduledSyncService.personalKeyExpiryJob).toBeNull();
  });
});
