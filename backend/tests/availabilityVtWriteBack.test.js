import { jest } from '@jest/globals';

/**
 * Availability → Vacation Tracker write-back (13 Oct 2026): an approved
 * request is added to Vacation Tracker as an approved leave and cancelled
 * there when cancelled here; a failure never throws and is retried hourly.
 */

const prismaMock = {
  avSettings: { findUnique: jest.fn() },
  vacationTrackerConfig: { findMany: jest.fn() },
  avLeaveType: { findMany: jest.fn() },
  avRequest: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  technicianLeave: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: wb, vtTypeForAvType, avTypeForVtName, leaveBodyFor } = await import('../src/services/availability/vtWriteBack.js');

const AV_TYPES = [
  { id: 1, name: 'Vacation', vtLeaveTypeNames: ['vacation', 'pto', 'paid time off', 'holiday'] },
  { id: 2, name: 'Sick', vtLeaveTypeNames: ['sick', 'sick day', 'sick leave'] },
  { id: 3, name: 'Working from home', vtLeaveTypeNames: ['work from home', 'wfh', 'remote'] },
  { id: 9, name: 'Jury duty', vtLeaveTypeNames: [] },
];
const VT_TYPES = [
  { id: 'lt-pto', name: 'Personal Time Off (PTO)', isActive: true },
  { id: 'lt-vac', name: 'Vacation', isActive: true },
  { id: 'lt-sick', name: 'Sick Day', isActive: true },
  { id: 'lt-wfh', name: 'WFH', isActive: true },
];
const day = (s) => new Date(`${s}T00:00:00Z`);
const request = (over = {}) => ({ id: 140, email: 'Reza@bgc.ca', leaveTypeId: 1, startDate: day('2026-11-25'), endDate: day('2026-11-25'), dayPart: 'full', startMinute: null, endMinute: null, note: 'Car service.', status: 'approved', source: 'app', externalId: null, events: [], ...over });
const apiError = (status, code, details) => Object.assign(new Error(code), { response: { status, data: { error: { code, description: code, details } } } });

let client;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.AVAILABILITY_VT_WRITE_BACK = 'true';
  wb._cache.clear();
  client = {
    listUsers: jest.fn().mockResolvedValue([{ id: 'u-reza', email: 'reza@bgc.ca', status: 'ACTIVE' }]),
    listLeaveTypes: jest.fn().mockResolvedValue(VT_TYPES),
    listLeaves: jest.fn().mockResolvedValue([]),
    createLeave: jest.fn().mockResolvedValue({ data: { id: 'leaveRequest-1', status: 'APPROVED' } }),
    cancelLeave: jest.fn().mockResolvedValue({ data: { id: 'leaveRequest-1', status: 'CANCELLED' } }),
  };
  wb._client = () => client;
  prismaMock.avSettings.findUnique.mockResolvedValue({ id: 1, vtWriteBackEnabled: true });
  prismaMock.vacationTrackerConfig.findMany.mockResolvedValue([{ workspaceId: 1, apiKey: 'vt_live_abc', apiKeyV2: null }]);
  prismaMock.avLeaveType.findMany.mockResolvedValue(AV_TYPES);
  prismaMock.avRequest.findUnique.mockResolvedValue(request());
  prismaMock.avRequest.findFirst.mockResolvedValue(null);
  prismaMock.avRequest.update.mockResolvedValue({});
});

const lastEvent = () => prismaMock.avRequest.update.mock.calls.at(-1)[0].data;

