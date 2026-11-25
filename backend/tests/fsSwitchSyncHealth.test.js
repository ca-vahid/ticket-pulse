import { jest } from '@jest/globals';

/**
 * FreshService switch (data-safety review, 25 Nov 2026): a workspace switched
 * OFF never syncs, so sync health must not call it stale, turn the banner red
 * or e-mail the admins (and the latch must not re-alert after a deploy). It is
 * listed as "FreshService off" and never counts towards `overall`.
 */

const modes = new Map();
jest.unstable_mockModule('../src/services/fsModeService.js', () => ({
  isFreshServiceOff: jest.fn(async (row) => modes.get(row.id) === 'off'),
}));
const getAllActive = jest.fn();
const getLatestSuccessful = jest.fn();
const sendTransactionalEmail = jest.fn().mockResolvedValue({ sent: true });
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({ default: { getAllActive } }));
jest.unstable_mockModule('../src/services/syncLogRepository.js', () => ({
  default: { getLatestSuccessful, getRunningSince: jest.fn().mockResolvedValue(new Map()) },
}));
jest.unstable_mockModule('../src/services/ticketRepository.js', () => ({ default: { getMaxLastIngestedAt: jest.fn().mockResolvedValue(new Map()) } }));
jest.unstable_mockModule('../src/services/syncService.js', () => ({ default: { runningWorkspaces: new Map() }, SYNC_LOCK_STALE_MS: 20 * 60 * 1000 }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: { get: jest.fn().mockResolvedValue('admin@example.com') } }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => ({ sendTransactionalEmail, default: { sendTransactionalEmail } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { SyncHealthService, STALE_TICKS_TO_ALERT } = await import('../src/services/syncHealthService.js');

const NOW = Date.parse('2026-12-02T18:00:00Z');
const it = { id: 1, name: 'IT', freshserviceWorkspaceId: 1000208180n, syncIntervalMinutes: 5 };
const pa = { id: 5, name: 'Project Accounting', freshserviceWorkspaceId: 1000208190n, syncIntervalMinutes: 5 };

beforeEach(() => {
  jest.clearAllMocks();
  modes.clear();
  getAllActive.mockResolvedValue([it, pa]);
  // IT synced a minute ago; Project Accounting last synced two days ago (switched off since).
  getLatestSuccessful.mockImplementation(async (ws) => ({ completedAt: new Date(ws === 1 ? NOW - 60_000 : NOW - 2 * 86_400_000) }));
});

test('an off workspace is listed as "FreshService off", never stale, and overall stays ok', async () => {
  modes.set(5, 'off');
  const health = await new SyncHealthService().getHealth(NOW);
  expect(health.overall).toBe('ok');
  const row = health.workspaces.find((w) => w.workspaceId === 5);
  expect(row).toMatchObject({ status: 'freshservice_off', statusLabel: 'FreshService off', freshserviceOff: true });
  expect(health.workspaces.find((w) => w.workspaceId === 1).status).toBe('ok');
  expect(getLatestSuccessful).not.toHaveBeenCalledWith(5);
});

test('no admin e-mail for an off workspace however many ticks pass', async () => {
  modes.set(5, 'off');
  const svc = new SyncHealthService();
  for (let i = 0; i < STALE_TICKS_TO_ALERT + 2; i += 1) {
    const { alerted } = await svc.checkAndAlert(NOW + i * 300_000);
    expect(alerted).toEqual([]);
  }
  expect(sendTransactionalEmail).not.toHaveBeenCalled();
});

test('control: the same two-day gap while connected IS stale', async () => {
  const health = await new SyncHealthService().getHealth(NOW);
  expect(health.workspaces.find((w) => w.workspaceId === 5).status).toBe('stale');
  expect(health.overall).toBe('stale');
});

test('switching off clears an old alert latch, so a rollback starts clean', async () => {
  const svc = new SyncHealthService();
  svc._alertedIncidents.set(5, '2026-12-01T00:00:00.000Z');
  modes.set(5, 'off');
  await svc.checkAndAlert(NOW);
  expect(svc._alertedIncidents.has(5)).toBe(false);
});
