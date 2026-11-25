import { jest } from '@jest/globals';

/**
 * FreshService switch (FreshService exit A1, 25 Nov 2026), the schedulers:
 * a workspace switched OFF gets no FreshService sync, no fast lane and a
 * no-op "Sync now", but its daily review keeps running on its own schedule
 * (today it rides the sync cron) — never twice for a synced workspace. A mode
 * flip restarts that workspace's schedules.
 */

const modes = new Map();
const modeOf = (ws) => modes.get(Number(ws)) || 'connected';
let modeListener = null;
jest.unstable_mockModule('../src/services/fsModeService.js', () => ({
  isFreshServiceOff: jest.fn(async (wsOrRow) => {
    const id = typeof wsOrRow === 'object' ? wsOrRow?.id : wsOrRow;
    if (wsOrRow && typeof wsOrRow === 'object' && String(wsOrRow.freshserviceWorkspaceId) === '0') return true;
    return modeOf(id) === 'off';
  }),
  onModeChange: jest.fn((fn) => { modeListener = fn; return () => {}; }),
}));

const cronJobs = [];
const cronScheduleMock = jest.fn((expr, fn) => { const job = { expr, fn, stop: jest.fn() }; cronJobs.push(job); return job; });
const syncServiceMock = { syncAssignmentCandidatesNow: jest.fn(), performFullSync: jest.fn() };
const workspaceRepositoryMock = { getAllActive: jest.fn(), getById: jest.fn() };
const reviewMock = { maybeRunScheduledReview: jest.fn().mockResolvedValue({ triggered: false }) };

jest.unstable_mockModule('node-cron', () => ({ default: { schedule: cronScheduleMock } }));
jest.unstable_mockModule('../src/services/syncService.js', () => ({ default: syncServiceMock }));
jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({ default: { getConfig: jest.fn() } }));
jest.unstable_mockModule('../src/services/vacationTrackerService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/vacationTrackerRepository.js', () => ({ default: { getConfig: jest.fn() } }));
jest.unstable_mockModule('../src/services/calendarLeaveService.js', () => ({ default: { getConfig: jest.fn() } }));
jest.unstable_mockModule('../src/services/syncLogRepository.js', () => ({
  default: { createLog: jest.fn(), completeLog: jest.fn(), failLog: jest.fn(), getLatestSuccessful: jest.fn().mockResolvedValue({ completedAt: new Date() }), failStaleStarted: jest.fn().mockResolvedValue(0) },
}));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({ default: workspaceRepositoryMock }));
jest.unstable_mockModule('../src/services/assignmentDailyReviewService.js', () => ({ default: reviewMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: scheduledSyncService } = await import('../src/services/scheduledSyncService.js');

const pa = { id: 5, name: 'Project Accounting', freshserviceWorkspaceId: 1000208190n, defaultTimezone: 'America/Vancouver', syncIntervalMinutes: 5 };
const it = { id: 1, name: 'IT', freshserviceWorkspaceId: 1000208180n, defaultTimezone: 'America/Vancouver', syncIntervalMinutes: 5 };
const facilities = { id: 10, name: 'Facilities', freshserviceWorkspaceId: 0n, defaultTimezone: 'America/Vancouver', syncIntervalMinutes: 5 };
const tick = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  modes.clear();
  modes.set(5, 'off');
  cronJobs.length = 0;
  syncServiceMock.performFullSync.mockResolvedValue({ status: 'completed' });
});

afterEach(() => {
  scheduledSyncService.stop();
  jest.clearAllMocks();
});

describe('a workspace switched off', () => {
  test('no FreshService sync and no fast lane; the daily review has its own schedule', async () => {
    await scheduledSyncService.startForWorkspace(pa);
    await scheduledSyncService.startAssignmentFastSyncForWorkspace(pa);
    expect(scheduledSyncService.cronJobs.has(5)).toBe(false);
    expect(scheduledSyncService.assignmentFastSyncCronJobs.has(5)).toBe(false);
    expect(scheduledSyncService.dailyReviewCronJobs.has(5)).toBe(true);
    await tick();
    expect(syncServiceMock.performFullSync).not.toHaveBeenCalled();
    // Checked once at start (the boot catch-up's review check) ...
    expect(reviewMock.maybeRunScheduledReview).toHaveBeenCalledWith(pa);
    // ... and on every tick of its own schedule, with no sync before it.
    reviewMock.maybeRunScheduledReview.mockClear();
    const job = cronJobs.find((j) => j === scheduledSyncService.dailyReviewCronJobs.get(5).job);
    await job.fn();
    expect(reviewMock.maybeRunScheduledReview).toHaveBeenCalledTimes(1);
    expect(syncServiceMock.performFullSync).not.toHaveBeenCalled();
  });

  test('never connected (FS id 0): the daily review still runs', async () => {
    await scheduledSyncService.startForWorkspace(facilities);
    expect(scheduledSyncService.cronJobs.has(10)).toBe(false);
    expect(scheduledSyncService.dailyReviewCronJobs.has(10)).toBe(true);
    await tick();
    expect(reviewMock.maybeRunScheduledReview).toHaveBeenCalledWith(facilities);
  });

  test('"Sync now" is a skip with reason freshservice_off', async () => {
    workspaceRepositoryMock.getById.mockResolvedValue(pa);
    await expect(scheduledSyncService.triggerManualSync(false, 30, 5)).resolves.toEqual({ status: 'skipped', reason: 'freshservice_off' });
    expect(syncServiceMock.performFullSync).not.toHaveBeenCalled();
  });
});

