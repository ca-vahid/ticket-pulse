import { jest } from '@jest/globals';

/**
 * QA 11-09, Availability:
 *   #1 the Vacation Tracker → Availability import runs by itself every 15
 *      minutes for every workspace with a key (the same syncFromVacationTracker
 *      as Settings → Import), one at a time, and never throws;
 *   #2 an approved upcoming leave imported from Vacation Tracker can be
 *      cancelled in Ticket Pulse; the cancel is written back when possible,
 *      and the import never brings it back.
 * Invented people only (example.com).
 */

const prismaMock = {
  technician: { findMany: jest.fn(), findFirst: jest.fn() },
  workspaceAccess: { findFirst: jest.fn(), findMany: jest.fn() },
  avApprovalGroupMember: { findMany: jest.fn() },
  avRequest: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
  avRequestEvent: { findMany: jest.fn() },
  avPerson: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
  avLeaveType: { findMany: jest.fn(), count: jest.fn(), upsert: jest.fn(), findUnique: jest.fn() },
  avOffice: { count: jest.fn() },
  avSettings: { findUnique: jest.fn(), create: jest.fn() },
  avHoliday: { findMany: jest.fn() },
  vacationTrackerConfig: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
  technicianLeave: { deleteMany: jest.fn(), create: jest.fn() },
};
const settingsMock = { get: jest.fn(), set: jest.fn() };
const wbMock = {
  pushCancelled: jest.fn(),
  pushApproved: jest.fn(),
  cancelledHereExternalIds: jest.fn(),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/availability/vtWriteBack.js', () => ({
  default: wbMock,
  isVtExternalId: (id) => String(id || '').startsWith('vt:'),
  cancelledInTicketPulse: (events) => {
    const c = (events || []).filter((e) => e.kind === 'cancelled');
    const last = c[c.length - 1];
    return Boolean(last) && last.details?.source !== 'vacation_tracker' && !last.details?.mergedInto;
  },
}));

const { default: svc } = await import('../src/services/availability/availabilityService.js');
const { toDay } = await import('../src/services/availability/availabilityRules.js');

const OWNER = { email: 'casey.lee@example.com', role: 'viewer' };
const OTHER = { email: 'robin.diaz@example.com', role: 'viewer' };
const FUTURE = '2099-12-02';
const vtRequest = (over = {}) => ({
  id: 301, email: 'casey.lee@example.com', leaveTypeId: 1, startDate: toDay(FUTURE), endDate: toDay(FUTURE), dayPart: 'full',
  status: 'approved', source: 'vacation_tracker', externalId: 'vt:leave-77', days: 1, hours: 8, events: [], ...over,
});

const savedEnv = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...savedEnv, AVAILABILITY_VT_IMPORT: 'true' };
  svc._vtImportRuns = 0;
  svc._vtImportChain = null;
  svc._scheduledVtImport = false;
  const store = new Map();
  settingsMock.get.mockImplementation(async (k) => store.get(k) ?? null);
  settingsMock.set.mockImplementation(async (k, v) => { store.set(k, String(v)); return {}; });
  prismaMock.workspaceAccess.findFirst.mockResolvedValue(null);
  prismaMock.workspaceAccess.findMany.mockResolvedValue([]);
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.technician.findMany.mockResolvedValue([]);
  prismaMock.avApprovalGroupMember.findMany.mockResolvedValue([]);
  prismaMock.avPerson.findMany.mockResolvedValue([]);
  prismaMock.technicianLeave.deleteMany.mockResolvedValue({ count: 1 });
  prismaMock.avRequest.update.mockImplementation(async ({ where, data }) => ({ ...vtRequest(), id: where.id, status: data.status }));
  wbMock.cancelledHereExternalIds.mockResolvedValue(new Set());
});
afterAll(() => { process.env = savedEnv; });

