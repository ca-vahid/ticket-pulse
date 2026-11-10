import { jest } from '@jest/globals';

// 4 Oct 2026: the top-of-hour VT cron silently skipped 01:00 and 15:00 UTC.
// A 5-minute check now runs a catch-up when the last sync is > 70 min old,
// and the scheduled + catch-up runs never overlap.

const cronScheduleMock = jest.fn(() => ({ stop: jest.fn() }));
const vtRepo = { getConfig: jest.fn() };
const vtService = { fullSync: jest.fn() };
const syncLog = { createLog: jest.fn().mockResolvedValue({ id: 9 }), completeLog: jest.fn(), failLog: jest.fn().mockResolvedValue(), getLatestSuccessful: jest.fn() };
const avSync = jest.fn().mockResolvedValue({ created: 0 });
const avScheduled = jest.fn().mockResolvedValue({ results: [] });

jest.unstable_mockModule('node-cron', () => ({ default: { schedule: cronScheduleMock } }));
jest.unstable_mockModule('../src/services/syncService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({ default: { getConfig: jest.fn() } }));
jest.unstable_mockModule('../src/services/vacationTrackerService.js', () => ({ default: vtService }));
jest.unstable_mockModule('../src/services/vacationTrackerRepository.js', () => ({ default: vtRepo }));
jest.unstable_mockModule('../src/services/calendarLeaveService.js', () => ({ default: { getConfig: jest.fn() } }));
jest.unstable_mockModule('../src/services/syncLogRepository.js', () => ({ default: syncLog }));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({ default: { getAllActive: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentDailyReviewService.js', () => ({ default: { maybeRunScheduledReview: jest.fn() } }));
jest.unstable_mockModule('../src/services/availability/availabilityService.js', () => ({ default: { syncFromVacationTracker: avSync, runScheduledVtImport: avScheduled } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: scheduler, VT_STALE_MS } = await import('../src/services/scheduledSyncService.js');

const NOW = Date.parse('2026-10-04T15:20:00Z');

beforeEach(() => {
  jest.clearAllMocks();
  vtService.fullSync.mockResolvedValue({ leaveDaysCreated: 39, leavesProcessed: 25 });
});

test('a sync older than 70 minutes runs a catch-up (the Availability copy has its own job now)', async () => {
  vtRepo.getConfig.mockResolvedValue({ apiKey: 'vt_live_x', syncEnabled: true, lastSyncAt: new Date(NOW - 80 * 60000) });
  expect(await scheduler.vtCatchUp(1, 'IT', NOW)).toBe(true);
  expect(vtService.fullSync).toHaveBeenCalledWith(1);
  // QA 11-09 #1: no second path into syncFromVacationTracker from the hourly sync.
  expect(avSync).not.toHaveBeenCalled();
  expect(syncLog.completeLog).toHaveBeenCalledWith(9, { ticketsSynced: 39, techniciansSynced: 25 });
});

describe('QA 11-09 #1: the 15-minute Vacation Tracker → Availability import', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; scheduler.stopAvailabilityVtImport(); });

  test('is registered on plain quarter-hour minutes when on, and runs the Availability import', async () => {
    process.env.AVAILABILITY_VT_IMPORT = 'true';
    scheduler.startAvailabilityVtImport();
    const call = cronScheduleMock.mock.calls.find((c) => c[0] === '4,19,34,49 * * * *');
    expect(call).toBeTruthy();
    expect(call[2]).toMatchObject({ timezone: 'America/Vancouver' });
    await call[1]();
    expect(avScheduled).toHaveBeenCalledTimes(1);
  });

  test('is not registered outside production, or with the kill switch', () => {
    delete process.env.AVAILABILITY_VT_IMPORT;
    scheduler.startAvailabilityVtImport();
    process.env.NODE_ENV = 'production';
    process.env.AVAILABILITY_VT_IMPORT = 'false';
    scheduler.startAvailabilityVtImport();
    expect(cronScheduleMock).not.toHaveBeenCalled();
    expect(scheduler.availabilityVtImportJob).toBeNull();
  });

  test('a failing tick is a warning, never a throw', async () => {
    avScheduled.mockRejectedValueOnce(new Error('boom'));
    await expect(scheduler.runAvailabilityVtImport()).resolves.toEqual({ error: 'boom' });
  });
});

test('a fresh sync, or VT switched off, does nothing', async () => {
  vtRepo.getConfig.mockResolvedValue({ apiKey: 'k', syncEnabled: true, lastSyncAt: new Date(NOW - 20 * 60000) });
  expect(await scheduler.vtCatchUp(1, 'IT', NOW)).toBe(false);
  vtRepo.getConfig.mockResolvedValue({ apiKey: 'k', syncEnabled: false, lastSyncAt: null });
  expect(await scheduler.vtCatchUp(1, 'IT', NOW)).toBe(false);
  expect(vtService.fullSync).not.toHaveBeenCalled();
  expect(VT_STALE_MS).toBe(70 * 60 * 1000);
});

test('scheduled and catch-up runs never overlap', async () => {
  let release;
  vtService.fullSync.mockImplementation(() => new Promise((r) => { release = () => r({ leaveDaysCreated: 1, leavesProcessed: 1 }); }));
  const first = scheduler.runVTSync(1, 'IT', 'scheduled');
  await new Promise((r) => setTimeout(r, 0));
  expect(await scheduler.runVTSync(1, 'IT', 'catch-up')).toEqual({ skipped: true });
  release();
  await first;
  expect(vtService.fullSync).toHaveBeenCalledTimes(1);
});

test('a failed sync is logged as failed and frees the slot', async () => {
  vtService.fullSync.mockRejectedValueOnce(new Error('403 Forbidden'));
  expect(await scheduler.runVTSync(1, 'IT')).toEqual({ error: '403 Forbidden' });
  expect(syncLog.failLog).toHaveBeenCalledWith(9, '403 Forbidden');
  vtService.fullSync.mockResolvedValueOnce({ leaveDaysCreated: 2, leavesProcessed: 1 });
  expect(await scheduler.runVTSync(1, 'IT')).toMatchObject({ leaveDaysCreated: 2 });
});

test('starting the VT sync sets a cron and a catch-up timer; stopping clears both', async () => {
  vtRepo.getConfig.mockResolvedValue({ apiKey: 'k', syncEnabled: true, lastSyncAt: new Date() });
  await scheduler.startVTSyncForWorkspace({ id: 1, name: 'IT', defaultTimezone: 'America/Vancouver' });
  const entry = scheduler.vtCronJobs.get(1);
  expect(cronScheduleMock).toHaveBeenCalledWith('0 * * * *', expect.any(Function), expect.objectContaining({ timezone: 'America/Vancouver' }));
  expect(entry.watchdog).toBeTruthy();
  scheduler.stopVTSyncForWorkspace(1);
  expect(scheduler.vtCronJobs.has(1)).toBe(false);
});
