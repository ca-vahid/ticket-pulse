import { jest } from '@jest/globals';

// FR 08-07 #13 — the 60s fast lane must run its status-refresh sync for every
// active workspace, even when assignment polling (isEnabled/pollForUnassigned)
// is off. Assignment polling itself stays self-gated inside syncService.

const cronScheduleMock = jest.fn(() => ({ stop: jest.fn() }));
const syncServiceMock = {
  syncAssignmentCandidatesNow: jest.fn(),
  performFullSync: jest.fn(),
};
const assignmentRepositoryMock = {
  getConfig: jest.fn(),
};

jest.unstable_mockModule('node-cron', () => ({
  default: { schedule: cronScheduleMock },
}));
jest.unstable_mockModule('../src/services/syncService.js', () => ({
  default: syncServiceMock,
}));
jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({
  default: assignmentRepositoryMock,
}));
jest.unstable_mockModule('../src/services/vacationTrackerService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/vacationTrackerRepository.js', () => ({ default: { getConfig: jest.fn() } }));
jest.unstable_mockModule('../src/services/calendarLeaveService.js', () => ({ default: { getConfig: jest.fn() } }));
jest.unstable_mockModule('../src/services/syncLogRepository.js', () => ({
  default: { createLog: jest.fn(), completeLog: jest.fn(), failLog: jest.fn(), getLatestSuccessful: jest.fn() },
}));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({
  default: { getAllActive: jest.fn() },
}));
jest.unstable_mockModule('../src/services/emailPollingService.js', () => ({
  default: { startAll: jest.fn() },
}));
jest.unstable_mockModule('../src/services/assignmentDailyReviewService.js', () => ({
  default: { maybeRunScheduledReview: jest.fn() },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: scheduledSyncService } = await import('../src/services/scheduledSyncService.js');

// Grab the cron callback registered by startAssignmentFastSyncForWorkspace.
async function startLaneAndGetTick() {
  cronScheduleMock.mockClear();
  await scheduledSyncService.startAssignmentFastSyncForWorkspace({ id: 3, name: 'AR' });
  expect(cronScheduleMock).toHaveBeenCalledTimes(1);
  return cronScheduleMock.mock.calls[0][1];
}

describe('assignment fast-sync lane — status refresh decoupled from polling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.FAST_STATUS_REFRESH;
    syncServiceMock.syncAssignmentCandidatesNow.mockResolvedValue({
      status: 'completed', ticketsFetched: 0, ticketsSynced: 0, polling: { triggered: 0 },
    });
  });

  afterEach(() => {
    scheduledSyncService.stopAssignmentFastSyncForWorkspace(3);
    delete process.env.FAST_STATUS_REFRESH;
  });

  test('runs the sync even when assignment polling is disabled (pollForUnassigned off)', async () => {
    assignmentRepositoryMock.getConfig.mockResolvedValue({ isEnabled: true, pollForUnassigned: false });
    const tick = await startLaneAndGetTick();

    await tick();

    expect(syncServiceMock.syncAssignmentCandidatesNow).toHaveBeenCalledWith(3, expect.objectContaining({
      lookbackMinutes: 30,
      maxTickets: 50,
    }));
  });

  test('runs the sync even when the assignment engine is fully disabled (no config)', async () => {
    assignmentRepositoryMock.getConfig.mockResolvedValue(null);
    const tick = await startLaneAndGetTick();

    await tick();

    expect(syncServiceMock.syncAssignmentCandidatesNow).toHaveBeenCalledWith(3, expect.objectContaining({
      maxPipelineRuns: 5,
    }));
  });

  test('still runs (unchanged) when assignment polling is enabled', async () => {
    assignmentRepositoryMock.getConfig.mockResolvedValue({ isEnabled: true, pollForUnassigned: true, pollMaxPerCycle: 7 });
    const tick = await startLaneAndGetTick();

    await tick();

    expect(syncServiceMock.syncAssignmentCandidatesNow).toHaveBeenCalledWith(3, expect.objectContaining({
      maxPipelineRuns: 7,
    }));
  });

  test('FAST_STATUS_REFRESH=false restores the old gate for polling-off workspaces', async () => {
    process.env.FAST_STATUS_REFRESH = 'false';
    assignmentRepositoryMock.getConfig.mockResolvedValue({ isEnabled: false, pollForUnassigned: false });
    const tick = await startLaneAndGetTick();

    await tick();

    expect(syncServiceMock.syncAssignmentCandidatesNow).not.toHaveBeenCalled();
  });

  test('FAST_STATUS_REFRESH=false does NOT gate workspaces with polling enabled', async () => {
    process.env.FAST_STATUS_REFRESH = 'false';
    assignmentRepositoryMock.getConfig.mockResolvedValue({ isEnabled: true, pollForUnassigned: true });
    const tick = await startLaneAndGetTick();

    await tick();

    expect(syncServiceMock.syncAssignmentCandidatesNow).toHaveBeenCalled();
  });
});
