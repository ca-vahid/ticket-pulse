import { jest } from '@jest/globals';

/**
 * Parked tickets (plans/PARKED_BUILD_PLAN.md): a marker, not a status. The
 * ticket goes to Pending (FreshService sees 3), wakes on its date, and a
 * requester reply or any other status change ends the park.
 */
const tx = {
  ticketPark: { update: jest.fn(), create: jest.fn() },
  ticket: { update: jest.fn() },
};
const prismaMock = {
  ticket: { findFirst: jest.fn(), update: jest.fn(), findMany: jest.fn().mockResolvedValue([]), count: jest.fn() },
  ticketPark: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn(), update: jest.fn(), create: jest.fn() },
  workspace: { findMany: jest.fn().mockResolvedValue([]) },
  $transaction: jest.fn(async (fn) => fn(tx)),
};
const changeStatus = jest.fn().mockResolvedValue({ changed: true });
const updateFsTicket = jest.fn().mockResolvedValue({});
const activityCreate = jest.fn().mockResolvedValue({});
const emitTicketEvent = jest.fn().mockResolvedValue({});
const sendTransactionalEmail = jest.fn().mockResolvedValue({ sent: true });

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
const loggerWarn = jest.fn();
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: loggerWarn, error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: activityCreate } }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: { changeStatus, updateFsTicket, _broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ emitTicketEvent, default: { emitTicketEvent } }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => ({ sendTransactionalEmail }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: { get: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: {
    resolveBaseStatus: jest.fn(async (_ws, s) => ({ Open: 'Open', Pending: 'Pending', 'Pending Response': 'Pending', Resolved: 'Resolved', Closed: 'Closed' }[s] ?? null)),
    statusNamesForBase: jest.fn(async () => ['Open', 'Pending']),
  },
}));

const { default: parks, validatePark, parkActor } = await import('../src/services/ticketParkService.js');

const inDays = (d) => new Date(Date.now() + d * 86400e3);
const TP_TICKET = {
  id: 45000, workspaceId: 1, origin: 'ticketpulse', status: 'Open', subject: 'Transfer: Laura Beamish', dueBy: new Date('2026-10-01T00:00:00Z'),
  nativeNumber: 1700, freshserviceTicketId: 99, parkedUntil: null, parkKind: null, assignedTechId: 12,
  requester: { email: 'hr@bgcengineering.ca' }, assignedTech: { id: 12, name: 'Andrii', email: 'andrii@bgcengineering.ca' },
};

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticket.findFirst.mockResolvedValue({ ...TP_TICKET });
  prismaMock.ticketPark.findFirst.mockResolvedValue(null);
  tx.ticketPark.create.mockImplementation(async ({ data }) => ({ id: 7, ...data }));
  prismaMock.ticket.update.mockResolvedValue({});
});

describe('validatePark', () => {
  test('six months at most, a reason, a kind; waiting_on needs someone', () => {
    expect(validatePark({ kind: 'until_date', until: inDays(10), reason: 'Transfer effective Oct 5' }).kind).toBe('until_date');
    expect(() => validatePark({ kind: 'until_date', until: inDays(200), reason: 'x' })).toThrow(/six months/);
    expect(() => validatePark({ kind: 'until_date', until: inDays(-1), reason: 'x' })).toThrow(/future/);
    expect(() => validatePark({ kind: 'until_date', until: inDays(3), reason: '  ' })).toThrow(/why/);
    expect(() => validatePark({ kind: 'later', until: inDays(3), reason: 'x' })).toThrow(/kind/);
    expect(() => validatePark({ kind: 'waiting_on', until: inDays(3), reason: 'x' })).toThrow(/who/);
  });

  test('waiting on the requester is not a park — it is Pending Response', () => {
    let err;
    try {
      validatePark({ kind: 'waiting_on', until: inDays(3), reason: 'x', waitingOn: [{ email: 'Req@X.com', name: 'Req' }] }, { requesterEmail: 'req@x.com' });
    } catch (e) { err = e; }
    expect(err.code).toBe('park_requester_use_pending_response');
  });

  test('a bare date wakes at 08:00 Pacific', () => {
    expect(validatePark({ kind: 'until_date', until: '2099-10-05', reason: 'x' }, { now: new Date('2099-09-30T00:00:00Z') }).until.toISOString()).toBe('2099-10-05T15:00:00.000Z');
  });
});

