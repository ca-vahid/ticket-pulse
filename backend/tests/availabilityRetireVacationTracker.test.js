import { jest } from '@jest/globals';

/**
 * Retire Vacation Tracker (26 Nov 2026), the Vacation Pulse side:
 *   - only a super admin can retire it;
 *   - the one-time handover: upcoming bookings imported from Vacation Tracker
 *     are projected like app bookings ('av:' rows from today on), the
 *     leave-days the old sync wrote for them from today on are replaced, the
 *     ones nothing covers are kept and listed, past days are never touched,
 *     and a second run changes nothing;
 *   - once retired the import and the write-back never call Vacation Tracker,
 *     and its bookings are changed and cancelled here like any other.
 * Invented people, ids and leave ids only (example.com, year 2099).
 */

// ---------------------------------------------------------------- technician_leaves, in memory
let leaves = [];
let nextLeaveId = 1;
const sameDay = (a, b) => new Date(a).getTime() === new Date(b).getTime();
function matchesString(value, cond) {
  if (cond === undefined) return true;
  if (typeof cond === 'string') return value === cond;
  if (cond.startsWith !== undefined) return String(value).startsWith(cond.startsWith);
  if (cond.in) return cond.in.includes(value);
  return true;
}
function matches(row, where = {}) {
  if (where.id?.in && !where.id.in.includes(row.id)) return false;
  if (where.workspaceId !== undefined && row.workspaceId !== where.workspaceId) return false;
  if (where.technicianId?.in && !where.technicianId.in.includes(row.technicianId)) return false;
  if (!matchesString(row.vtLeaveId, where.vtLeaveId)) return false;
  const d = where.leaveDate;
  if (d instanceof Date && !sameDay(row.leaveDate, d)) return false;
  if (d?.gte && row.leaveDate < d.gte) return false;
  if (d?.lte && row.leaveDate > d.lte) return false;
  if (d?.lt && row.leaveDate >= d.lt) return false;
  if (where.NOT) {
    const nots = Array.isArray(where.NOT) ? where.NOT : [where.NOT];
    if (nots.some((n) => matches(row, n))) return false;
  }
  if (where.OR && !where.OR.some((o) => matches(row, o))) return false;
  return true;
}
const technicianLeave = {
  findMany: jest.fn(async ({ where } = {}) => leaves.filter((r) => matches(r, where)).map((r) => ({ ...r }))),
  count: jest.fn(async ({ where } = {}) => leaves.filter((r) => matches(r, where)).length),
  create: jest.fn(async ({ data }) => { const row = { id: nextLeaveId++, ...data }; leaves.push(row); return row; }),
  deleteMany: jest.fn(async ({ where } = {}) => {
    const before = leaves.length;
    leaves = leaves.filter((r) => !matches(r, where));
    return { count: before - leaves.length };
  }),
};

