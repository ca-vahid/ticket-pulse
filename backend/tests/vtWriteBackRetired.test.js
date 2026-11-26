import { jest } from '@jest/globals';

/**
 * Retire Vacation Tracker (26 Nov 2026): once retired, the write-back never
 * calls Vacation Tracker — no new leave, no cancel, no hourly sweep — and
 * never throws. Invented people only.
 */

const prismaMock = {
  avSettings: { findUnique: jest.fn() },
  vacationTrackerConfig: { findMany: jest.fn() },
  avLeaveType: { findMany: jest.fn() },
  avRequest: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  avRequestEvent: { findFirst: jest.fn() },
  technicianLeave: { deleteMany: jest.fn() },
};
const store = new Map();
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: { get: jest.fn(async (k) => store.get(k) ?? null), set: jest.fn() } }));

const { default: wb } = await import('../src/services/availability/vtWriteBack.js');
const { VT_RETIRED_KEY } = await import('../src/services/availability/vtRetirement.js');

const day = (s) => new Date(`${s}T00:00:00Z`);
let client;
beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  process.env.AVAILABILITY_VT_WRITE_BACK = 'true';
  client = { listUsers: jest.fn(), listLeaveTypes: jest.fn(), listLeaves: jest.fn(), createLeave: jest.fn(), cancelLeave: jest.fn() };
  wb._client = () => client;
  wb._cache.clear();
  prismaMock.avSettings.findUnique.mockResolvedValue({ id: 1, vtWriteBackEnabled: true });
  prismaMock.vacationTrackerConfig.findMany.mockResolvedValue([{ workspaceId: 1, apiKey: 'vt_live_abc', apiKeyV2: null }]);
  prismaMock.avRequest.findMany.mockResolvedValue([]);
});
afterAll(() => { delete process.env.AVAILABILITY_VT_WRITE_BACK; });

test('on while Vacation Tracker is in use; off once retired', async () => {
  expect(await wb.enabled()).toBe(true);
  store.set(VT_RETIRED_KEY, JSON.stringify({ retiredAt: '2099-11-26T18:00:00.000Z' }));
  expect(await wb.enabled()).toBe(false);
});

test('retired: an approval, a cancel and the sweep all skip, with no Vacation Tracker call', async () => {
  store.set(VT_RETIRED_KEY, JSON.stringify({ retiredAt: '2099-11-26T18:00:00.000Z' }));
  prismaMock.avRequest.findUnique.mockResolvedValueOnce({ id: 1, email: 'casey.lee@example.com', leaveTypeId: 1, startDate: day('2099-12-01'), endDate: day('2099-12-01'), status: 'approved', source: 'app', externalId: null });
  expect(await wb.pushApproved(1)).toEqual({ skipped: 'off' });
  prismaMock.avRequest.findUnique.mockResolvedValueOnce({ id: 2, email: 'casey.lee@example.com', status: 'cancelled', source: 'app', externalId: 'vt:leave-1', events: [] });
  expect(await wb.pushCancelled(2)).toEqual({ skipped: 'off' });
  expect(await wb.sweep()).toEqual({ skipped: 'off' });
  expect(client.createLeave).not.toHaveBeenCalled();
  expect(client.cancelLeave).not.toHaveBeenCalled();
  expect(client.listUsers).not.toHaveBeenCalled();
  expect(prismaMock.avRequest.update).not.toHaveBeenCalled();
});
