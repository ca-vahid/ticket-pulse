import { jest } from '@jest/globals';

/**
 * Realtime plan Phase 3 — sync liveness self-monitoring:
 * - ok / late / stale derivation from last completed sync vs scheduler cadence
 *   (stale = >3× interval, floored at 15 minutes; scheduler-mirroring interval
 *   validation).
 * - The monitor alerts admins ONCE per stale incident and re-arms only after
 *   the workspace recovers to ok (non-spammy by construction).
 */

const getAllActiveMock = jest.fn();
const getLatestSuccessfulMock = jest.fn();
const settingsGetMock = jest.fn();
const sendTransactionalEmailMock = jest.fn();

jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({
  default: { getAllActive: getAllActiveMock },
}));
jest.unstable_mockModule('../src/services/syncLogRepository.js', () => ({
  default: { getLatestSuccessful: getLatestSuccessfulMock },
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
} = await import('../src/services/syncHealthService.js');

const NOW = Date.parse('2026-08-15T18:00:00Z');
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();

beforeEach(() => {
  jest.clearAllMocks();
  settingsGetMock.mockResolvedValue('admin@bgc.ca, ops@bgc.ca');
  sendTransactionalEmailMock.mockResolvedValue({ sent: true, via: 'sendgrid' });
  delete process.env.SYNC_HEALTH_ALERTS;
});

describe('classifySyncFreshness — ok / late / stale', () => {
  test('5m interval uses the floors: ok ≤10m, late ≤15m, stale >15m', () => {
    expect(classifySyncFreshness(4 * 60000, 5)).toBe('ok');
    expect(classifySyncFreshness(LATE_FLOOR_MS - 1, 5)).toBe('ok');
    expect(classifySyncFreshness(LATE_FLOOR_MS + 1, 5)).toBe('late');
    expect(classifySyncFreshness(STALE_FLOOR_MS - 1, 5)).toBe('late');
    expect(classifySyncFreshness(STALE_FLOOR_MS + 1, 5)).toBe('stale');
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
  });

  test('overall is ok when every workspace is fresh', async () => {
    getAllActiveMock.mockResolvedValue([{ id: 1, name: 'IT', syncIntervalMinutes: 5 }]);
    getLatestSuccessfulMock.mockResolvedValue({ completedAt: minsAgo(2) });
    const service = new SyncHealthService();
    const health = await service.getHealth(NOW);
    expect(health.overall).toBe('ok');
  });
});

describe('checkAndAlert — one alert per stale incident', () => {
  function staleThenRecoverSetup() {
    getAllActiveMock.mockResolvedValue([{ id: 2, name: 'Accounting', syncIntervalMinutes: 5 }]);
    getLatestSuccessfulMock.mockResolvedValue({ completedAt: minsAgo(45) });
  }

  test('emails the admin list once, then stays quiet while still stale', async () => {
    staleThenRecoverSetup();
    const service = new SyncHealthService();

    const first = await service.checkAndAlert(NOW);
    expect(first.alerted).toEqual([2]);
    expect(sendTransactionalEmailMock).toHaveBeenCalledTimes(1);
    const call = sendTransactionalEmailMock.mock.calls[0][0];
    expect(call.to).toEqual(['admin@bgc.ca', 'ops@bgc.ca']);
    expect(call.subject).toContain('Accounting');
    expect(call.label).toBe('sync-health-alert');

    const second = await service.checkAndAlert(NOW + 5 * 60000);
    expect(second.alerted).toEqual([]);
    expect(sendTransactionalEmailMock).toHaveBeenCalledTimes(1);
  });

  test('recovery to ok re-arms the incident; a new stale alerts again', async () => {
    staleThenRecoverSetup();
    const service = new SyncHealthService();
    await service.checkAndAlert(NOW);
    expect(sendTransactionalEmailMock).toHaveBeenCalledTimes(1);

    // Recovered — a sync completed 2 minutes before the next check (NOW+10m).
    getLatestSuccessfulMock.mockResolvedValue({ completedAt: minsAgo(-8) });
    await service.checkAndAlert(NOW + 10 * 60000);
    expect(sendTransactionalEmailMock).toHaveBeenCalledTimes(1);

    // Goes stale again → second incident → second alert.
    getLatestSuccessfulMock.mockResolvedValue({ completedAt: minsAgo(50) });
    await service.checkAndAlert(NOW + 20 * 60000);
    expect(sendTransactionalEmailMock).toHaveBeenCalledTimes(2);
  });

  test('late (not stale) never alerts; unknown never alerts', async () => {
    getAllActiveMock.mockResolvedValue([
      { id: 1, name: 'IT', syncIntervalMinutes: 5 },
      { id: 3, name: 'New Space', syncIntervalMinutes: 5 },
    ]);
    getLatestSuccessfulMock.mockImplementation(async (wsId) => (wsId === 1 ? { completedAt: minsAgo(12) } : null));

    const service = new SyncHealthService();
    const result = await service.checkAndAlert(NOW);
    expect(result.health.workspaces[0].status).toBe('late');
    expect(result.alerted).toEqual([]);
    expect(sendTransactionalEmailMock).not.toHaveBeenCalled();
  });

  test('SYNC_HEALTH_ALERTS=false latches the incident but sends nothing', async () => {
    process.env.SYNC_HEALTH_ALERTS = 'false';
    staleThenRecoverSetup();
    const service = new SyncHealthService();
    const result = await service.checkAndAlert(NOW);
    expect(result.alerted).toEqual([]);
    expect(sendTransactionalEmailMock).not.toHaveBeenCalled();
    // Still latched — flipping alerts back on later must not re-fire for the
    // same incident.
    delete process.env.SYNC_HEALTH_ALERTS;
    await service.checkAndAlert(NOW + 5 * 60000);
    expect(sendTransactionalEmailMock).not.toHaveBeenCalled();
  });

  test('falls back to ADMIN_EMAILS env when the setting is empty', async () => {
    settingsGetMock.mockResolvedValue(null);
    process.env.ADMIN_EMAILS = 'Fallback@bgc.ca';
    staleThenRecoverSetup();
    const service = new SyncHealthService();
    await service.checkAndAlert(NOW);
    expect(sendTransactionalEmailMock).toHaveBeenCalledWith(expect.objectContaining({ to: ['fallback@bgc.ca'] }));
    delete process.env.ADMIN_EMAILS;
  });

  test('a failed send does NOT turn into an alert storm (latched before sending)', async () => {
    sendTransactionalEmailMock.mockResolvedValue({ sent: false, error: 'smtp down' });
    staleThenRecoverSetup();
    const service = new SyncHealthService();
    await service.checkAndAlert(NOW);
    await service.checkAndAlert(NOW + 5 * 60000);
    expect(sendTransactionalEmailMock).toHaveBeenCalledTimes(1);
  });
});