const prismaMock = {
  technicianLeave,
  technician: { findMany: jest.fn(), findFirst: jest.fn() },
  workspaceAccess: { findFirst: jest.fn(), findMany: jest.fn() },
  avApprovalGroupMember: { findMany: jest.fn() },
  avRequest: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn() },
  avRequestEvent: { create: jest.fn(), findMany: jest.fn() },
  avPerson: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
  avLeaveType: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
  avOffice: { count: jest.fn(), findUnique: jest.fn() },
  avSettings: { findUnique: jest.fn(), create: jest.fn() },
  holiday: { findMany: jest.fn() },
  vacationTrackerConfig: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
  $transaction: jest.fn(async (arg) => (typeof arg === 'function' ? arg(prismaMock) : Promise.all(arg))),
};
const store = new Map();
const settingsMock = { get: jest.fn(async (k) => store.get(k) ?? null), set: jest.fn(async (k, v) => { store.set(k, String(v)); }) };
const wbMock = { pushCancelled: jest.fn(), pushApproved: jest.fn(), cancelledHereExternalIds: jest.fn(async () => new Set()) };
const vtClient = { fetchLeaveTypes: jest.fn(), fetchUsers: jest.fn(), fetchLeaves: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/vacationTrackerService.js', () => ({ default: { getSyncStatus: () => ({ running: false }) } }));
jest.unstable_mockModule('../src/services/availability/vtWriteBack.js', () => ({
  default: wbMock,
  isVtExternalId: (id) => String(id || '').startsWith('vt:'),
  cancelledInTicketPulse: () => true,
}));

const { default: svc } = await import('../src/services/availability/availabilityService.js');
const { VT_RETIRED_KEY } = await import('../src/services/availability/vtRetirement.js');

const SUPER = { email: 'super.admin@example.com', name: 'Sam Super', role: 'admin' };
const WS_ADMIN = { email: 'ws.admin@example.com', name: 'Wes Admin', role: 'admin' };
const CASEY = { email: 'casey.lee@example.com', name: 'Casey Lee', role: 'agent' };
// Thu 3 Dec 2099, noon in BC.
const NOW = new Date('2099-12-03T20:00:00Z');
const day = (k) => new Date(`${k}T00:00:00Z`);
const keyOf = (r) => `${r.vtLeaveId}|${r.leaveDate.toISOString().slice(0, 10)}|t${r.technicianId}`;
const range = (from, to) => {
  const out = [];
  for (let d = day(from); d <= day(to); d = new Date(d.getTime() + 86400000)) out.push(d.toISOString().slice(0, 10));
  return out;
};
const directRow = (vtLeaveId, technicianId, k, over = {}) => ({
  id: nextLeaveId++, workspaceId: 1, technicianId, vtLeaveId, leaveDate: day(k), leaveTypeName: 'PTO', category: 'OFF', status: 'APPROVED',
  isFullDay: true, halfDayPart: null, startMinute: null, endMinute: null, ...over,
});

let requests;
const vtRequest = (over = {}) => ({
  id: 501, email: 'casey.lee@example.com', leaveTypeId: 1, startDate: day('2099-11-30'), endDate: day('2099-12-08'), dayPart: 'full',
  startMinute: null, endMinute: null, days: 7, hours: 56, status: 'approved', source: 'vacation_tracker', externalId: 'vt:leave-a1', events: [], ...over,
});
const TYPES = [
  { id: 1, name: 'Vacation', availability: 'OFF', vtLeaveTypeNames: ['vacation', 'pto'] },
  { id: 3, name: 'Working from home', availability: 'WFH', vtLeaveTypeNames: ['wfh'] },
];

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  store.set('admin_emails', SUPER.email);
  nextLeaveId = 1;
  svc._vtImportChain = null;
  svc._vtImportRuns = 0;
  svc._scheduledVtImport = false;
  const events = new Map();
  requests = [
    // Casey: Mon 30 Nov – Tue 8 Dec, imported from Vacation Tracker, under way.
    vtRequest(),
    // Robin: imported, already over — not handed over.
    vtRequest({ id: 502, email: 'robin.diaz@example.com', externalId: 'vt:leave-r2', startDate: day('2099-11-16'), endDate: day('2099-11-20') }),
  ];
  prismaMock.avRequest.findMany.mockImplementation(async ({ where } = {}) => requests
    .filter((r) => (!where?.source || r.source === where.source)
      && (!where?.status?.in || where.status.in.includes(r.status))
      && (!where?.endDate?.gte || r.endDate >= where.endDate.gte))
    .map((r) => ({ ...r, events: events.get(r.id) || [] })));
  prismaMock.avRequestEvent.create.mockImplementation(async ({ data }) => {
    events.set(data.requestId, [...(events.get(data.requestId) || []), { id: Date.now(), kind: data.kind }]);
    return data;
  });
  prismaMock.avRequestEvent.findMany.mockResolvedValue([]);
  prismaMock.avRequest.count.mockResolvedValue(1);
  prismaMock.avLeaveType.findUnique.mockImplementation(async ({ where }) => TYPES.find((t) => t.id === where.id) || null);
  prismaMock.avLeaveType.findMany.mockResolvedValue(TYPES);
  prismaMock.avPerson.findUnique.mockImplementation(async ({ where }) => ({ id: 7, email: where.email, name: 'Casey Lee', workdays: [1, 2, 3, 4, 5], dailyHours: 8 }));
  prismaMock.avPerson.findMany.mockResolvedValue([]);
  prismaMock.holiday.findMany.mockResolvedValue([]);
  prismaMock.technician.findMany.mockImplementation(async ({ where } = {}) => {
    const all = [{ id: 11, workspaceId: 1, name: 'Casey Lee', email: 'casey.lee@example.com' }, { id: 13, workspaceId: 1, name: 'Jo Park', email: 'jo.park@example.com' }];
    if (where?.id?.in) return all.filter((t) => where.id.in.includes(t.id));
    if (where?.email?.equals) return all.filter((t) => t.email === where.email.equals.toLowerCase()).map(({ id, workspaceId }) => ({ id, workspaceId }));
    return [];
  });
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.workspaceAccess.findFirst.mockResolvedValue(null);
  prismaMock.workspaceAccess.findMany.mockResolvedValue([]);
  prismaMock.avApprovalGroupMember.findMany.mockResolvedValue([]);
  prismaMock.avSettings.findUnique.mockResolvedValue({ id: 1, yearStartMonth: 1, vtWriteBackEnabled: true });
  prismaMock.vacationTrackerConfig.findMany.mockImplementation(async ({ where } = {}) => (where?.syncEnabled ? [{ workspaceId: 1 }] : [{ workspaceId: 1, syncEnabled: true, apiKey: 'vt-test-key', lastSyncAt: new Date('2099-12-03T19:00:00Z') }]));

  leaves = [
    // The old sync wrote Casey's leave for every calendar day, weekend included.
    ...range('2099-11-30', '2099-12-08').map((k) => directRow('leave-a1', 11, k)),
    // Jo's leave has no booking in Vacation Pulse (not mapped there).
    directRow('leave-b9', 13, '2099-12-10'),
    // Casey: a day she also booked in Vacation Pulse (the 'av:' row), and a past one.
    directRow('leave-c3', 11, '2099-12-09'),
    { ...directRow('av:600:w1', 11, '2099-12-09'), leaveTypeName: 'Vacation' },
    directRow('leave-z0', 13, '2099-11-25'),
    // The shared calendar's own row: never Vacation Tracker's.
    directRow('graph:abc:13', 13, '2099-12-11', { leaveTypeName: 'Out of office' }),
  ];
});

