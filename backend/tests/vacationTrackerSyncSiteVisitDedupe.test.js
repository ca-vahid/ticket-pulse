import { jest } from '@jest/globals';

/**
 * The hourly Vacation Tracker leave sync (technician_leaves), 25 Nov 2026: a
 * leave-day that repeats a Vacation Pulse row (same person, day and kind of
 * leave, by the type its name maps to) is not written a second time, and an
 * earlier copy is cleaned up as stale. Invented people only.
 */

const vtRepo = {
  getConfig: jest.fn(),
  getLeaveTypes: jest.fn(),
  getMappedUsersByWorkspace: jest.fn(),
  getAvailabilityRows: jest.fn(),
  getAvailabilityLeaveTypes: jest.fn(),
  bulkUpsertLeaves: jest.fn(),
  deleteStaleLeaves: jest.fn(),
  updateLastSyncAt: jest.fn(),
};
const fetchLeaves = jest.fn();
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../src/services/vacationTrackerRepository.js', () => ({ default: vtRepo }));
jest.unstable_mockModule('../src/services/technicianRepository.js', () => ({ default: { getAllActive: jest.fn() } }));
jest.unstable_mockModule('../src/integrations/vacationTracker.js', () => ({ default: jest.fn(() => ({ fetchLeaves })) }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../src/services/availability/vtWriteBack.js', () => ({
  default: { ownedLeaveIds: jest.fn(async () => new Set()), cancelledHereExternalIds: jest.fn(async () => new Set()) },
}));

const { default: service } = await import('../src/services/vacationTrackerService.js');

const day = (k) => new Date(`${k}T00:00:00Z`);

beforeEach(() => {
  jest.clearAllMocks();
  vtRepo.getConfig.mockResolvedValue({ apiKey: 'vt-test-key' });
  vtRepo.getLeaveTypes.mockResolvedValue([
    { vtLeaveTypeId: 'lt-site', vtLeaveTypeName: 'Business Trip', category: 'OTHER' },
    { vtLeaveTypeId: 'lt-vac', vtLeaveTypeName: 'PTO', category: 'OFF' },
  ]);
  vtRepo.getMappedUsersByWorkspace.mockResolvedValue([{ vtUserId: 'u1', technicianId: 11 }, { vtUserId: 'u2', technicianId: 12 }]);
  vtRepo.getAvailabilityLeaveTypes.mockResolvedValue([
    { id: 4, name: 'Site visit', availability: 'ONSITE', vtLeaveTypeNames: ['site visit', 'business trip'] },
    { id: 1, name: 'Vacation', availability: 'OFF', vtLeaveTypeNames: ['vacation', 'pto'] },
  ]);
  // Ari booked the Toronto visit in Vacation Pulse for Tue 1 + Wed 2 Dec.
  vtRepo.getAvailabilityRows.mockResolvedValue([
    { technicianId: 11, leaveDate: day('2099-12-01'), leaveTypeName: 'Site visit', category: 'OTHER', vtLeaveId: 'av:9001:w1' },
    { technicianId: 11, leaveDate: day('2099-12-02'), leaveTypeName: 'Site visit', category: 'OTHER', vtLeaveId: 'av:9001:w1' },
  ]);
  vtRepo.bulkUpsertLeaves.mockResolvedValue([]);
  vtRepo.deleteStaleLeaves.mockResolvedValue({ count: 2 });
});