describe('park / unpark', () => {
  test('parking sets Pending through the normal path (marked as the park\'s own), then records the park', async () => {
    const out = await parks.park(45000, 1, { kind: 'until_date', until: inDays(12), reason: 'Transfer effective Oct 5' }, { name: 'Andrii' });
    expect(changeStatus).toHaveBeenCalledWith(45000, 1, 'Pending', expect.objectContaining({ _parkChange: true, name: 'Andrii' }), {});
    expect(tx.ticketPark.create).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: 'until_date', reason: 'Transfer effective Oct 5', statusBefore: 'Open', parkedBy: 'Andrii' }) });
    expect(tx.ticket.update).toHaveBeenCalledWith({ where: { id: 45000 }, data: expect.objectContaining({ parkKind: 'until_date' }) });
    expect(out.extended).toBe(false);
    expect(activityCreate).toHaveBeenCalledWith(expect.objectContaining({ activityType: 'ticket_parked' }));
  });

  test('FreshService tickets are parked through the FS write-back (Pending = 3 there)', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...TP_TICKET, origin: 'freshservice' });
    await parks.park(45000, 1, { kind: 'eta', until: inDays(30), reason: 'DarkTrace ETA Oct 31' }, { name: 'Anton' });
    expect(updateFsTicket).toHaveBeenCalledWith(45000, 1, { status: 'Pending' }, expect.objectContaining({ _parkChange: true }));
    expect(changeStatus).not.toHaveBeenCalled();
  });

  test('parking again ends the active park as extended and keeps the first status-before', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...TP_TICKET, status: 'Pending', parkedUntil: inDays(3) });
    prismaMock.ticketPark.findFirst.mockResolvedValue({ id: 5, statusBefore: 'Open', until: inDays(3) });
    const out = await parks.park(45000, 1, { kind: 'until_date', until: inDays(20), reason: 'Moved to Oct 20' }, { name: 'Andrii' });
    expect(tx.ticketPark.update).toHaveBeenCalledWith({ where: { id: 5 }, data: expect.objectContaining({ endReason: 'extended' }) });
    expect(tx.ticketPark.create).toHaveBeenCalledWith({ data: expect.objectContaining({ statusBefore: 'Open' }) });
    expect(changeStatus).not.toHaveBeenCalled(); // already Pending
    expect(out.extended).toBe(true);
  });

  test('closed or deleted tickets cannot be parked', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...TP_TICKET, status: 'Closed' });
    await expect(parks.park(45000, 1, { kind: 'until_date', until: inDays(3), reason: 'x' }, {})).rejects.toThrow(/reopen it first/);
  });

  test('Unpark (the button) ends the park and reopens the ticket', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...TP_TICKET, status: 'Pending', parkedUntil: inDays(3) });
    prismaMock.ticketPark.findFirst.mockResolvedValue({ id: 5, kind: 'until_date', statusBefore: 'Open', until: inDays(3) });
    prismaMock.ticketPark.updateMany.mockResolvedValue({ count: 1 });
    const out = await parks.unpark(45000, 1, { reason: 'unparked', reopen: true }, { name: 'Andrii' });
    expect(out).toEqual({ unparked: true, reason: 'unparked' });
    expect(prismaMock.ticket.update).toHaveBeenCalledWith({ where: { id: 45000 }, data: { parkedUntil: null, parkKind: null } });
    expect(changeStatus).toHaveBeenCalledWith(45000, 1, 'Open', expect.objectContaining({ _parkChange: true }), {});
  });
});