describe('#1 the automatic import', () => {
  beforeEach(() => {
    svc.syncFromVacationTracker = jest.fn().mockResolvedValue({ created: 1, updated: 0, cancelled: 0, skipped: 3, unmatched: 0 });
  });
  afterEach(() => { delete svc.syncFromVacationTracker; });

  test('runs the same import as the Import button for every workspace with a key, and skips one without', async () => {
    prismaMock.vacationTrackerConfig.findMany.mockResolvedValue([
      { workspaceId: 1, apiKey: 'vt_live_one' },
      { workspaceId: 2, apiKey: '' },
      { workspaceId: 4, apiKey: 'vt_live_four' },
    ]);
    const now = new Date('2026-11-09T18:00:00Z');
    const out = await svc.runScheduledVtImport({ now, gapMs: 0 });
    expect(svc.syncFromVacationTracker).toHaveBeenCalledTimes(2);
    expect(svc.syncFromVacationTracker).toHaveBeenCalledWith(1, { from: '2026-10-10', to: '2027-11-09', actorEmail: 'vacation_tracker' });
    expect(svc.syncFromVacationTracker).toHaveBeenCalledWith(4, expect.objectContaining({ from: '2026-10-10' }));
    expect(out.results).toEqual(expect.arrayContaining([{ workspaceId: 2, skipped: 'no_key' }]));
    // the time is kept for Settings → Import
    const saved = JSON.parse(settingsMock.set.mock.calls.at(-1)[1]);
    expect(saved['1'].auto).toMatchObject({ ok: true, created: 1 });
  });

  test('two workspaces sharing one key are read once', async () => {
    prismaMock.vacationTrackerConfig.findMany.mockResolvedValue([{ workspaceId: 1, apiKey: 'k' }, { workspaceId: 3, apiKey: 'k' }]);
    await svc.runScheduledVtImport({ gapMs: 0 });
    expect(svc.syncFromVacationTracker).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(settingsMock.set.mock.calls.at(-1)[1]);
    expect(Object.keys(saved).sort()).toEqual(['1', '3']);
  });

  test('a failure is a warning, never a throw, and the next workspace still runs', async () => {
    prismaMock.vacationTrackerConfig.findMany.mockResolvedValue([{ workspaceId: 1, apiKey: 'a' }, { workspaceId: 4, apiKey: 'b' }]);
    svc.syncFromVacationTracker.mockRejectedValueOnce(new Error('Vacation Tracker API error (503)'));
    const out = await svc.runScheduledVtImport({ gapMs: 0 });
    expect(out.results[0]).toMatchObject({ workspaceId: 1, error: 'Vacation Tracker API error (503)' });
    expect(svc.syncFromVacationTracker).toHaveBeenCalledTimes(2);
  });

  test('off outside production unless switched on, and the kill switch wins', async () => {
    prismaMock.vacationTrackerConfig.findMany.mockResolvedValue([{ workspaceId: 1, apiKey: 'a' }]);
    process.env = { ...savedEnv, NODE_ENV: 'test' };
    delete process.env.AVAILABILITY_VT_IMPORT;
    expect(await svc.runScheduledVtImport({ gapMs: 0 })).toEqual({ skipped: 'off' });
    process.env = { ...savedEnv, NODE_ENV: 'production', AVAILABILITY_VT_IMPORT: 'false' };
    expect(await svc.runScheduledVtImport({ gapMs: 0 })).toEqual({ skipped: 'off' });
    expect(svc.syncFromVacationTracker).not.toHaveBeenCalled();
  });

  test('a tick is skipped while an import is running; two ticks never overlap', async () => {
    prismaMock.vacationTrackerConfig.findMany.mockResolvedValue([{ workspaceId: 1, apiKey: 'a' }]);
    svc._vtImportRuns = 1; // the Import button is running
    const out = await svc.runScheduledVtImport({ gapMs: 0 });
    expect(out.results).toEqual([{ workspaceId: 1, skipped: 'busy' }]);
    svc._vtImportRuns = 0;
    let release;
    svc.syncFromVacationTracker.mockImplementation(() => new Promise((r) => { release = () => r({ created: 0 }); }));
    const first = svc.runScheduledVtImport({ gapMs: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(await svc.runScheduledVtImport({ gapMs: 0 })).toEqual({ skipped: 'running' });
    release();
    await first;
    expect(svc.syncFromVacationTracker).toHaveBeenCalledTimes(1);
  });
});

describe('#1 one import at a time', () => {
  test('a second import waits for the first (no two runs on the same leaves at once)', async () => {
    const order = [];
    let release;
    const inner = jest.spyOn(svc, '_syncFromVacationTracker')
      .mockImplementationOnce(() => new Promise((r) => { order.push('a start'); release = () => { order.push('a end'); r({ created: 1 }); }; }))
      .mockImplementationOnce(async () => { order.push('b start'); return { created: 0 }; });
    const a = svc.syncFromVacationTracker(1);
    const b = svc.syncFromVacationTracker(4);
    await new Promise((r) => setTimeout(r, 0));
    expect(svc.vtImportBusy()).toBe(true);
    expect(order).toEqual(['a start']);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(['a start', 'a end', 'b start']);
    expect(svc.vtImportBusy()).toBe(false);
    inner.mockRestore();
  });
});

describe('#1/#2 what the import does with Vacation Tracker leaves', () => {
  const client = (leaves) => ({
    fetchLeaveTypes: jest.fn().mockResolvedValue([{ id: 'lt-wfh', name: 'Working from home' }]),
    fetchUsers: jest.fn().mockResolvedValue([{ id: 'u1', email: 'casey.lee@example.com', name: 'Casey Lee' }]),
    fetchLeaves: jest.fn().mockResolvedValue(leaves),
  });
  beforeEach(() => {
    svc.ensureSeed = jest.fn().mockResolvedValue();
    svc.syncPeople = jest.fn().mockResolvedValue({});
    svc._holidays = jest.fn().mockResolvedValue([]);
    svc.project = jest.fn().mockResolvedValue({ written: 1 });
    svc.unproject = jest.fn().mockResolvedValue({ deleted: 1 });
    prismaMock.avLeaveType.findMany.mockResolvedValue([{ id: 3, key: 'wfh', name: 'Working from home', vtLeaveTypeNames: ['wfh', 'working from home'] }]);
    prismaMock.avPerson.findMany.mockResolvedValue([{ email: 'casey.lee@example.com', workdays: null, dailyHours: 8 }]);
    prismaMock.avRequest.create.mockResolvedValue({ id: 900, status: 'approved' });
  });
  afterEach(() => { delete svc.ensureSeed; delete svc.syncPeople; delete svc._holidays; delete svc.project; delete svc.unproject; });

  const leave = { id: 'leave-77', userId: 'u1', leaveTypeId: 'lt-wfh', startDate: FUTURE, endDate: FUTURE, status: 'APPROVED', isFullDayLeave: true };
  const imported = { id: 301, externalId: 'vt:leave-77', email: 'casey.lee@example.com', leaveTypeId: 3, startDate: toDay(FUTURE), endDate: toDay(FUTURE), dayPart: 'full', startMinute: null, endMinute: null };

  test('a new work-from-home day becomes an approved request', async () => {
    prismaMock.avRequest.findMany.mockResolvedValue([]);
    const out = await svc.syncFromVacationTracker(1, { from: '2099-11-01', to: '2099-12-31', client: client([leave]) });
    expect(out.created).toBe(1);
    expect(prismaMock.avRequest.create.mock.calls[0][0].data).toMatchObject({ status: 'approved', source: 'vacation_tracker', externalId: 'vt:leave-77', leaveTypeId: 3 });
  });

  test('a leave cancelled in Vacation Tracker (gone from the listing) cancels the request', async () => {
    prismaMock.avRequest.findMany.mockImplementation(async ({ where }) => (where.source === 'vacation_tracker' ? [{ ...imported, status: 'approved' }] : []));
    const other = { ...leave, id: 'leave-88', startDate: '2099-12-09', endDate: '2099-12-09' };
    const out = await svc.syncFromVacationTracker(1, { from: '2099-11-01', to: '2099-12-31', client: client([other]) });
    expect(out.cancelled).toBe(1);
    expect(prismaMock.avRequest.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 301 }, data: expect.objectContaining({ status: 'cancelled' }) }));
  });

  test('a leave cancelled in Ticket Pulse is never brought back while Vacation Tracker still lists it', async () => {
    prismaMock.avRequest.findMany.mockImplementation(async ({ where }) => (where.source === 'vacation_tracker' ? [{ ...imported, status: 'cancelled' }] : []));
    wbMock.cancelledHereExternalIds.mockResolvedValue(new Set(['vt:leave-77']));
    const out = await svc.syncFromVacationTracker(1, { from: '2099-11-01', to: '2099-12-31', client: client([leave]) });
    expect(out).toMatchObject({ created: 0, updated: 0, skipped: 1 });
    expect(prismaMock.avRequest.update).not.toHaveBeenCalled();
    expect(svc.project).not.toHaveBeenCalled();
  });
});