test('the twice-booked visit is skipped day by day; other people and other types are written', async () => {
  fetchLeaves.mockResolvedValue([
    // Ari, same visit in Vacation Tracker, Mon 30 Nov – Wed 2 Dec: only Mon is new.
    { id: 'leaveRequest-a1', userId: 'u1', leaveTypeId: 'lt-site', startDate: '2099-11-30', endDate: '2099-12-02', status: 'APPROVED' },
    // Ari, vacation on Wed 2 Dec: a different kind, written.
    { id: 'leaveRequest-a2', userId: 'u1', leaveTypeId: 'lt-vac', startDate: '2099-12-02', endDate: '2099-12-02', status: 'APPROVED' },
    // Bo, a site visit of his own: written.
    { id: 'leaveRequest-b1', userId: 'u2', leaveTypeId: 'lt-site', startDate: '2099-12-01', endDate: '2099-12-01', status: 'APPROVED' },
  ]);
  const out = await service.syncLeaves(1, '2099-11-25', '2099-12-31');
  const written = vtRepo.bulkUpsertLeaves.mock.calls[0][0].map((r) => `${r.vtLeaveId}|${r.leaveDate.toISOString().slice(0, 10)}`);
  expect(written).toEqual(['leaveRequest-a1|2099-11-30', 'leaveRequest-a2|2099-12-02', 'leaveRequest-b1|2099-12-01']);
  expect(out.duplicateDaysSkipped).toBe(2);
  // The skipped days are not "valid", so an earlier copy of them is removed as stale.
  const validKeys = vtRepo.deleteStaleLeaves.mock.calls[0][3];
  expect(validKeys.has('leaveRequest-a1|2099-12-01')).toBe(false);
  expect(validKeys.has('leaveRequest-a1|2099-11-30')).toBe(true);
  expect(loggerMock.info).toHaveBeenCalledWith(expect.stringContaining('2 leave-day(s) skipped, already booked in Vacation Pulse'));
});

test('a morning booked here is not the full day in Vacation Tracker: the full day is written (and so never cleaned up)', async () => {
  vtRepo.getAvailabilityRows.mockResolvedValue([
    { technicianId: 11, leaveDate: day('2099-12-01'), leaveTypeName: 'Vacation', category: 'OFF', vtLeaveId: 'av:9006:w1', isFullDay: false, halfDayPart: 'AM', startMinute: 0, endMinute: 720 },
    { technicianId: 12, leaveDate: day('2099-12-01'), leaveTypeName: 'Vacation', category: 'OFF', vtLeaveId: 'av:9007:w1', isFullDay: false, halfDayPart: 'AM', startMinute: 480, endMinute: 720 },
  ]);
  fetchLeaves.mockResolvedValue([
    // Ari: full-day PTO in Vacation Tracker against a morning here — written.
    { id: 'leaveRequest-a1', userId: 'u1', leaveTypeId: 'lt-vac', startDate: '2099-12-01', endDate: '2099-12-01', status: 'APPROVED' },
    // Bo: the same morning, same minutes — skipped.
    { id: 'leaveRequest-b1', userId: 'u2', leaveTypeId: 'lt-vac', startDate: '2099-12-01', endDate: '2099-12-01', status: 'APPROVED', isFullDayLeave: false, startHour: 8, startMinute: 0, endHour: 12, endMinute: 0 },
  ]);
  const out = await service.syncLeaves(1, '2099-11-25', '2099-12-31');
  expect(vtRepo.bulkUpsertLeaves.mock.calls[0][0].map((r) => r.vtLeaveId)).toEqual(['leaveRequest-a1']);
  expect(vtRepo.deleteStaleLeaves.mock.calls[0][3].has('leaveRequest-a1|2099-12-01')).toBe(true);
  expect(out.duplicateDaysSkipped).toBe(1);
});

test('when Vacation Pulse rows cannot be read, the sync still runs (nothing skipped)', async () => {
  vtRepo.getAvailabilityRows.mockRejectedValue(new Error('db down'));
  fetchLeaves.mockResolvedValue([{ id: 'leaveRequest-a1', userId: 'u1', leaveTypeId: 'lt-site', startDate: '2099-12-01', endDate: '2099-12-01', status: 'APPROVED' }]);
  const out = await service.syncLeaves(1, '2099-11-25', '2099-12-31');
  expect(vtRepo.bulkUpsertLeaves.mock.calls[0][0]).toHaveLength(1);
  expect(out.duplicateDaysSkipped).toBe(0);
  expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('duplicates are not skipped this run'));
});
