import { jest } from '@jest/globals';

/**
 * Close resolved tickets (17 Oct 2026): Ticket Pulse tickets that stayed
 * Resolved for the workspace's chosen time are closed through changeStatus;
 * off by default; a failed settings read is OFF; a ticket that cannot close
 * is skipped for a while instead of retried every pass.
 */
const store = new Map();
const prismaMock = {
  ticket: { findMany: jest.fn(), count: jest.fn() },
  workspace: { findMany: jest.fn() },
};
const changeStatus = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: { get: jest.fn(async (k) => store.get(k) ?? null), set: jest.fn(async (k, v) => { store.set(k, v); }) },
}));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: { statusNamesForBase: jest.fn(async (_ws, bases) => (bases.includes('Resolved') ? ['Resolved', 'Fixed'] : ['Closed'])) },
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: { changeStatus } }));

const { default: service, parseSettings, afterLabel, settingKey, ACTOR } = await import('../src/services/autoCloseResolvedService.js');
const settingsRepository = (await import('../src/services/settingsRepository.js')).default;

const NOW = new Date('2026-10-17T19:00:00Z');

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  service._failedAt = new Map();
  changeStatus.mockResolvedValue({ changed: true });
});

describe('settings', () => {
  test('off with 2 days by default; only offered times are kept', () => {
    expect(parseSettings(null)).toEqual(expect.objectContaining({ enabled: false, afterHours: 48 }));
    expect(parseSettings('{"enabled":true,"afterHours":24}')).toEqual(expect.objectContaining({ enabled: true, afterHours: 24 }));
    expect(parseSettings('{"enabled":true,"afterHours":5}').afterHours).toBe(48);
    expect(parseSettings('not json').enabled).toBe(false);
  });

  test('labels read as words', () => {
    expect([1, 4, 24, 48, 72, 168].map(afterLabel)).toEqual(['1 hour', '4 hours', '1 day', '2 days', '3 days', '1 week']);
  });

  test('save rejects a time that is not offered and records who changed it', async () => {
    await expect(service.setSettings(31, { afterHours: 5 })).rejects.toThrow(/Choose one of/);
    const saved = await service.setSettings(31, { enabled: true, afterHours: 72 }, { email: 'admin@example.com' });
    expect(saved).toEqual(expect.objectContaining({ enabled: true, afterHours: 72, changedBy: 'admin@example.com' }));
    expect(JSON.parse(store.get(settingKey(31))).enabled).toBe(true);
  });

  test('a settings read that fails counts as OFF', async () => {
    settingsRepository.get.mockRejectedValueOnce(new Error('db down'));
    expect((await service.getSettings(32)).enabled).toBe(false);
  });
});

describe('closeDue', () => {
  test('off: nothing is looked at', async () => {
    expect(await service.closeDue(41, NOW)).toEqual({ closed: 0, failed: 0 });
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
  });

  test('on: Ticket Pulse tickets in a Resolved-base status past the time close to Closed as the auto-close actor', async () => {
    store.set(settingKey(42), JSON.stringify({ enabled: true, afterHours: 48 }));
    prismaMock.ticket.findMany.mockResolvedValue([{ id: 1, nativeNumber: 10, origin: 'ticketpulse' }, { id: 2, nativeNumber: 11, origin: 'ticketpulse' }]);
    const out = await service.closeDue(42, NOW);
    expect(out).toEqual({ closed: 2, failed: 0 });
    const { where } = prismaMock.ticket.findMany.mock.calls[0][0];
    expect(where).toEqual(expect.objectContaining({ workspaceId: 42, origin: 'ticketpulse', status: { in: ['Resolved', 'Fixed'] } }));
    const cutoff = new Date(NOW.getTime() - 48 * 3600e3);
    expect(where.OR[0]).toEqual({ resolvedAt: { lte: cutoff } });
    expect(changeStatus).toHaveBeenCalledWith(1, 42, 'Closed', ACTOR);
    expect(changeStatus).toHaveBeenCalledWith(2, 42, 'Closed', ACTOR);
  });

  test('a ticket that cannot close (open child) is skipped on the next passes, the rest still close', async () => {
    store.set(settingKey(43), JSON.stringify({ enabled: true, afterHours: 24 }));
    prismaMock.ticket.findMany.mockResolvedValue([{ id: 7, nativeNumber: 70, origin: 'ticketpulse' }, { id: 8, nativeNumber: 80, origin: 'ticketpulse' }]);
    changeStatus.mockImplementation(async (id) => { if (id === 7) throw new Error('This ticket has open child tickets'); return { changed: true }; });
    expect(await service.closeDue(43, NOW)).toEqual({ closed: 1, failed: 1 });
    changeStatus.mockClear();
    await service.closeDue(43, new Date(NOW.getTime() + 5 * 60e3));
    expect(changeStatus).not.toHaveBeenCalledWith(7, expect.anything(), expect.anything(), expect.anything());
  });
});

describe('sweep', () => {
  test('only workspaces that have it on; sandboxes are never looked at', async () => {
    prismaMock.workspace.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    store.set(settingKey(1), JSON.stringify({ enabled: true, afterHours: 48 }));
    prismaMock.ticket.findMany.mockResolvedValue([{ id: 5, nativeNumber: 5, origin: 'ticketpulse' }]);
    const out = await service.sweep(NOW);
    expect(out).toEqual({ workspaces: 1, closed: 1, failed: 0 });
    expect(prismaMock.workspace.findMany.mock.calls[0][0].where.id.notIn).toEqual([6, 7, 8, 9]);
  });
});