describe('a connected workspace', () => {
  test('sync cron + fast lane as today, and NO separate daily-review job (it rides the sync tick)', async () => {
    await scheduledSyncService.startForWorkspace(it);
    await scheduledSyncService.startAssignmentFastSyncForWorkspace(it);
    expect(scheduledSyncService.cronJobs.has(1)).toBe(true);
    expect(scheduledSyncService.assignmentFastSyncCronJobs.has(1)).toBe(true);
    expect(scheduledSyncService.dailyReviewCronJobs.has(1)).toBe(false);
    await tick();
    reviewMock.maybeRunScheduledReview.mockClear();
    syncServiceMock.performFullSync.mockClear();
    await scheduledSyncService.cronJobs.get(1).job.fn();
    expect(syncServiceMock.performFullSync).toHaveBeenCalledWith({ workspaceId: 1 });
    expect(reviewMock.maybeRunScheduledReview).toHaveBeenCalledTimes(1);
  });

  test('Shadow schedules exactly like Connected', async () => {
    modes.set(1, 'shadow');
    await scheduledSyncService.startForWorkspace(it);
    expect(scheduledSyncService.cronJobs.has(1)).toBe(true);
    expect(scheduledSyncService.dailyReviewCronJobs.has(1)).toBe(false);
  });
});

describe('overlapping restarts never orphan a job (data-safety review)', () => {
  const live = (pred) => cronJobs.filter((j) => pred(j) && j.stop.mock.calls.length === 0);

  test('two startForWorkspace / fast-lane starts at once leave exactly one live job of each', async () => {
    const { isFreshServiceOff } = await import('../src/services/fsModeService.js');
    // Make the mode read slow, so both calls are inside it together.
    isFreshServiceOff.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 5)); return false; });
    try {
      await Promise.all([scheduledSyncService.startForWorkspace(it), scheduledSyncService.startForWorkspace(it)]);
      await Promise.all([scheduledSyncService.startAssignmentFastSyncForWorkspace(it), scheduledSyncService.startAssignmentFastSyncForWorkspace(it)]);
      const syncJob = scheduledSyncService.cronJobs.get(1).job;
      const fastJob = scheduledSyncService.assignmentFastSyncCronJobs.get(1).job;
      // Every job ever created is either the one in the map or stopped.
      expect(live(() => true).sort()).toEqual([syncJob, fastJob].sort());
    } finally {
      isFreshServiceOff.mockImplementation(async (wsOrRow) => modeOf(typeof wsOrRow === 'object' ? wsOrRow?.id : wsOrRow) === 'off');
    }
  });

  test('two restarts at once (mode flip + settings save) run one after the other; one job of each kind', async () => {
    workspaceRepositoryMock.getAllActive.mockResolvedValue([pa]);
    workspaceRepositoryMock.getById.mockResolvedValue(pa);
    await scheduledSyncService.start();
    modes.set(5, 'connected');
    await Promise.all([scheduledSyncService.restart(5), scheduledSyncService.restart(5), modeListener(5, 'connected', 'off')]);
    const inMaps = [
      scheduledSyncService.cronJobs.get(5)?.job,
      scheduledSyncService.assignmentFastSyncCronJobs.get(5)?.job,
      scheduledSyncService.embeddingBackfillCronJobs.get(5)?.job,
    ].filter(Boolean);
    expect(scheduledSyncService.dailyReviewCronJobs.has(5)).toBe(false);
    const perWorkspaceLive = live((j) => !['0 4 1 1 *', '*/30 * * * *', '0 8 * * *', '5 8 * * 1,2,3,4,5', '10 8 * * 1', '0 9 * * *', '40 3 * * *'].includes(j.expr));
    expect(perWorkspaceLive.sort()).toEqual(inMaps.sort());
  });
});

describe('a mode flip restarts the workspace', () => {
  test('connected -> off -> connected moves the jobs; nothing double-runs', async () => {
    workspaceRepositoryMock.getAllActive.mockResolvedValue([it]);
    workspaceRepositoryMock.getById.mockResolvedValue(it);
    await scheduledSyncService.start();
    expect(scheduledSyncService.cronJobs.has(1)).toBe(true);
    expect(typeof modeListener).toBe('function');

    modes.set(1, 'off');
    await modeListener(1, 'off', 'connected');
    expect(scheduledSyncService.cronJobs.has(1)).toBe(false);
    expect(scheduledSyncService.assignmentFastSyncCronJobs.has(1)).toBe(false);
    expect(scheduledSyncService.dailyReviewCronJobs.has(1)).toBe(true);

    modes.set(1, 'connected');
    await modeListener(1, 'connected', 'off');
    expect(scheduledSyncService.cronJobs.has(1)).toBe(true);
    expect(scheduledSyncService.assignmentFastSyncCronJobs.has(1)).toBe(true);
    expect(scheduledSyncService.dailyReviewCronJobs.has(1)).toBe(false);
  });

  test('schedulers not running (dev box): a flip starts nothing', async () => {
    scheduledSyncService.stop();
    await modeListener(1, 'connected', 'off');
    expect(workspaceRepositoryMock.getById).not.toHaveBeenCalled();
    expect(cronScheduleMock).not.toHaveBeenCalled();
  });
});
