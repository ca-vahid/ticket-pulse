import { jest } from '@jest/globals';

/**
 * QA 11-24 #4: a workspace with no FreshService link (freshservice_workspace_id
 * 0, made by "New workspace") is ACTIVE, so every per-workspace scheduler sees
 * it. The FreshService ones must skip it: full sync, the fast status lane and
 * "Sync now". FS-linked workspaces, and partial rows without the field, keep
 * today's behaviour.
 */

const cronScheduleMock = jest.fn(() => ({ stop: jest.fn() }));
const syncServiceMock = { syncAssignmentCandidatesNow: jest.fn(), performFullSync: jest.fn() };
const workspaceRepositoryMock = { getAllActive: jest.fn(), getById: jest.fn() };

jest.unstable_mockModule('node-cron', () => ({ default: { schedule: cronScheduleMock } }));
jest.unstable_mockModule('../src/services/syncService.js', () => ({ default: syncServiceMock }));
jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({ default: { getConfig: jest.fn() } }));
jest.unstable_mockModule('../src/services/vacationTrackerService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/vacationTrackerRepository.js', () => ({ default: { getConfig: jest.fn() } }));
jest.unstable_mockModule('../src/services/calendarLeaveService.js', () => ({ default: { getConfig: jest.fn() } }));
jest.unstable_mockModule('../src/services/syncLogRepository.js', () => ({
  default: { createLog: jest.fn(), completeLog: jest.fn(), failLog: jest.fn(), getLatestSuccessful: jest.fn().mockResolvedValue(null), failStaleStarted: jest.fn().mockResolvedValue(0) },
}));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({ default: workspaceRepositoryMock }));
jest.unstable_mockModule('../src/services/emailPollingService.js', () => ({ default: { startAll: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentDailyReviewService.js', () => ({ default: { maybeRunScheduledReview: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: scheduledSyncService } = await import('../src/services/scheduledSyncService.js');
const { isFreshServiceBound, isFreshServiceUnlinked } = await import('../src/utils/workspaceFsBinding.js');

const native = { id: 12, name: 'Facilities', freshserviceWorkspaceId: 0n, defaultTimezone: 'America/Vancouver', syncIntervalMinutes: 5 };
const linked = { id: 2, name: 'Accounting', freshserviceWorkspaceId: 1000208182n, defaultTimezone: 'America/Vancouver', syncIntervalMinutes: 5 };

afterEach(() => {
  scheduledSyncService.stopAll();
  jest.clearAllMocks();
});

describe('isFreshServiceBound / isFreshServiceUnlinked', () => {
  test('0, null and "" are unlinked; a real id is linked; a row without the field is not judged', () => {
    expect(isFreshServiceBound(linked)).toBe(true);
    for (const v of [0n, 0, '0', null, '']) {
      expect(isFreshServiceBound({ freshserviceWorkspaceId: v })).toBe(false);
      expect(isFreshServiceUnlinked({ freshserviceWorkspaceId: v })).toBe(true);
    }
    expect(isFreshServiceUnlinked({ id: 3, name: 'AR' })).toBe(false);
    expect(isFreshServiceUnlinked(null)).toBe(false);
  });
});

describe('FreshService schedulers skip an unlinked workspace', () => {
  test('full sync: no cron, no catch-up sync for the unlinked one; the linked one is scheduled', async () => {
    await scheduledSyncService.startForWorkspace(native);
    // FreshService exit A1 (25 Nov 2026): the only job is its own daily-review check.
    expect(scheduledSyncService.cronJobs.has(12)).toBe(false);
    expect(scheduledSyncService.dailyReviewCronJobs.has(12)).toBe(true);
    expect(cronScheduleMock).toHaveBeenCalledTimes(1);
    await new Promise((r) => setImmediate(r));
    expect(syncServiceMock.performFullSync).not.toHaveBeenCalled();

    await scheduledSyncService.startForWorkspace(linked);
    expect(cronScheduleMock).toHaveBeenCalledTimes(2);
    expect(scheduledSyncService.cronJobs.has(2)).toBe(true);
    expect(scheduledSyncService.dailyReviewCronJobs.has(2)).toBe(false);
  });

  test('fast status lane: not scheduled for the unlinked one', async () => {
    await scheduledSyncService.startAssignmentFastSyncForWorkspace(native);
    expect(cronScheduleMock).not.toHaveBeenCalled();
    await scheduledSyncService.startAssignmentFastSyncForWorkspace(linked);
    expect(cronScheduleMock).toHaveBeenCalledTimes(1);
  });

  test('boot start(): the unlinked workspace gets neither FS job', async () => {
    workspaceRepositoryMock.getAllActive.mockResolvedValue([native]);
    await scheduledSyncService.start();
    expect(scheduledSyncService.cronJobs.has(12)).toBe(false);
    expect(scheduledSyncService.assignmentFastSyncCronJobs.has(12)).toBe(false);
    // Non-FreshService jobs (the nightly similar-tickets backfill) still run there.
    expect(scheduledSyncService.embeddingBackfillCronJobs.has(12)).toBe(true);
  });

  test('"Sync now" in the unlinked workspace is a skip, not a FreshService pull', async () => {
    workspaceRepositoryMock.getById.mockResolvedValue(native);
    const result = await scheduledSyncService.triggerManualSync(false, 30, 12);
    expect(result.status).toBe('skipped');
    expect(syncServiceMock.performFullSync).not.toHaveBeenCalled();

    workspaceRepositoryMock.getById.mockResolvedValue(linked);
    syncServiceMock.performFullSync.mockResolvedValue({ status: 'completed' });
    await scheduledSyncService.triggerManualSync(false, 30, 2);
    expect(syncServiceMock.performFullSync).toHaveBeenCalledWith({ workspaceId: 2 });
  });
});