describe('type and body mapping', () => {
  test('a type is written as the Vacation Tracker type that imports back as the same type, exact name first', () => {
    expect(avTypeForVtName('Personal Time Off (PTO)', AV_TYPES).id).toBe(1);
    expect(vtTypeForAvType(AV_TYPES[0], VT_TYPES, AV_TYPES).id).toBe('lt-vac');
    expect(vtTypeForAvType(AV_TYPES[1], VT_TYPES, AV_TYPES).id).toBe('lt-sick');
    expect(vtTypeForAvType(AV_TYPES[2], VT_TYPES, AV_TYPES).id).toBe('lt-wfh');
    expect(vtTypeForAvType(AV_TYPES[3], VT_TYPES, AV_TYPES)).toBeNull();
  });

  test('inactive Vacation Tracker types are not used', () => {
    const types = VT_TYPES.map((t) => (t.id === 'lt-vac' ? { ...t, isActive: false } : t));
    expect(vtTypeForAvType(AV_TYPES[0], types, AV_TYPES).id).toBe('lt-pto');
  });

  test('full day, half day and hours', () => {
    const ids = { vtUserId: 'u', vtLeaveTypeId: 't' };
    expect(leaveBodyFor(request(), ids)).toEqual({ userId: 'u', leaveTypeId: 't', startDate: '2026-11-25', endDate: '2026-11-25', reason: 'Car service.' });
    expect(leaveBodyFor(request({ dayPart: 'pm', note: null }), ids)).toMatchObject({ isFullDayLeave: false, startHour: 13, startMinute: 0, endHour: 17, endMinute: 0 });
    expect(leaveBodyFor(request({ dayPart: 'hours', startMinute: 570, endMinute: 660, note: '<b>x</b>' }), ids)).toMatchObject({ isFullDayLeave: false, startHour: 9, startMinute: 30, endHour: 11, endMinute: 0, reason: 'bx/b' });
  });
});

