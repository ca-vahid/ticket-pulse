import { jest } from '@jest/globals';

/**
 * Changing a request that is still waiting (Vahid, 9 Nov 2026: Gaby booked
 * Thu + Fri, then wanted only Fri, and had to cancel and book again).
 * The rules run again on the new dates; refused changes leave the request as
 * it was; approvers are told what changed; only waiting requests can change.
 */

const prismaMock = {
  avRequest: { findUnique: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn(), findMany: jest.fn() },
  avRequestEvent: { createMany: jest.fn(), count: jest.fn() },
  avLeaveType: { findUnique: jest.fn() },
  avPerson: { findMany: jest.fn() },
};
const vtMock = { pushApproved: jest.fn(), pushCancelled: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/availability/vtWriteBack.js', () => ({ default: vtMock, isVtExternalId: () => false }));
jest.unstable_mockModule('../src/services/availability/availabilityTeams.js', () => ({ default: { notify: jest.fn() } }));

const { default: svc } = await import('../src/services/availability/availabilityService.js');
const { toDay } = await import('../src/services/availability/availabilityRules.js');

const GABY = { email: 'gaby@bgc.ca', name: 'Gaby Tonnova' };
const VACATION = { id: 1, name: 'Vacation', unit: 'day', isActive: true };
const thuFri = () => ({
  id: 210, email: 'gaby@bgc.ca', leaveTypeId: 1, status: 'pending', source: 'app',
  startDate: toDay('2026-11-12'), endDate: toDay('2026-11-13'), dayPart: 'full', startMinute: null, endMinute: null,
  days: 2, hours: 16, note: null, decision: { approvers: ['vahid@bgc.ca'] },
});
const fridayOnly = { leaveTypeId: 1, startDate: '2026-11-13', endDate: '2026-11-13', dayPart: 'full' };
const shapedFriday = {
  leaveType: VACATION, startDate: toDay('2026-11-13'), endDate: toDay('2026-11-13'), dayPart: 'full',
  startMinute: null, endMinute: null, dates: [toDay('2026-11-13')], days: 1, hours: 8, note: null,
};

let spies = [];
const spy = (name, impl) => { const s = jest.spyOn(svc, name).mockImplementation(impl); spies.push(s); return s; };

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.avRequest.findUnique.mockResolvedValue(thuFri());
  prismaMock.avRequest.findFirst.mockResolvedValue(null);
  prismaMock.avRequest.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.avRequestEvent.createMany.mockResolvedValue({ count: 2 });
  prismaMock.avRequestEvent.count.mockResolvedValue(1);
  spy('ensurePerson', async (u) => ({ email: u.email, name: u.name || 'Someone', workdays: [1, 2, 3, 4, 5], dailyHours: 8 }));
  spy('_shape', async () => shapedFriday);
  spy('getSettings', async () => ({ outlookEventsEnabled: false, autoRepliesEnabled: false, yearStartMonth: 1 }));
  spy('approversFor', async () => ['vahid@bgc.ca']);
  spy('canManagePerson', async () => false);
  spy('getRequest', async (id) => ({ id, ok: true }));
  spy('_notifyApprovers', async () => {});
  spy('_teamsSubmitted', async () => {});
  spy('project', async () => {});
});

afterEach(() => { spies.forEach((s) => s.mockRestore()); spies = []; });

describe('changing a waiting request', () => {
  test('Thu + Fri becomes Fri only: same request, still waiting, approvers told what it was', async () => {
    const decideFor = spy('_decideFor', async () => ({ outcome: 'pending', reason: 'Vacation needs an approver', fired: [] }));
    await svc.updateRequest(210, GABY, fridayOnly);

    // The rules ran without counting this request against itself.
    expect(decideFor.mock.calls[0][2]).toEqual({ excludeRequestId: 210 });
    const update = prismaMock.avRequest.updateMany.mock.calls[0][0];
    expect(update.where).toEqual({ id: 210, status: 'pending' });
    expect(update.data).toMatchObject({ status: 'pending', days: 1, decidedBy: null });
    const events = prismaMock.avRequestEvent.createMany.mock.calls[0][0].data;
    expect(events[0]).toMatchObject({ requestId: 210, kind: 'edited', actor: 'gaby@bgc.ca' });
    expect(events[0].details.before).toMatchObject({ startDate: '2026-11-12', endDate: '2026-11-13', days: 2 });
    expect(events[0].details.after).toMatchObject({ startDate: '2026-11-13', endDate: '2026-11-13', days: 1 });
    expect(events[0].details.changed).toEqual(expect.arrayContaining(['startDate', 'days']));
    expect(events[1].kind).toBe('sent_for_approval');
    expect(svc._notifyApprovers.mock.calls[0][3]).toEqual(['vahid@bgc.ca']);
    expect(svc._notifyApprovers.mock.calls[0][4].was).toMatch(/Nov 12/);
    expect(svc.project).not.toHaveBeenCalled();
    // Each change is its own Teams notice.
    expect(svc._teamsSubmitted.mock.calls[0][5]).toEqual({ changedTag: 'changed1' });
  });

  test('a change the rules now allow is approved on the spot and written to the calendars', async () => {
    spy('_decideFor', async () => ({ outcome: 'approved', reason: null, fired: [] }));
    prismaMock.avRequest.findUnique.mockResolvedValueOnce(thuFri()).mockResolvedValueOnce({ ...thuFri(), status: 'approved' });
    await svc.updateRequest(210, GABY, fridayOnly);
    expect(prismaMock.avRequest.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'approved', decidedBy: 'rules' });
    expect(prismaMock.avRequestEvent.createMany.mock.calls[0][0].data[1].kind).toBe('auto_approved');
    expect(svc.project).toHaveBeenCalled();
    expect(vtMock.pushApproved).toHaveBeenCalledWith(210);
    expect(svc._notifyApprovers).not.toHaveBeenCalled();
  });

  test('a change the rules refuse leaves the request exactly as it was', async () => {
    spy('_decideFor', async () => ({ outcome: 'refused', reason: 'WFH can only be booked this week and next', fired: [] }));
    await expect(svc.updateRequest(210, GABY, fridayOnly)).rejects.toThrow('WFH can only be booked this week and next');
    expect(prismaMock.avRequest.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.avRequestEvent.createMany).not.toHaveBeenCalled();
  });

  test('no change → nothing written, nobody told', async () => {
    spy('_shape', async () => ({ ...shapedFriday, startDate: toDay('2026-11-12'), endDate: toDay('2026-11-13'), days: 2, hours: 16 }));
    spy('_decideFor', async () => ({ outcome: 'pending', reason: null, fired: [] }));
    await svc.updateRequest(210, GABY, { ...fridayOnly, startDate: '2026-11-12' });
    expect(prismaMock.avRequest.updateMany).not.toHaveBeenCalled();
    expect(svc._notifyApprovers).not.toHaveBeenCalled();
  });

  test('an approver who decided a moment ago wins', async () => {
    spy('_decideFor', async () => ({ outcome: 'pending', reason: null, fired: [] }));
    prismaMock.avRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.updateRequest(210, GABY, fridayOnly)).rejects.toThrow('just decided');
    expect(prismaMock.avRequestEvent.createMany).not.toHaveBeenCalled();
  });

  test('another of my requests on those dates blocks the change', async () => {
    spy('_decideFor', async () => ({ outcome: 'pending', reason: null, fired: [] }));
    prismaMock.avRequest.findFirst.mockResolvedValue({ id: 99 });
    await expect(svc.updateRequest(210, GABY, fridayOnly)).rejects.toThrow('another request of this type');
    expect(prismaMock.avRequest.findFirst.mock.calls[0][0].where.id).toEqual({ not: 210 });
  });
});