describe('#2 cancelling an imported leave', () => {
  beforeEach(() => {
    prismaMock.avRequest.findUnique.mockResolvedValue(vtRequest());
    svc.unproject = jest.fn().mockResolvedValue({ deleted: 1 });
    svc.getRequest = jest.fn().mockResolvedValue({ id: 301, status: 'cancelled' });
    svc._notifyRequester = jest.fn().mockResolvedValue();
    svc._teamsDecided = jest.fn().mockResolvedValue();
  });
  afterEach(() => { delete svc.unproject; delete svc.getRequest; delete svc._notifyRequester; delete svc._teamsDecided; });

  test('the owner cancels it; it is cancelled in Vacation Tracker too', async () => {
    wbMock.pushCancelled.mockResolvedValue({ ok: true });
    const out = await svc.cancelRequest(301, OWNER, 'Plans changed');
    expect(prismaMock.avRequest.update.mock.calls[0][0].data).toEqual({
      status: 'cancelled',
      events: { create: { kind: 'cancelled', actor: 'casey.lee@example.com', details: { reason: 'Plans changed', cancelledIn: 'ticket_pulse' } } },
    });
    expect(svc.unproject).toHaveBeenCalled();
    expect(prismaMock.technicianLeave.deleteMany).toHaveBeenCalledWith({ where: { vtLeaveId: 'leave-77' } });
    expect(wbMock.pushCancelled).toHaveBeenCalledWith(301, 'Plans changed');
    expect(out.vacationTracker).toEqual({ updated: true, message: 'Cancelled in Ticket Pulse and in Vacation Tracker.' });
  });

  test('when Vacation Tracker cannot be told, it says so plainly', async () => {
    wbMock.pushCancelled.mockResolvedValue({ skipped: 'off' });
    const out = await svc.cancelRequest(301, OWNER);
    expect(out.status).toBe('cancelled');
    expect(out.vacationTracker).toEqual({ updated: false, message: 'Cancelled in Ticket Pulse. Cancel it in Vacation Tracker too.' });
  });

  test('someone who neither owns, approves nor manages the person cannot cancel it', async () => {
    await expect(svc.cancelRequest(301, OTHER)).rejects.toThrow('You can only cancel your own requests');
    expect(prismaMock.avRequest.update).not.toHaveBeenCalled();
    expect(wbMock.pushCancelled).not.toHaveBeenCalled();
  });

  test('an admin who manages the person can cancel it', async () => {
    wbMock.pushCancelled.mockResolvedValue({ ok: true });
    const admin = { email: 'ops.admin@example.com', role: 'admin' };
    const out = await svc.cancelRequest(301, admin);
    expect(out.vacationTracker.updated).toBe(true);
  });

  test('time away that is over cannot be cancelled', async () => {
    prismaMock.avRequest.findUnique.mockResolvedValue(vtRequest({ startDate: toDay('2020-01-06'), endDate: toDay('2020-01-06') }));
    await expect(svc.cancelRequest(301, OWNER)).rejects.toThrow(/already over/);
    expect(prismaMock.avRequest.update).not.toHaveBeenCalled();
  });

  test('a request booked in Ticket Pulse cancels as before (write-back not awaited, no message)', async () => {
    prismaMock.avRequest.findUnique.mockResolvedValue(vtRequest({ source: 'app', externalId: 'vt:leave-12' }));
    wbMock.pushCancelled.mockReturnValue(new Promise(() => {})); // never settles: must not be awaited
    const out = await svc.cancelRequest(301, OWNER, null);
    expect(prismaMock.avRequest.update.mock.calls[0][0].data.events.create.details).toBeNull();
    expect(wbMock.pushCancelled).toHaveBeenCalledWith(301, null);
    expect(prismaMock.technicianLeave.deleteMany).not.toHaveBeenCalled();
    expect(out.vacationTracker).toBeUndefined();
  });
});

