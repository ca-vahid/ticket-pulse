import { jest } from '@jest/globals';

/**
 * Nightly IT history backfill (24 Sep 2026): one month per run, newest first,
 * quiet hours only, resumable, never advancing past a failed or cancelled month.
 */

const settings = new Map();
const backfillDateRange = jest.fn();
const syncServiceMock = { runningWorkspaces: new Map(), backfillDateRange };

jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: { get: jest.fn(async (k) => settings.get(k) ?? null), set: jest.fn(async (k, v) => { settings.set(k, v); }) },
}));
jest.unstable_mockModule('../src/services/syncService.js', () => ({ default: syncServiceMock }));

const { default: svc, monthWindow, DEFAULT_PLAN } = await import('../src/services/historyBackfillService.js');
const { isQuietHours } = await import('../src/utils/quietHours.js');

const WEEKDAY_NIGHT = new Date('2026-09-25T04:00:00Z'); // Thu 21:00 PT
const WEEKDAY_NOON = new Date('2026-09-24T19:00:00Z'); // Thu 12:00 PT
const state = () => JSON.parse(settings.get('history_backfill_state'));

beforeEach(() => {
  settings.clear();
  syncServiceMock.runningWorkspaces.clear();
  backfillDateRange.mockReset();
  svc.running = false;
});

describe('monthWindow', () => {
  test('newest month first, then the one before; the first month is clipped at the plan start', () => {
    expect(monthWindow('2024-12-31', '2023-09-01')).toEqual({ startDate: '2024-12-01', endDate: '2024-12-31', nextEnd: '2024-11-30', last: false });
    expect(monthWindow('2024-11-30', '2023-09-01')).toMatchObject({ startDate: '2024-11-01', nextEnd: '2024-10-31' });
    expect(monthWindow('2023-09-30', '2023-09-01')).toMatchObject({ startDate: '2023-09-01', last: true });
    expect(monthWindow('2023-09-30', '2023-09-15')).toMatchObject({ startDate: '2023-09-15', last: true });
  });
});

describe('quiet hours', () => {
  test('weekday evenings/nights and weekends only', () => {
    expect(isQuietHours(WEEKDAY_NIGHT)).toBe(true);
    expect(isQuietHours(WEEKDAY_NOON)).toBe(false);
    expect(isQuietHours(new Date('2026-09-26T19:00:00Z'))).toBe(true); // Sat noon PT
  });
});

describe('tick', () => {
  test('does nothing in working hours', async () => {
    await expect(svc.tick(WEEKDAY_NOON)).resolves.toEqual({ skipped: 'working_hours' });
    expect(backfillDateRange).not.toHaveBeenCalled();
  });

  test('runs Dec 2024 first for IT and moves on to Nov 2024', async () => {
    backfillDateRange.mockResolvedValue({ status: 'completed', ticketsFetched: 640, ticketsSynced: 612, skipped: 28 });
    const out = await svc.tick(WEEKDAY_NIGHT);
    expect(backfillDateRange).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 1, startDate: '2024-12-01', endDate: '2024-12-31', skipExisting: true }));
    expect(out).toMatchObject({ ok: true, synced: 612 });
    expect(state()).toMatchObject({ nextEnd: '2024-11-30', done: false });
    expect(state().runs).toHaveLength(1);
    expect(DEFAULT_PLAN.from).toBe('2023-09-01');
  });

  test('a failure keeps the month for the next tick', async () => {
    settings.set('history_backfill_state', JSON.stringify({ ...DEFAULT_PLAN, nextEnd: '2024-06-30', runs: [] }));
    backfillDateRange.mockRejectedValue(new Error('FreshService request timed out'));
    await svc.tick(WEEKDAY_NIGHT);
    expect(state()).toMatchObject({ nextEnd: '2024-06-30', failures: 1 });
  });

  test('a cancelled run pauses the plan without advancing', async () => {
    settings.set('history_backfill_state', JSON.stringify({ ...DEFAULT_PLAN, nextEnd: '2024-06-30', runs: [] }));
    backfillDateRange.mockResolvedValue({ status: 'cancelled' });
    await expect(svc.tick(WEEKDAY_NIGHT)).resolves.toEqual({ skipped: 'cancelled' });
    expect(state().nextEnd).toBe('2024-06-30');
    expect(settings.get('history_backfill_enabled')).toBe('false');
    await expect(svc.tick(WEEKDAY_NIGHT)).resolves.toEqual({ skipped: 'disabled' });
  });

  test('the last month completes the plan; nothing runs after', async () => {
    settings.set('history_backfill_state', JSON.stringify({ ...DEFAULT_PLAN, nextEnd: '2023-09-30', runs: [] }));
    backfillDateRange.mockResolvedValue({ status: 'completed', ticketsFetched: 805, ticketsSynced: 800, skipped: 5 });
    await svc.tick(WEEKDAY_NIGHT);
    expect(state().done).toBe(true);
    await expect(svc.tick(WEEKDAY_NIGHT)).resolves.toEqual({ skipped: 'done' });
  });

  test('waits while another backfill holds the workspace', async () => {
    syncServiceMock.runningWorkspaces.set('backfill:1', Date.now());
    await expect(svc.tick(WEEKDAY_NIGHT)).resolves.toEqual({ skipped: 'backfill_busy' });
    expect(backfillDateRange).not.toHaveBeenCalled();
  });
});
