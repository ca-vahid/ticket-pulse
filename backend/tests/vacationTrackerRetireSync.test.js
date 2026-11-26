import { jest } from '@jest/globals';

/**
 * Retire Vacation Tracker (26 Nov 2026), the legacy hourly leave sync:
 *   - once retired, no Vacation Tracker call and no clean-up (nothing deleted);
 *   - retired while a run was reading: nothing written, nothing deleted;
 *   - even when not retired, an EMPTY listing never cancels: a cancelled
 *     account that answers "no leaves" must not wipe the leave-days already
 *     written (the rule the Vacation Pulse import already follows).
 * Invented people and leave ids only.
 */

const vtRepo = {
  getConfig: jest.fn(),
  getLeaveTypes: jest.fn(),
  getMappedUsersByWorkspace: jest.fn(),
  getUserMappings: jest.fn(),
  getAvailabilityRows: jest.fn(),
  getAvailabilityLeaveTypes: jest.fn(),
  bulkUpsertLeaves: jest.fn(),
  deleteStaleLeaves: jest.fn(),
  countDirectLeaves: jest.fn(),
  updateLastSyncAt: jest.fn(),
};
const client = { fetchLeaves: jest.fn(), fetchLeaveTypes: jest.fn(), fetchUsers: jest.fn(), testConnection: jest.fn() };
const ClientCtor = jest.fn(() => client);
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const store = new Map();
const settingsMock = { get: jest.fn(async (k) => store.get(k) ?? null), set: jest.fn(async (k, v) => { store.set(k, String(v)); }) };

jest.unstable_mockModule('../src/services/vacationTrackerRepository.js', () => ({ default: vtRepo }));
jest.unstable_mockModule('../src/services/technicianRepository.js', () => ({ default: { getAllActive: jest.fn().mockResolvedValue([]) } }));
jest.unstable_mockModule('../src/integrations/vacationTracker.js', () => ({ default: ClientCtor }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/availability/vtWriteBack.js', () => ({
  default: { ownedLeaveIds: jest.fn(async () => new Set()), cancelledHereExternalIds: jest.fn(async () => new Set()) },
}));

const { default: service } = await import('../src/services/vacationTrackerService.js');
const { VT_RETIRED_KEY, isVacationTrackerRetired, getVacationTrackerRetirement } = await import('../src/services/availability/vtRetirement.js');

const retire = () => store.set(VT_RETIRED_KEY, JSON.stringify({ retiredAt: '2099-11-26T18:00:00.000Z', retiredBy: 'admin@example.com' }));

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  vtRepo.getConfig.mockResolvedValue({ apiKey: 'vt-test-key' });
  vtRepo.getLeaveTypes.mockResolvedValue([{ vtLeaveTypeId: 'lt-vac', vtLeaveTypeName: 'PTO', category: 'OFF' }]);
  vtRepo.getMappedUsersByWorkspace.mockResolvedValue([{ vtUserId: 'u1', technicianId: 11 }]);
  vtRepo.getAvailabilityRows.mockResolvedValue([]);
  vtRepo.getAvailabilityLeaveTypes.mockResolvedValue([]);
  vtRepo.bulkUpsertLeaves.mockResolvedValue([]);
  vtRepo.deleteStaleLeaves.mockResolvedValue({ count: 0 });
  vtRepo.countDirectLeaves.mockResolvedValue(0);
});

describe('the retired switch', () => {
  test('reads as off with no setting, on with a record, and off (never a throw) when unreadable', async () => {
    expect(await isVacationTrackerRetired()).toBe(false);
    retire();
    expect(await isVacationTrackerRetired()).toBe(true);
    expect(await getVacationTrackerRetirement()).toMatchObject({ retiredBy: 'admin@example.com' });
    settingsMock.get.mockRejectedValueOnce(new Error('db down'));
    expect(await isVacationTrackerRetired()).toBe(false);
    store.set(VT_RETIRED_KEY, 'not json');
    expect(await isVacationTrackerRetired()).toBe(false);
  });
});