describe('pushApproved', () => {
  test('adds an approved leave for the person and links the request', async () => {
    const res = await wb.pushApproved(140);
    expect(res).toMatchObject({ ok: true, vtLeaveId: 'leaveRequest-1' });
    expect(client.createLeave).toHaveBeenCalledWith(
      { userId: 'u-reza', leaveTypeId: 'lt-vac', startDate: '2026-11-25', endDate: '2026-11-25', reason: 'Car service.' },
      { idempotencyKey: 'tp-av-140' },
    );
    expect(lastEvent()).toMatchObject({ externalId: 'vt:leaveRequest-1', events: { create: { kind: 'vt_written', details: { vtLeaveId: 'leaveRequest-1', workspaceId: 1 } } } });
  });

  test.each([
    ['pending', { status: 'pending' }],
    ['imported from Vacation Tracker', { source: 'vacation_tracker' }],
    ['already written', { externalId: 'vt:x' }],
  ])('does nothing for a request that is %s', async (_n, over) => {
    prismaMock.avRequest.findUnique.mockResolvedValue(request(over));
    expect(await wb.pushApproved(140)).toEqual({ skipped: 'not_applicable' });
    expect(client.createLeave).not.toHaveBeenCalled();
  });

  test('does nothing when the switch is off or no v2 key is stored', async () => {
    prismaMock.avSettings.findUnique.mockResolvedValue({ id: 1, vtWriteBackEnabled: false });
    expect(await wb.pushApproved(140)).toEqual({ skipped: 'off' });
    prismaMock.avSettings.findUnique.mockResolvedValue({ id: 1, vtWriteBackEnabled: true });
    prismaMock.vacationTrackerConfig.findMany.mockResolvedValue([{ workspaceId: 1, apiKey: 'old-v1-key', apiKeyV2: null }]);
    expect(await wb.pushApproved(140)).toEqual({ skipped: 'no_key' });
    expect(client.createLeave).not.toHaveBeenCalled();
  });

  test('never writes outside production unless switched on by hand', async () => {
    delete process.env.AVAILABILITY_VT_WRITE_BACK;
    expect(await wb.pushApproved(140)).toEqual({ skipped: 'off' });
    expect(await wb.sweep()).toEqual({ skipped: 'off' });
    expect(client.createLeave).not.toHaveBeenCalled();
  });

  test('someone who is not in Vacation Tracker is recorded once and not retried', async () => {
    client.listUsers.mockResolvedValue([]);
    expect(await wb.pushApproved(140)).toEqual({ skipped: 'no_user' });
    expect(lastEvent().events.create.kind).toBe('vt_write_skipped');
  });

  test('a Vacation Tracker limit is overridden: the request was already approved here', async () => {
    client.createLeave
      .mockRejectedValueOnce(apiError(409, 'AUTOMATION_OVERRIDE_REQUIRED', { warnings: [{ code: 'MAXIMUM_USERS_AWAY' }] }))
      .mockResolvedValueOnce({ data: { id: 'leaveRequest-2' } });
    expect(await wb.pushApproved(140)).toMatchObject({ ok: true, vtLeaveId: 'leaveRequest-2' });
    expect(client.createLeave.mock.calls[1]).toEqual([expect.objectContaining({ overrideAutomations: ['MAXIMUM_USERS_AWAY'] }), { idempotencyKey: 'tp-av-140-o' }]);
  });

  test('entered in both places: the same leave already in Vacation Tracker is linked, not duplicated', async () => {
    client.createLeave.mockRejectedValue(apiError(422, 'LEAVE_OVERLAP'));
    client.listLeaves.mockResolvedValue([{ id: 'leaveRequest-9', userId: 'u-reza', leaveTypeId: 'lt-vac', startDate: '2026-11-25', endDate: '2026-11-25' }]);
    prismaMock.avRequest.findFirst.mockResolvedValue({ id: 143, source: 'vacation_tracker' }); // the imported copy of the same leave
    expect(await wb.pushApproved(140)).toMatchObject({ ok: true, alreadyThere: true, replacedRequest: 143 });
    // The imported copy is retired and its dashboard rows removed; this request keeps the leave.
    expect(prismaMock.avRequest.update.mock.calls[0][0]).toMatchObject({ where: { id: 143 }, data: { status: 'cancelled', externalId: null } });
    expect(prismaMock.technicianLeave.deleteMany).toHaveBeenCalledWith({ where: { OR: [{ vtLeaveId: 'leaveRequest-9' }, { vtLeaveId: { startsWith: 'av:143:' } }] } });
    const data = lastEvent();
    expect(data.externalId).toBe('vt:leaveRequest-9');
    expect(data.events.create).toMatchObject({ kind: 'vt_written', details: { vtLeaveId: 'leaveRequest-9', alreadyThere: true, replacedRequest: 143 } });
  });

  test('a leave already held by another Ticket Pulse request is left with it', async () => {
    client.createLeave.mockRejectedValue(apiError(422, 'LEAVE_OVERLAP'));
    client.listLeaves.mockResolvedValue([{ id: 'leaveRequest-9', userId: 'u-reza', leaveTypeId: 'lt-vac', startDate: '2026-11-25', endDate: '2026-11-25' }]);
    prismaMock.avRequest.findFirst.mockResolvedValue({ id: 77, source: 'app' });
    expect(await wb.pushApproved(140)).toMatchObject({ ok: true });
    expect(prismaMock.technicianLeave.deleteMany).not.toHaveBeenCalled();
    const data = lastEvent();
    expect(data.externalId).toBeUndefined();
    expect(data.events.create.details).toMatchObject({ heldByRequest: 77 });
  });

  test('an overlap with a different leave is a permanent failure', async () => {
    client.createLeave.mockRejectedValue(apiError(422, 'LEAVE_OVERLAP'));
    expect(await wb.pushApproved(140)).toMatchObject({ permanent: true });
    expect(lastEvent().events.create).toMatchObject({ kind: 'vt_write_failed', details: { code: 'LEAVE_OVERLAP', permanent: true } });
  });

  test('an outage is recorded as retryable and never throws', async () => {
    client.createLeave.mockRejectedValue(apiError(503, 'INTERNAL_ERROR'));
    expect(await wb.pushApproved(140)).toMatchObject({ permanent: false });
    client.createLeave.mockRejectedValue(new Error('socket hang up'));
    expect(await wb.pushApproved(140)).toMatchObject({ permanent: false });
    expect(lastEvent().events.create.details.permanent).toBe(false);
  });
});