describe('hooks', () => {
  test('the park\'s own status changes never end it; anyone else\'s do', async () => {
    prismaMock.ticketPark.findFirst.mockResolvedValue({ id: 5, kind: 'until_date', until: inDays(3) });
    await expect(parks.afterStatusChange(45000, 1, { newStatus: 'Pending', actor: parkActor({ name: 'x' }) })).resolves.toEqual({ unparked: false });
    prismaMock.ticket.findFirst.mockResolvedValue({ ...TP_TICKET, status: 'Open', parkedUntil: inDays(3) });
    prismaMock.ticketPark.updateMany.mockResolvedValue({ count: 1 });
    const out = await parks.afterStatusChange(45000, 1, { newStatus: 'Resolved', actor: { name: 'Gaby' } });
    expect(out).toEqual({ unparked: true, reason: 'closed' });
    expect(changeStatus).not.toHaveBeenCalled(); // the new status stands
  });

  test('a requester reply wakes the ticket early (back to Open)', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...TP_TICKET, status: 'Pending', parkedUntil: inDays(3) });
    prismaMock.ticketPark.findFirst.mockResolvedValue({ id: 5, kind: 'waiting_on', statusBefore: 'Open', until: inDays(3) });
    prismaMock.ticketPark.updateMany.mockResolvedValue({ count: 1 });
    const out = await parks.afterRequesterReply(45000, 1);
    expect(out.reason).toBe('requester_replied');
    expect(changeStatus).toHaveBeenCalledWith(45000, 1, 'Open', expect.anything(), {});
  });
});

describe('sweep', () => {
  test('a due park is claimed once, reopens the ticket, moves a TP ticket\'s due date out by the parked time, and tells the assignee', async () => {
    const parkedAt = new Date(Date.now() - 5 * 86400e3);
    prismaMock.ticketPark.findMany
      .mockResolvedValueOnce([{ id: 9, ticketId: 45000, workspaceId: 1, kind: 'until_date', until: new Date(), parkedAt, parkedBy: 'Andrii', reason: 'Transfer effective Oct 5', statusBefore: 'Open' }])
      .mockResolvedValueOnce([]);
    prismaMock.ticketPark.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.ticket.findFirst.mockResolvedValue({ ...TP_TICKET, status: 'Pending', parkedUntil: new Date() });
    const out = await parks.sweep();
    expect(out.woke).toBe(1);
    expect(changeStatus).toHaveBeenCalledWith(45000, 1, 'Open', expect.objectContaining({ _parkChange: true }), {});
    const dueCall = prismaMock.ticket.update.mock.calls.find(([arg]) => arg.data.dueBy);
    expect(dueCall[0].data.dueBy.getTime() - TP_TICKET.dueBy.getTime()).toBeGreaterThanOrEqual(5 * 86400e3 - 1000);
    expect(loggerWarn).not.toHaveBeenCalled();
    expect(sendTransactionalEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'andrii@bgcengineering.ca', label: 'park wake' }));
  });

  test('a park lost to another instance is not woken twice', async () => {
    prismaMock.ticketPark.findMany.mockResolvedValueOnce([{ id: 9, ticketId: 45000, workspaceId: 1 }]).mockResolvedValueOnce([]);
    prismaMock.ticketPark.updateMany.mockResolvedValue({ count: 0 });
    const out = await parks.sweep();
    expect(out.woke).toBe(0);
    expect(changeStatus).not.toHaveBeenCalled();
  });

  test('safety net: a parked ticket moved off Pending by anything (sync, workflow) loses its park', async () => {
    prismaMock.ticketPark.findMany.mockResolvedValue([]);
    prismaMock.ticket.findMany.mockResolvedValueOnce([{ id: 45000, workspaceId: 1, status: 'Open' }]);
    prismaMock.ticket.findFirst.mockResolvedValue({ ...TP_TICKET, status: 'Open', parkedUntil: inDays(3) });
    prismaMock.ticketPark.findFirst.mockResolvedValue({ id: 5, kind: 'until_date', until: inDays(3) });
    prismaMock.ticketPark.updateMany.mockResolvedValue({ count: 1 });
    const out = await parks.sweep();
    expect(out.ended).toBe(1);
    expect(changeStatus).not.toHaveBeenCalled();
  });
});