describe('retired: every legacy Vacation Tracker call stops', () => {
  beforeEach(retire);

  test('the leave sync reads nothing and deletes nothing', async () => {
    const out = await service.syncLeaves(1, '2099-11-19', '2099-12-26');
    expect(out).toMatchObject({ skipped: 'retired', leaveDaysCreated: 0, staleRemoved: 0 });
    expect(ClientCtor).not.toHaveBeenCalled();
    expect(client.fetchLeaves).not.toHaveBeenCalled();
    expect(vtRepo.bulkUpsertLeaves).not.toHaveBeenCalled();
    expect(vtRepo.deleteStaleLeaves).not.toHaveBeenCalled();
    expect(vtRepo.updateLastSyncAt).not.toHaveBeenCalled();
  });

  test('the full sync, the leave-type and user syncs and the connection test return without calling it', async () => {
    expect(await service.fullSync(1)).toMatchObject({ skipped: 'retired' });
    expect(await service.syncLeaveTypes(1)).toEqual([]);
    expect(await service.syncUsers(1)).toEqual([]);
    expect(await service.testConnection('vt-test-key')).toMatchObject({ success: false, error: expect.stringContaining('retired') });
    expect(ClientCtor).not.toHaveBeenCalled();
    // logged once per caller, never thrown
    expect(loggerMock.info).toHaveBeenCalledWith(expect.stringContaining('Vacation Tracker is retired'));
  });

  test('retired while a run was reading: nothing is written and nothing is deleted', async () => {
    store.clear();
    client.fetchLeaves.mockImplementation(async () => { retire(); return [{ id: 'leave-a1', userId: 'u1', leaveTypeId: 'lt-vac', startDate: '2099-12-01', endDate: '2099-12-01', status: 'APPROVED' }]; });
    const out = await service.syncLeaves(1, '2099-11-19', '2099-12-26');
    expect(out).toMatchObject({ skipped: 'retired', leavesProcessed: 1 });
    expect(vtRepo.bulkUpsertLeaves).not.toHaveBeenCalled();
    expect(vtRepo.deleteStaleLeaves).not.toHaveBeenCalled();
  });
});

describe('not retired: an empty listing never cancels', () => {
  test('no leaves listed while leave-days are already there: the clean-up is skipped, with a warning', async () => {
    client.fetchLeaves.mockResolvedValue([]);
    vtRepo.countDirectLeaves.mockResolvedValue(105);
    const out = await service.syncLeaves(1, '2099-11-19', '2099-12-26');
    expect(vtRepo.deleteStaleLeaves).not.toHaveBeenCalled();
    expect(out.staleRemoved).toBe(0);
    expect(vtRepo.countDirectLeaves).toHaveBeenCalledWith(1, new Date('2099-11-19T00:00:00Z'), new Date('2099-12-26T00:00:00Z'));
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('an empty listing never cancels'));
  });

  test('no leaves listed and nothing there: the clean-up runs as before (it finds nothing)', async () => {
    client.fetchLeaves.mockResolvedValue([]);
    vtRepo.countDirectLeaves.mockResolvedValue(0);
    await service.syncLeaves(1, '2099-11-19', '2099-12-26');
    expect(vtRepo.deleteStaleLeaves).toHaveBeenCalledTimes(1);
  });

  test('a real listing still cleans up a leave that is gone', async () => {
    client.fetchLeaves.mockResolvedValue([{ id: 'leave-a1', userId: 'u1', leaveTypeId: 'lt-vac', startDate: '2099-12-01', endDate: '2099-12-01', status: 'APPROVED' }]);
    vtRepo.deleteStaleLeaves.mockResolvedValue({ count: 3 });
    const out = await service.syncLeaves(1, '2099-11-19', '2099-12-26');
    expect(vtRepo.countDirectLeaves).not.toHaveBeenCalled();
    expect(vtRepo.deleteStaleLeaves).toHaveBeenCalledTimes(1);
    expect(vtRepo.deleteStaleLeaves.mock.calls[0][3].has('leave-a1|2099-12-01')).toBe(true);
    expect(out.staleRemoved).toBe(3);
  });
});
