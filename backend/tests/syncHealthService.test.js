import { jest } from '@jest/globals';

/**
 * Realtime plan Phase 3 — sync liveness self-monitoring:
 * - ok / late / stale derivation from last completed sync vs scheduler cadence
 *   (stale = >3× interval, floored at 20 minutes; scheduler-mirroring interval
 *   validation).
 * - The monitor alerts admins ONCE per stale incident and re-arms only after
 *   the workspace recovers to ok (non-spammy by construction).
 *
 * Phase SH (2026-08-18 alert-storm fix) additions:
 * - A RUNNING sync counts as liveness (age = now - max(completed, runningSince))
 *   but a hung run (> SYNC_LOCK_STALE_MS) gets no credit and still goes stale.
 * - Fresh ticket ingest (dataFreshAt) blocks 'stale' — stale requires BOTH
 *   stale completions AND stale ingest.
 * - The email path is debounced: 3 consecutive stale ticks before it sends;
 *   any non-stale tick resets the counter. getHealth stays instantaneous.
 */

const getAllActiveMock = jest.fn();
const getLatestSuccessfulMock = jest.fn();
const getRunningSinceMock = jest.fn();
const getMaxLastIngestedAtMock = jest.fn();
const settingsGetMock = jest.fn();
const sendTransactionalEmailMock = jest.fn();

const SYNC_LOCK_STALE_MS = 20 * 60 * 1000;
const runningWorkspacesMock = new Map();

jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({
  default: { getAllActive: getAllActiveMock },
}));
jest.unstable_mockModule('../src/services/syncLogRepository.js', () => ({
  default: { getLatestSuccessful: getLatestSuccessfulMock, getRunningSince: getRunningSinceMock },
}));
jest.unstable_mockModule('../src/services/ticketRepository.js', () => ({
  default: { getMaxLastIngestedAt: getMaxLastIngestedAtMock },
}));
jest.unstable_mockModule('../src/services/syncService.js', () => ({
  default: { runningWorkspaces: runningWorkspacesMock },
  SYNC_LOCK_STALE_MS,
}));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: { get: settingsGetMock },
}));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => ({
  sendTransactionalEmail: sendTransactionalEmailMock,
  default: { sendTransactionalEmail: sendTransactionalEmailMock },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  SyncHealthService,
  classifySyncFreshness,
  effectiveIntervalMinutes,
  STALE_FLOOR_MS,
  LATE_FLOOR_MS,
  STALE_TICKS_TO_ALERT,
} = await import('../src/services/syncHealthService.js');

const NOW = Date.parse('2026-08-15T18:00:00Z');
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();
const TICK_MS = 5 * 60000;

/** Run enough monitor ticks (5m apart, starting at NOW) to pass the debounce. */
async function tickTimes(service, times, startAt = NOW) {
  let last = null;
  for (let i = 0; i < times; i++) {
    last = await service.checkAndAlert(startAt + i * TICK_MS);
  }
  return last;
}

beforeEach(() => {
  jest.clearAllMocks();
  runningWorkspacesMock.clear();
  settingsGetMock.mockResolvedValue('admin@bgc.ca, ops@bgc.ca');
  sendTransactionalEmailMock.mockResolvedValue({ sent: true, via: 'sendgrid' });
  getRunningSinceMock.mockResolvedValue(new Map());
  getMaxLastIngestedAtMock.mockResolvedValue(new Map());
  delete process.env.SYNC_HEALTH_ALERTS;
});

describe('classifySyncFreshness — ok / late / stale', () => {
  test('5m interval uses the floors: ok ≤10m, late ≤20m, stale >20m', () => {
    expect(classifySyncFreshness(4 * 60000, 5)).toBe('ok');
    expect(classifySyncFreshness(LATE_FLOOR_MS - 1, 5)).toBe('ok');
    expect(classifySyncFreshness(LATE_FLOOR_MS + 1, 5)).toBe('late');
    expect(classifySyncFreshness(STALE_FLOOR_MS - 1, 5)).toBe('late');
    expect(classifySyncFreshness(STALE_FLOOR_MS + 1, 5)).toBe('stale');
  });

  test('stale floor sits above the sync watchdog threshold (20m lock-stale)', () => {
    // The 2026-08-18 storm: a 15m floor below healthy 13m cycles + jitter
    // flapped ok↔stale. The floor must be ≥ SYNC_LOCK_STALE_MS so only a run
    // the watchdog itself would call hung can age a workspace into stale.
    expect(STALE_FLOOR_MS).toBeGreaterThanOrEqual(SYNC_LOCK_STALE_MS);
  });

  test('long intervals use the multipliers: 30m → late >60m, stale >90m', () => {
    expect(classifySyncFreshness(59 * 60000, 30)).toBe('ok');
    expect(classifySyncFreshness(61 * 60000, 30)).toBe('late');
    expect(classifySyncFreshness(89 * 60000, 30)).toBe('late');
    expect(classifySyncFreshness(91 * 60000, 30)).toBe('stale');
  });

  test('invalid intervals fall back to 5m (mirrors the scheduler validation)', () => {
    expect(effectiveIntervalMinutes(0)).toBe(5);
    expect(effectiveIntervalMinutes(120)).toBe(5);
    expect(effectiveIntervalMinutes(null)).toBe(5);
    expect(effectiveIntervalMinutes(15)).toBe(15);
  });
});

describe('getHealth — per-workspace derivation', () => {
  test('classifies each workspace and derives the worst overall status', async () => {
    getAllActiveMock.mockResolvedValue([
      { id: 1, name: 'IT', syncIntervalMinutes: 5 },
      { id: 2, name: 'Accounting', syncIntervalMinutes: 5 },
      { id: 3, name: 'New Space', syncIntervalMinutes: 5 },
    ]);
    getLatestSuccessfulMock.mockImplementation(async (wsId) => {
      if (wsId === 1) return { completedAt: minsAgo(3) };
      if (wsId === 2) return { completedAt: minsAgo(45) };
      return null; // never synced
    });

    const service = new SyncHealthService();
    const health = await service.getHealth(NOW);

    expect(health.workspaces).toHaveLength(3);
    const byId = Object.fromEntries(health.workspaces.map((w) => [w.workspaceId, w]));
    expect(byId[1].status).toBe('ok');
    expect(byId[2].status).toBe('stale');
    expect(byId[3].status).toBe('unknown');
    expect(byId[3].lastSyncAt).toBeNull();
    expect(byId[2].ageMs).toBe(45 * 60000);
    expect(byId[1].thresholds.staleMs).toBe(STALE_FLOOR_MS);
    expect(health.overall).toBe('stale');
    // Phase SH fields are always present.
    expect(byId[1].syncRunning).toBe(false);
    expect(byId[1].runningSince).toBeNull();
    expect(byId[1].runningForMs).toBeNull();
    expect(byId[1].dataFreshAt).toBeNull();
  });

  test('overall is ok when every workspace is fresh', async () => {
    getAllActiveMock.mockResolvedValue([{ id: 1, name: 'IT', syncIntervalMinutes: 5 }]);
    getLatestSuccessfulMock.mockResolvedValue({ completedAt: minsAgo(2) });
    const service = new SyncHealthService();
    const health = await service.getHealth(NOW);
    expect(health.overall).toBe('ok');
  });

  test('a RUNNING sync counts as healthy even when the last completion has aged', async () => {
    // Accounting's real shape: 13-min full cycles on a 5-min cadence. The
    // previous completion is 25m old (past the stale floor) but a run started
    // 3m ago — the workspace is alive, not stale.
    getAllActiveMock.mockResolvedValue([{ id: 2, name: 'Accounting', syncIntervalMinutes: 5 }]);
    getLatestSuccessfulMock.mockResolvedValue({ completedAt: minsAgo(25) });
    getRunningSinceMock.mockResolvedValue(new Map([[2, new Date(NOW - 3 * 60000)]]));

    const service = new SyncHealthService();
    const health = await service.getHealth(NOW);
    const row = health.workspaces[0];

    expect(row.status).toBe('ok');
    expect(row.syncRunning).toBe(true);
    expect(row.runningForMs).toBe(3 * 60000);
    expect(row.runningSince).toBe(minsAgo(3));
    // ageMs keeps reporting the completion age — the card still shows it.
    expect(row.ageMs).toBe(25 * 60000);
  });

  test('a HUNG run (> lock-stale threshold) gets no credit and still goes stale', async () => {
    getAllActiveMock.mockResolvedValue([{ id: 2, name: 'Accounting', syncIntervalMinutes: 5 }]);
    getLatestSuccessfulMock.mockResolvedValue({ completedAt: minsAgo(45) });
    getRunningSinceMock.mockResolvedValue(new Map([[2, new Date(NOW - 25 * 60000)]]));

    const service = new SyncHealthService();
    const health = await service.getHealth(NOW);
    const row = health.workspaces[0];

    expect(row.status).toBe('stale');
    expect(row.syncRunning).toBe(false); // hung, not "syncing now"
    expect(row.runningForMs).toBe(25 * 60000); // but the run is still reported
  });

  test('falls back to the in-process lock map when no started row exists yet', async () => {
    getAllActiveMock.mockResolvedValue([{ id: 1, name: 'IT', syncIntervalMinutes: 5 }]);
    getLatestSuccessfulMock.mockResolvedValue({ completedAt: minsAgo(22) });
    runningWorkspacesMock.set(1, NOW - 2 * 60000);

    const service = new SyncHealthService();
    const health = await service.getHealth(NOW);
    expect(health.workspaces[0].syncRunning).toBe(true);
    expect(health.workspaces[0].status).toBe('ok');
  });

  test('fresh ticket ingest blocks stale (dashboards are NOT serving old data)', async () => {
    // Completions are stale (45m) but the 60s fast lane ingested tickets 2m
    // ago — downgrade to late (visible, non-alerting).
    getAllActiveMock.mockResolvedValue([{ id: 2, name: 'Accounting', syncIntervalMinutes: 5 }]);
    getLatestSuccessfulMock.mockResolvedValue({ completedAt: minsAgo(45) });
    getMaxLastIngestedAtMock.mockResolvedValue(new Map([[2, new Date(NOW - 2 * 60000)]]));

    const service = new SyncHealthService();
    const health = await service.getHealth(NOW);
    const row = health.workspaces[0];

    expect(row.status).toBe('late');
    expect(row.dataFreshAt).toBe(minsAgo(2));
    expect(row.dataAgeMs).toBe(2 * 60000);
  });

  test('stale ingest does NOT rescue stale completions; null ingest falls back to completions-only', async () => {
    getAllActiveMock.mockResolvedValue([
      { id: 2, name: 'Accounting', syncIntervalMinutes: 5 },
      { id: 4, name: 'Empty WS', syncIntervalMinutes: 5 },
    ]);
    getLatestSuccessfulMock.mockResolvedValue({ completedAt: minsAgo(45) });
    // ws2 last ingested 40m ago (also stale); ws4 has no tickets at all.
    getMaxLastIngestedAtMock.mockResolvedValue(new Map([[2, new Date(NOW - 40 * 60000)]]));

    const service = new SyncHealthService();
    const health = await service.getHealth(NOW);
    const byId = Object.fromEntries(health.workspaces.map((w) => [w.workspaceId, w]));
    expect(byId[2].status).toBe('stale');
    expect(byId[4].status).toBe('stale');
    expect(byId[4].dataFreshAt).toBeNull();
  });
});

describe('checkAndAlert — debounced, one alert per stale incident', () => {
  function staleThenRecoverSetup() {
    getAllActiveMock.mockResolvedValue([{ id: 2, name: 'Accounting', syncIntervalMinutes: 5 }]);
    getLatestSuccessfulMock.mockResolvedValue({ completedAt: minsAgo(45) });
  }

  test('two stale ticks send nothing; the third tick emails once, then stays quiet', async () => {
    staleThenRecoverSetup();
    const service = new SyncHealthService();

    const first = await service.checkAndAlert(NOW);
    expect(first.health.workspaces[0].status).toBe('stale'); // health shows truth immediately
    expect(first.alerted).toEqual([]);
    const second = await service.checkAndAlert(NOW + TICK_MS);
    expect(second.alerted).toEqual([]);
    expect(sendTransactionalEmailMock).not.toHaveBeenCalled();

    const third = await service.checkAndAlert(NOW + 2 * TICK_MS);
    expect(third.alerted).toEqual([2]);
    expect(sendTransactionalEmailMock).toHaveBeenCalledTimes(1);
    const call = sendTransactionalEmailMock.mock.calls[0][0];
    expect(call.to).toEqual(['admin@bgc.ca', 'ops@bgc.ca']);
    expect(call.subject).toContain('Accounting');
    expect(call.label).toBe('sync-health-alert');

    const fourth = await service.checkAndAlert(NOW + 3 * TICK_MS);
    expect(fourth.alerted).toEqual([]);
    expect(sendTransactionalEmailMock).toHaveBeenCalledTimes(1);
  });

  test('a non-stale tick resets the debounce counter', async () => {
    staleThenRecoverSetup();
    const service = new SyncHealthService();
    await service.checkAndAlert(NOW);
    await service.checkAndAlert(NOW + TICK_MS);

    // A sync completes → ok tick between the stale ticks.
    getLatestSuccessfulMock.mockResolvedValue({ completedAt: minsAgo(-9) });
    await service.checkAndAlert(NOW + 2 * TICK_MS);

    // Stale again: the counter restarted, so two more ticks still send nothing…
    getLatestSuccessfulMock.mockResolvedValue({ completedAt: minsAgo(60) });
    await service.checkAndAlert(NOW + 3 * TICK_MS);
    await service.checkAndAlert(NOW + 4 * TICK_MS);
    expect(sendTransactionalEmailMock).not.toHaveBeenCalled();
    // …and the third consecutive stale tick finally alerts.
    await service.checkAndAlert(NOW + 5 * TICK_MS);
    expect(sendTransactionalEmailMock).toHaveBeenCalledTimes(1);
  });

  test('recovery to ok re-arms the incident; a new confirmed stale alerts again', async () => {
    staleThenRecoverSetup();
    const service = new SyncHealthService();
    await tickTimes(service, STALE_TICKS_TO_ALERT);
    expect(sendTransactionalEmailMock).toHaveBeenCalledTimes(1);

    // Recovered — a sync completed 2 minutes before the next check.
    getLatestSuccessfulMock.mockResolvedValue({ completedAt: minsAgo(-18) });
    await service.checkAndAlert(NOW + 4 * TICK_MS);
    expect(sendTransactionalEmailMock).toHaveBeenCalledTimes(1);

    // Goes stale again → 3 confirmed ticks → second incident → second alert.
    getLatestSuccessfulMock.mockResolvedValue({ completedAt: minsAgo(90) });
    await tickTimes(service, STALE_TICKS_TO_ALERT, NOW + 5 * TICK_MS);
    expect(sendTransactionalEmailMock).toHaveBeenCalledTimes(2);
  });

  test('late (not stale) never alerts; unknown never alerts', async () => {
    getAllActiveMock.mockResolvedValue([
      { id: 1, name: 'IT', syncIntervalMinutes: 5 },
      { id: 3, name: 'New Space', syncIntervalMinutes: 5 },
    ]);
    getLatestSuccessfulMock.mockImplementation(async (wsId) => (wsId === 1 ? { completedAt: minsAgo(12) } : null));

    const service = new SyncHealthService();
    const first = await service.checkAndAlert(NOW);
    expect(first.health.workspaces[0].status).toBe('late');
    const result = await tickTimes(service, STALE_TICKS_TO_ALERT - 1, NOW + TICK_MS);
    expect(result.alerted).toEqual([]);
    expect(sendTransactionalEmailMock).not.toHaveBeenCalled();
  });

  test('a running sync suppresses the alert (workspace is healthy mid-run)', async () => {
    getAllActiveMock.mockResolvedValue([{ id: 2, name: 'Accounting', syncIntervalMinutes: 5 }]);
    getLatestSuccessfulMock.mockResolvedValue({ completedAt: minsAgo(45) });
    getRunningSinceMock.mockResolvedValue(new Map([[2, new Date(NOW - 4 * 60000)]]));

    const service = new SyncHealthService();
    const result = await tickTimes(service, STALE_TICKS_TO_ALERT);
    expect(result.alerted).toEqual([]);
    expect(sendTransactionalEmailMock).not.toHaveBeenCalled();
  });

  test('a hung run still alerts, and the email says so instead of advising "Sync now"', async () => {
    getAllActiveMock.mockResolvedValue([{ id: 2, name: 'Accounting', syncIntervalMinutes: 5 }]);
    getLatestSuccessfulMock.mockResolvedValue({ completedAt: minsAgo(60) });
    getRunningSinceMock.mockResolvedValue(new Map([[2, new Date(NOW - 30 * 60000)]]));
    getMaxLastIngestedAtMock.mockResolvedValue(new Map([[2, new Date(NOW - 50 * 60000)]]));

    const service = new SyncHealthService();
    await tickTimes(service, STALE_TICKS_TO_ALERT);
    expect(sendTransactionalEmailMock).toHaveBeenCalledTimes(1);
    const { html } = sendTransactionalEmailMock.mock.calls[0][0];
    expect(html).toContain('appears hung');
    expect(html).toContain('do not trigger "Sync now"');
    // Ages are measured at the alerting (third) tick, 10 min after NOW.
    expect(html).toContain('data last arrived 60 min ago');
    expect(html).not.toContain('consider "Sync now"');
  });

  test('with no run in flight the email still suggests "Sync now" and includes data freshness', async () => {
    getAllActiveMock.mockResolvedValue([{ id: 2, name: 'Accounting', syncIntervalMinutes: 5 }]);
    getLatestSuccessfulMock.mockResolvedValue({ completedAt: minsAgo(45) });
    getMaxLastIngestedAtMock.mockResolvedValue(new Map([[2, new Date(NOW - 44 * 60000)]]));

    const service = new SyncHealthService();
    await tickTimes(service, STALE_TICKS_TO_ALERT);
    const { html } = sendTransactionalEmailMock.mock.calls[0][0];
    expect(html).toContain('consider "Sync now"');
    // Ages are measured at the alerting (third) tick, 10 min after NOW.
    expect(html).toContain('data last arrived 54 min ago');
    expect(html).toContain('no run in flight');
  });

  test('SYNC_HEALTH_ALERTS=false latches the incident but sends nothing', async () => {
    process.env.SYNC_HEALTH_ALERTS = 'false';
    staleThenRecoverSetup();
    const service = new SyncHealthService();
    const result = await tickTimes(service, STALE_TICKS_TO_ALERT);
    expect(result.alerted).toEqual([]);
    expect(sendTransactionalEmailMock).not.toHaveBeenCalled();
    // Still latched — flipping alerts back on later must not re-fire for the
    // same incident.
    delete process.env.SYNC_HEALTH_ALERTS;
    await service.checkAndAlert(NOW + 3 * TICK_MS);
    expect(sendTransactionalEmailMock).not.toHaveBeenCalled();
  });

  test('falls back to ADMIN_EMAILS env when the setting is empty', async () => {
    settingsGetMock.mockResolvedValue(null);
    process.env.ADMIN_EMAILS = 'Fallback@bgc.ca';
    staleThenRecoverSetup();
    const service = new SyncHealthService();
    await tickTimes(service, STALE_TICKS_TO_ALERT);
    expect(sendTransactionalEmailMock).toHaveBeenCalledWith(expect.objectContaining({ to: ['fallback@bgc.ca'] }));
    delete process.env.ADMIN_EMAILS;
  });

  test('a failed send does NOT turn into an alert storm (latched before sending)', async () => {
    sendTransactionalEmailMock.mockResolvedValue({ sent: false, error: 'smtp down' });
    staleThenRecoverSetup();
    const service = new SyncHealthService();
    await tickTimes(service, STALE_TICKS_TO_ALERT + 1);
    expect(sendTransactionalEmailMock).toHaveBeenCalledTimes(1);
  });
});