describe('pushCancelled', () => {
  const cancelled = (over = {}) => request({ status: 'cancelled', externalId: 'vt:leaveRequest-1', events: [{ kind: 'vt_written', details: { workspaceId: 1 } }], ...over });

  test('cancels the leave it wrote', async () => {
    prismaMock.avRequest.findUnique.mockResolvedValue(cancelled());
    expect(await wb.pushCancelled(140, 'Plans changed')).toEqual({ ok: true });
    expect(client.cancelLeave).toHaveBeenCalledWith('leaveRequest-1', { reason: 'Plans changed', idempotencyKey: 'tp-av-140-cancel' });
    expect(lastEvent().events.create.kind).toBe('vt_cancelled');
  });

  test('already gone in Vacation Tracker counts as done', async () => {
    prismaMock.avRequest.findUnique.mockResolvedValue(cancelled());
    client.cancelLeave.mockRejectedValue(apiError(404, 'RESOURCE_NOT_FOUND'));
    expect(await wb.pushCancelled(140)).toEqual({ ok: true });
  });

  test('never touches a leave that came from Vacation Tracker or was never written', async () => {
    prismaMock.avRequest.findUnique.mockResolvedValue(cancelled({ source: 'vacation_tracker' }));
    expect(await wb.pushCancelled(140)).toEqual({ skipped: 'not_applicable' });
    prismaMock.avRequest.findUnique.mockResolvedValue(cancelled({ externalId: null }));
    expect(await wb.pushCancelled(140)).toEqual({ skipped: 'not_applicable' });
    expect(client.cancelLeave).not.toHaveBeenCalled();
  });
});

describe('sweep', () => {
  test('retries what is owed and leaves settled requests alone', async () => {
    const owed = [
      request({ id: 1 }),
      request({ id: 2, events: [{ kind: 'vt_write_failed', details: { permanent: false } }] }),
      request({ id: 3, events: [{ kind: 'vt_write_failed', details: { permanent: true } }] }),
      request({ id: 4, events: [{ kind: 'vt_write_skipped', details: {} }] }),
      request({ id: 5, events: Array.from({ length: 5 }, () => ({ kind: 'vt_write_failed', details: { permanent: false } })) }),
    ];
    prismaMock.avRequest.findMany.mockResolvedValueOnce(owed).mockResolvedValueOnce([]);
    const pushed = [];
    wb.pushApproved = jest.fn(async (id) => { pushed.push(id); return { ok: true }; });
    expect(await wb.sweep({ today: day('2026-10-13') })).toEqual({ written: 2, cancelled: 0, failed: 0 });
    expect(pushed).toEqual([1, 2]);
    expect(prismaMock.avRequest.findMany.mock.calls[0][0].where).toMatchObject({ status: 'approved', source: 'app', externalId: null, endDate: { gte: day('2026-10-13') } });
  });

  test('a request left beside an imported copy of the same leave takes it over', async () => {
    const left = request({ id: 149, events: [{ kind: 'vt_written', details: { vtLeaveId: 'leaveRequest-7', workspaceId: 1, heldByRequest: 151 } }] });
    prismaMock.avRequest.findMany.mockResolvedValueOnce([left]).mockResolvedValueOnce([]);
    prismaMock.avRequest.findFirst.mockResolvedValue({ id: 151, source: 'vacation_tracker' });
    wb.pushApproved = jest.fn();
    await wb.sweep({ today: day('2026-10-13') });
    expect(wb.pushApproved).not.toHaveBeenCalled();
    expect(prismaMock.avRequest.update.mock.calls[0][0]).toMatchObject({ where: { id: 151 }, data: { status: 'cancelled', externalId: null } });
    expect(lastEvent()).toMatchObject({ externalId: 'vt:leaveRequest-7' });
  });

  test('does nothing with the switch off', async () => {
    prismaMock.avSettings.findUnique.mockResolvedValue({ id: 1, vtWriteBackEnabled: false });
    expect(await wb.sweep()).toEqual({ skipped: 'off' });
    expect(prismaMock.avRequest.findMany).not.toHaveBeenCalled();
  });
});