describe('who can change what', () => {
  test('approved, denied and cancelled requests cannot be changed', async () => {
    prismaMock.avRequest.findUnique.mockResolvedValue({ ...thuFri(), status: 'approved' });
    await expect(svc.updateRequest(210, GABY, fridayOnly)).rejects.toThrow('already approved. Cancel it and book again');
    prismaMock.avRequest.findUnique.mockResolvedValue({ ...thuFri(), status: 'denied' });
    await expect(svc.updateRequest(210, GABY, fridayOnly)).rejects.toThrow('already denied');
  });

  test('someone else\'s request: no, unless an admin who manages them', async () => {
    await expect(svc.updateRequest(210, { email: 'reza@bgc.ca' }, fridayOnly)).rejects.toThrow('You can only change your own requests');
    svc.canManagePerson.mockResolvedValue(true);
    spy('_decideFor', async () => ({ outcome: 'pending', reason: null, fired: [] }));
    await svc.updateRequest(210, { email: 'boss@bgc.ca', name: 'Boss' }, fridayOnly);
    expect(svc.ensurePerson).toHaveBeenLastCalledWith({ email: 'gaby@bgc.ca' });
    expect(prismaMock.avRequest.updateMany).toHaveBeenCalled();
  });

  test('leave synced from Vacation Tracker is changed there', async () => {
    prismaMock.avRequest.findUnique.mockResolvedValue({ ...thuFri(), source: 'vacation_tracker' });
    await expect(svc.updateRequest(210, GABY, fridayOnly)).rejects.toThrow('Vacation Tracker');
  });
});

describe('the dry run while changing', () => {
  test('preview with requestId leaves that request out of the counts', async () => {
    const decideFor = spy('_decideFor', async () => ({ outcome: 'pending', reason: null, fired: [], remaining: 9 }));
    const out = await svc.preview(GABY, { ...fridayOnly, requestId: 210 });
    expect(decideFor.mock.calls[0][2]).toEqual({ excludeRequestId: 210 });
    expect(out).toMatchObject({ outcome: 'pending', days: 1, remaining: 9 });
  });

  test('a new booking still counts everything', async () => {
    const decideFor = spy('_decideFor', async () => ({ outcome: 'approved', reason: null, fired: [] }));
    await svc.preview(GABY, fridayOnly);
    expect(decideFor.mock.calls[0][2]).toEqual({ excludeRequestId: null });
    expect(prismaMock.avRequest.findUnique).not.toHaveBeenCalled();
  });
});

describe('my requests say who they wait for', () => {
  test('a waiting request carries the approvers by name and can be changed', async () => {
    prismaMock.avRequest.findMany.mockResolvedValue([thuFri(), { ...thuFri(), id: 211, status: 'approved', decision: null }]);
    prismaMock.avPerson.findMany.mockResolvedValue([{ email: 'vahid@bgc.ca', name: 'Vahid Haeri' }]);
    const rows = await svc.listMine(GABY, { year: 2026 });
    expect(rows[0]).toMatchObject({ id: 210, editable: true, waitingOn: [{ email: 'vahid@bgc.ca', name: 'Vahid Haeri' }] });
    expect(rows[1].waitingOn).toBeUndefined();
  });
});

describe('the nav badge count', () => {
  test('counts only the requests that are mine to decide', async () => {
    spy('listPendingFor', async () => [{ id: 1, mine: true }, { id: 2, mine: false }, { id: 3, mine: true }]);
    expect(await svc.pendingCountFor({ email: 'vahid@bgc.ca' })).toBe(2);
  });
});