describe('the switch is for super admins', () => {
  test('a workspace admin (or anyone else) is refused, and nothing changes', async () => {
    const before = leaves.length;
    await expect(svc.retireVacationTracker(WS_ADMIN, { now: NOW })).rejects.toMatchObject({ statusCode: 403 });
    await expect(svc.retireVacationTracker(CASEY, { now: NOW })).rejects.toThrow(/super admins/);
    expect(store.has(VT_RETIRED_KEY)).toBe(false);
    expect(leaves).toHaveLength(before);
  });

  test('the status is for Vacation Pulse admins, and says who may retire', async () => {
    const status = await svc.vtRetirementStatus(SUPER);
    expect(status).toMatchObject({ retired: null, upcomingFromVt: 1, syncing: true, canRetire: true, writeBackEnabled: true });
    expect(JSON.stringify(status)).not.toContain('vt-test-key');
    await expect(svc.vtRetirementStatus(CASEY)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('the handover', () => {
  test('upcoming imported bookings move to Vacation Pulse; covered leave-days are replaced, the rest kept; the past is untouched', async () => {
    const pastBefore = leaves.filter((r) => r.leaveDate < day('2099-12-03')).map(keyOf).sort();
    const out = await svc.retireVacationTracker(SUPER, { now: NOW });

    expect(out).toMatchObject({ retiredAt: NOW.toISOString(), retiredBy: SUPER.email, retiredByName: 'Sam Super', handedOver: 1 });
    // Casey's four upcoming working days (Thu, Fri, Mon, Tue) + the day booked twice.
    expect(out.directRowsReplaced).toBe(5);
    // Per person-day (review 26 Nov): the weekend inside her leave has no
    // Vacation Pulse row, so its old rows stay (she is away, not available).
    expect(out.keptUnmatched).toEqual([
      { technicianId: 11, technicianName: 'Casey Lee', workspaceId: 1, leaveType: 'PTO', category: 'OFF', dates: ['2099-12-05', '2099-12-06'] },
      { technicianId: 13, technicianName: 'Jo Park', workspaceId: 1, leaveType: 'PTO', category: 'OFF', dates: ['2099-12-10'] },
    ]);

    // Casey's booking now has its own rows, working days from today on only.
    const own = leaves.filter((r) => r.vtLeaveId === 'av:501:w1').map((r) => r.leaveDate.toISOString().slice(0, 10)).sort();
    expect(own).toEqual(['2099-12-03', '2099-12-04', '2099-12-07', '2099-12-08']);
    // Every row the old sync wrote before today is exactly as it was; none from today on but the kept one.
    expect(leaves.filter((r) => r.leaveDate < day('2099-12-03') && !r.vtLeaveId.startsWith('av:')).map(keyOf).sort()).toEqual(pastBefore);
    expect(leaves.filter((r) => r.leaveDate >= day('2099-12-03') && !r.vtLeaveId.startsWith('av:') && !r.vtLeaveId.startsWith('graph:')).map(keyOf).sort())
      .toEqual(['leave-a1|2099-12-05|t11', 'leave-a1|2099-12-06|t11', 'leave-b9|2099-12-10|t13']);
    // The shared calendar's row is not Vacation Tracker's.
    expect(leaves.some((r) => r.vtLeaveId === 'graph:abc:13')).toBe(true);
    // The over booking was not touched; the moved one is marked.
    expect(prismaMock.avRequestEvent.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.avRequestEvent.create.mock.calls[0][0].data).toMatchObject({ requestId: 501, kind: 'vt_handed_over', actor: SUPER.email });

    // The switch is on, with the report.
    const saved = JSON.parse(store.get(VT_RETIRED_KEY));
    expect(saved).toMatchObject({ retiredAt: NOW.toISOString(), retiredBy: SUPER.email, syncedWorkspaceIds: [1], report: { handedOver: 1, directRowsReplaced: 5 } });
  });

  test('a company holiday inside the leave keeps its old row; so does another kind of leave on a covered day', async () => {
    // Mon 7 Dec is a holiday: the booking writes no row that day.
    prismaMock.holiday.findMany.mockResolvedValue([{ date: day('2099-12-07'), name: 'Founders Day', isRecurring: false, isEnabled: true }]);
    // Fri 4 Dec: a working-from-home day in Vacation Tracker beside the vacation one.
    leaves.push(directRow('leave-w5', 11, '2099-12-04', { leaveTypeName: 'WFH', category: 'WFH' }));
    const out = await svc.retireVacationTracker(SUPER, { now: NOW });
    const own = leaves.filter((r) => r.vtLeaveId === 'av:501:w1').map((r) => r.leaveDate.toISOString().slice(0, 10)).sort();
    expect(own).toEqual(['2099-12-03', '2099-12-04', '2099-12-08']);
    const left = leaves.filter((r) => r.leaveDate >= day('2099-12-03') && !r.vtLeaveId.startsWith('av:') && !r.vtLeaveId.startsWith('graph:')).map(keyOf).sort();
    expect(left).toEqual([
      'leave-a1|2099-12-05|t11', 'leave-a1|2099-12-06|t11', 'leave-a1|2099-12-07|t11',
      'leave-b9|2099-12-10|t13', 'leave-w5|2099-12-04|t11',
    ]);
    // Thu, Fri, Tue of the vacation + the day booked twice.
    expect(out.directRowsReplaced).toBe(4);
    expect(out.keptUnmatched).toEqual(expect.arrayContaining([
      expect.objectContaining({ technicianId: 11, leaveType: 'WFH', dates: ['2099-12-04'] }),
      expect.objectContaining({ technicianId: 11, leaveType: 'PTO', dates: ['2099-12-05', '2099-12-06', '2099-12-07'] }),
    ]));
  });

  test('two clicks at once run one handover; both get its report', async () => {
    const [a, b] = await Promise.all([
      svc.retireVacationTracker(SUPER, { now: NOW }),
      svc.retireVacationTracker(SUPER, { now: NOW }),
    ]);
    expect(b).toBe(a);
    expect(prismaMock.avRequestEvent.create).toHaveBeenCalledTimes(1);
    expect(settingsMock.set.mock.calls.filter(([k]) => k === VT_RETIRED_KEY)).toHaveLength(2); // switch on, then the report
  });

  test('projection fails closed: an unreadable switch rewrites nothing', async () => {
    leaves.push(directRow('av:501:w1', 11, '2099-12-03', { leaveTypeName: 'Vacation' }));
    const before = leaves.map(keyOf).sort();
    settingsMock.get.mockImplementation(async (k) => { if (k === VT_RETIRED_KEY) throw new Error('db blip'); return store.get(k) ?? null; });
    await expect(svc.project(requests[0])).rejects.toThrow(/could not read/);
    expect(leaves.map(keyOf).sort()).toEqual(before);
    settingsMock.get.mockImplementation(async (k) => store.get(k) ?? null);
  });

  test('projection is atomic: a failed write keeps the rows it had', async () => {
    store.set(VT_RETIRED_KEY, JSON.stringify({ retiredAt: NOW.toISOString(), syncedWorkspaceIds: [1] }));
    await svc.project(requests[0]);
    const before = leaves.map(keyOf).sort();
    const snapshot = leaves.map((r) => ({ ...r }));
    prismaMock.$transaction.mockImplementationOnce(async (fn) => {
      try { return await fn(prismaMock); } catch (err) { leaves = snapshot; throw err; } // a rollback
    });
    technicianLeave.create.mockRejectedValueOnce(new Error('connection lost'));
    await expect(svc.project(requests[0])).rejects.toThrow('connection lost');
    expect(leaves.map(keyOf).sort()).toEqual(before);
    expect(prismaMock.$transaction).toHaveBeenCalled();
  });

  test('a second run is a no-op: nothing more moved or removed, the first retirement kept', async () => {
    await svc.retireVacationTracker(SUPER, { now: NOW });
    const after = leaves.map(keyOf).sort();
    const again = await svc.retireVacationTracker({ ...SUPER, name: 'Someone Else' }, { now: new Date('2099-12-03T22:00:00Z') });
    expect(again).toMatchObject({ retiredAt: NOW.toISOString(), retiredByName: 'Sam Super', handedOver: 0, directRowsReplaced: 0 });
    expect(again.keptUnmatched.map((k) => k.technicianId)).toEqual([11, 13]);
    expect(leaves.map(keyOf).sort()).toEqual(after);
  });

  test('re-projecting a moved booking later never writes its past days again', async () => {
    await svc.retireVacationTracker(SUPER, { now: NOW });
    await svc.project(requests[0]);
    const own = leaves.filter((r) => r.vtLeaveId === 'av:501:w1').map((r) => r.leaveDate.toISOString().slice(0, 10)).sort();
    expect(own).toEqual(['2099-12-03', '2099-12-04', '2099-12-07', '2099-12-08']);
  });
});

describe('once retired', () => {
  beforeEach(() => store.set(VT_RETIRED_KEY, JSON.stringify({ retiredAt: NOW.toISOString(), retiredBy: SUPER.email, syncedWorkspaceIds: [1] })));

  test('the import reads nothing from Vacation Tracker and changes nothing', async () => {
    const out = await svc.syncFromVacationTracker(1, { client: vtClient });
    expect(out).toMatchObject({ retired: true, created: 0, cancelled: 0 });
    expect(vtClient.fetchLeaves).not.toHaveBeenCalled();
    expect(prismaMock.avRequest.update).not.toHaveBeenCalled();
    process.env.AVAILABILITY_VT_IMPORT = 'true';
    try {
      expect(await svc.runScheduledVtImport({ gapMs: 0 })).toEqual({ skipped: 'retired' });
    } finally {
      delete process.env.AVAILABILITY_VT_IMPORT;
    }
    expect(await svc.importFromVacationTracker(SUPER, { workspaceId: 1 }, { client: vtClient })).toMatchObject({ retired: true });
    expect(vtClient.fetchUsers).not.toHaveBeenCalled();
  });

  test('a booking from there can be changed while waiting, like any other', async () => {
    prismaMock.avRequest.findUnique.mockResolvedValue(vtRequest({ status: 'pending', email: CASEY.email }));
    await expect(svc._editableRequest(501, CASEY)).resolves.toMatchObject({ id: 501 });
    store.delete(VT_RETIRED_KEY);
    await expect(svc._editableRequest(501, CASEY)).rejects.toThrow(/Change it there/);
  });

  test('cancelling one never calls Vacation Tracker and leaves no "cancel it there too"', async () => {
    const row = vtRequest({ email: CASEY.email, startDate: day('2099-12-07'), endDate: day('2099-12-08') });
    prismaMock.avRequest.findUnique.mockImplementation(async ({ where }) => ({ ...row, id: where.id, events: [] }));
    prismaMock.avRequest.update.mockImplementation(async ({ data }) => ({ ...row, status: data.status }));
    // "Today" is Thu 3 Dec 2099 in BC; only the clock is faked.
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'performance'] });
    try {
      const out = await svc.cancelRequest(501, CASEY, 'plans changed');
      expect(out.vacationTracker).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
    expect(wbMock.pushCancelled).not.toHaveBeenCalled();
    // the old sync's rows of that leave go with it from today on; the days
    // already taken stay as history (review 26 Nov)
    expect(leaves.filter((r) => r.vtLeaveId === 'leave-a1').map((r) => r.leaveDate.toISOString().slice(0, 10)).sort())
      .toEqual(['2099-11-30', '2099-12-01', '2099-12-02']);
  });

  test('My time: the booking says it came from Vacation Tracker, can be changed, and nothing is "still there"', async () => {
    prismaMock.avRequest.findMany.mockResolvedValue([
      vtRequest({ status: 'pending', email: CASEY.email }),
      vtRequest({ id: 503, status: 'cancelled', email: CASEY.email }),
    ]);
    const rows = await svc.listMine(CASEY, { year: 2099 });
    expect(rows[0]).toMatchObject({ id: 501, editable: true, vtRetired: true });
    expect(rows[1].stillInVacationTracker).toBeUndefined();
    expect(prismaMock.avRequestEvent.findMany).not.toHaveBeenCalled();
  });

  test('the status says when and by whom; the history labels it "Booked in Vacation Tracker"', async () => {
    const status = await svc.vtRetirementStatus(SUPER);
    expect(status).toMatchObject({ retired: { retiredAt: NOW.toISOString(), retiredBy: SUPER.email }, syncing: false });
    const { vacationTrackerState } = await import('../src/services/availability/availabilityService.js');
    expect(vacationTrackerState({ source: 'vacation_tracker', status: 'approved' }, { retired: true }).label).toBe('Booked in Vacation Tracker');
    expect(vacationTrackerState({ source: 'app', status: 'approved', events: [] }, { retired: true }).label).toBe('Not sent: Vacation Tracker is retired');
    expect(vacationTrackerState({ source: 'vacation_tracker', status: 'approved' }).label).toBe('Came from Vacation Tracker');
  });
});