describe('#2 My requests says when Vacation Tracker still has it', () => {
  test('cancelled here only → stillInVacationTracker; cancelled there too → not', async () => {
    svc.ensurePerson = jest.fn().mockResolvedValue({ email: 'casey.lee@example.com' });
    svc.getSettings = jest.fn().mockResolvedValue({ yearStartMonth: 1 });
    prismaMock.avRequest.findMany.mockResolvedValue([
      vtRequest({ id: 1, status: 'cancelled' }),
      vtRequest({ id: 2, status: 'cancelled', externalId: 'vt:leave-2' }),
      vtRequest({ id: 3, status: 'cancelled', externalId: 'vt:leave-3' }),
    ]);
    prismaMock.avRequestEvent.findMany.mockResolvedValue([
      { id: 10, requestId: 1, kind: 'cancelled', details: { cancelledIn: 'ticket_pulse' } },
      { id: 11, requestId: 2, kind: 'cancelled', details: { cancelledIn: 'ticket_pulse' } },
      { id: 12, requestId: 2, kind: 'vt_cancelled', details: {} },
      { id: 13, requestId: 3, kind: 'cancelled', details: { source: 'vacation_tracker' } },
    ]);
    const rows = await svc.listMine(OWNER, { year: 2099 });
    expect(rows.map((r) => [r.id, r.stillInVacationTracker])).toEqual([[1, true], [2, false], [3, false]]);
    delete svc.ensurePerson;
    delete svc.getSettings;
  });
});

describe('#1 Settings → Import status', () => {
  test('admins see whether it runs and when it last ran', async () => {
    settingsMock.get.mockImplementation(async (k) => (k === 'availability_vt_import_status' ? JSON.stringify({ 1: { auto: { at: '2026-11-09T18:04:00.000Z', ok: true } } }) : 'ops.admin@example.com'));
    const out = await svc.vtImportStatus({ email: 'ops.admin@example.com', role: 'admin' });
    expect(out).toEqual({ automatic: true, everyMinutes: 15, workspaces: { 1: { auto: { at: '2026-11-09T18:04:00.000Z', ok: true } } } });
    await expect(svc.vtImportStatus(OWNER)).rejects.toThrow(/administrators/);
  });
});
