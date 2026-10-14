import { jest } from '@jest/globals';

// Owner away when the requester replies (13 Oct 2026). Karen Wong replied to
// resolved #245828; it reopened under its old owner. Had he been on vacation
// nobody else would have known. One test per rule in ownerAwayRerouteService.

const prismaMock = {
  ticket: { findFirst: jest.fn() },
  technicianLeave: { findMany: jest.fn() },
  ticketPark: { findFirst: jest.fn() },
  hrLifecycleFamilyMember: { findFirst: jest.fn() },
  hrLifecycleFamily: { findFirst: jest.fn() },
  ticketActivity: { findMany: jest.fn() },
  ticketHandBack: { findFirst: jest.fn(), update: jest.fn() },
  workspace: { findUnique: jest.fn() },
};
const rulesMock = { getRequesterReplyRules: jest.fn() };
const statusServiceMock = { resolveBaseStatus: jest.fn() };
const ticketServiceMock = { assignTicket: jest.fn(), updateFsTicket: jest.fn(), addPrivateNote: jest.fn() };
const activityRepoMock = { create: jest.fn() };
const reboundMock = { queueReboundRun: jest.fn() };
const calendarMock = { loadCalendar: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/requesterReplyRulesService.js', () => ({ ...rulesMock, default: rulesMock }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({ default: statusServiceMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: activityRepoMock }));
jest.unstable_mockModule('../src/services/reboundRunService.js', () => ({ ...reboundMock, default: reboundMock }));
jest.unstable_mockModule('../src/services/businessCalendarService.js', () => ({ default: calendarMock }));

const { default: service, currentAbsence, MIN_WORKING_DAYS_AWAY, OWNER_AWAY_ACTIVITY, OWNER_AWAY_ACTOR, friendlyDay } = await import('../src/services/ownerAwayRerouteService.js');

// Tuesday 13 Oct 2026, 10:00 in Vancouver.
const NOW = new Date('2026-10-13T17:00:00Z');
const SOHEIL = { id: 7, name: 'Soheil Example' };
const TP_TICKET = {
  id: 501, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1900, freshserviceTicketId: BigInt(246900), status: 'Open',
  isNoise: false, triageMode: null, assignedTechId: SOHEIL.id, assignedTech: SOHEIL,
};
const FS_TICKET = { ...TP_TICKET, id: 502, origin: 'freshservice', nativeNumber: null, freshserviceTicketId: BigInt(245828) };

const leave = (...days) => days.map((d) => ({ leaveDate: new Date(`${d}T00:00:00Z`), isFullDay: true }));
const weekdays = (dateStr) => { const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay(); return dow >= 1 && dow <= 5; };

beforeEach(() => {
  jest.clearAllMocks();
  rulesMock.getRequesterReplyRules.mockResolvedValue({ rerouteWhenOwnerAway: true, suggestNewRequest: true });
  statusServiceMock.resolveBaseStatus.mockResolvedValue('Open');
  prismaMock.ticket.findFirst.mockResolvedValue({ ...TP_TICKET });
  prismaMock.technicianLeave.findMany.mockResolvedValue(leave('2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'));
  prismaMock.ticketPark.findFirst.mockResolvedValue(null);
  prismaMock.hrLifecycleFamilyMember.findFirst.mockResolvedValue(null);
  prismaMock.hrLifecycleFamily.findFirst.mockResolvedValue(null);
  prismaMock.ticketActivity.findMany.mockResolvedValue([]);
  prismaMock.ticketHandBack.findFirst.mockResolvedValue(null);
  prismaMock.workspace.findUnique.mockResolvedValue({ defaultTimezone: 'America/Vancouver' });
  // Mon–Fri, Thanksgiving (Mon 12 Oct 2026) is a holiday.
  calendarMock.loadCalendar.mockResolvedValue({
    timezone: 'America/Vancouver',
    byDay: new Map([1, 2, 3, 4, 5].map((d) => [d, {}])),
    isHolidayDate: (d) => d === '2026-10-12',
  });
  ticketServiceMock.assignTicket.mockResolvedValue({ changed: true });
  ticketServiceMock.updateFsTicket.mockResolvedValue({ synced: ['assignedTechId'] });
  ticketServiceMock.addPrivateNote.mockResolvedValue({ id: 1 });
  activityRepoMock.create.mockResolvedValue({ id: 1 });
  reboundMock.queueReboundRun.mockResolvedValue({ outcome: 'queued' });
});

describe('currentAbsence (pure)', () => {
  const abs = (days, today) => currentAbsence({ offDates: new Set(days), today, isWorkingDay: weekdays });

  test('away today and tomorrow: two working days, back the day after', () => {
    expect(abs(['2026-10-13', '2026-10-14'], '2026-10-13')).toEqual({ firstDay: '2026-10-13', lastDay: '2026-10-14', backOn: '2026-10-15', workingDaysAway: 2 });
  });

  test('away today only: one working day', () => {
    expect(abs(['2026-10-13'], '2026-10-13')).toMatchObject({ workingDaysAway: 1, backOn: '2026-10-14' });
  });

  test('a Friday off is still one day: the weekend does not make it a long absence', () => {
    expect(abs(['2026-10-16'], '2026-10-16')).toMatchObject({ workingDaysAway: 1, backOn: '2026-10-19' });
  });

  test('Friday and Monday off spans the weekend: two working days', () => {
    expect(abs(['2026-10-16', '2026-10-19'], '2026-10-16')).toMatchObject({ workingDaysAway: 2, lastDay: '2026-10-19', backOn: '2026-10-20' });
  });

  test('not away today, even with a vacation next week', () => {
    expect(abs(['2026-10-19', '2026-10-20'], '2026-10-13')).toBeNull();
  });

  test('a reply on Saturday looks at Monday', () => {
    expect(abs(['2026-10-19', '2026-10-20'], '2026-10-17')).toMatchObject({ firstDay: '2026-10-19', workingDaysAway: 2 });
    expect(abs(['2026-10-20'], '2026-10-17')).toBeNull();
  });

  test('the threshold is a named constant: more than one working day', () => {
    expect(MIN_WORKING_DAYS_AWAY).toBe(2);
    expect(friendlyDay('2026-10-19')).toBe('Mon 19 Oct');
  });
});

describe('afterRequesterReply', () => {
  test('TP-born: owner away for the week → owner cleared, note, history entry, sent for assignment', async () => {
    const out = await service.afterRequesterReply(501, 1, { now: NOW, replyStamp: 'reply:9001' });

    expect(out).toMatchObject({ rerouted: true, reason: 'owner_away' });
    expect(ticketServiceMock.assignTicket).toHaveBeenCalledWith(501, 1, null, OWNER_AWAY_ACTOR);
    expect(ticketServiceMock.updateFsTicket).not.toHaveBeenCalled();
    const note = 'Soheil Example is away until Mon 19 Oct; sent back for assignment after the requester replied.';
    expect(ticketServiceMock.addPrivateNote).toHaveBeenCalledWith(501, 1, { bodyText: note }, OWNER_AWAY_ACTOR, [], { systemNote: true });
    expect(activityRepoMock.create).toHaveBeenCalledWith(expect.objectContaining({
      ticketId: 501,
      activityType: OWNER_AWAY_ACTIVITY,
      details: expect.objectContaining({ note, technicianId: 7, firstDay: '2026-10-13', lastDay: '2026-10-16', backOn: '2026-10-19', workingDaysAway: 4, replyStamp: 'reply:9001' }),
    }));
    expect(reboundMock.queueReboundRun).toHaveBeenCalledWith(expect.objectContaining({
      ticketId: 501,
      workspaceId: 1,
      reboundFrom: expect.objectContaining({ previousTechId: 7, previousTechName: 'Soheil Example', source: 'owner_away', reason: { code: 'other', label: 'Owner away', note } }),
    }));
    // The same rows assignment reads: approved, category OFF, from today on.
    const where = prismaMock.technicianLeave.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ technicianId: 7, status: 'APPROVED', category: 'OFF' });
    expect(where.leaveDate.gte.toISOString()).toBe('2026-10-13T00:00:00.000Z');
  });

  test('FreshService-born: the owner is cleared through the FreshService write path', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...FS_TICKET });
    const out = await service.afterRequesterReply(502, 1, { now: NOW });

    expect(out.rerouted).toBe(true);
    expect(ticketServiceMock.assignTicket).not.toHaveBeenCalled();
    expect(ticketServiceMock.updateFsTicket).toHaveBeenCalledWith(502, 1, {
      assignedTechId: null,
      handBack: { code: 'other', note: 'Soheil Example is away until Mon 19 Oct; sent back for assignment after the requester replied.' },
    }, OWNER_AWAY_ACTOR);
    expect(reboundMock.queueReboundRun).toHaveBeenCalledTimes(1);
  });

  test('a reply that reopened the ticket and one that landed on an open ticket are treated alike; a ticket still closed is left', async () => {
    statusServiceMock.resolveBaseStatus.mockResolvedValue('Pending');
    expect((await service.afterRequesterReply(501, 1, { now: NOW })).rerouted).toBe(true);
    jest.clearAllMocks();
    rulesMock.getRequesterReplyRules.mockResolvedValue({ rerouteWhenOwnerAway: true });
    prismaMock.ticket.findFirst.mockResolvedValue({ ...TP_TICKET, status: 'Resolved' });
    statusServiceMock.resolveBaseStatus.mockResolvedValue('Resolved');
    expect(await service.afterRequesterReply(501, 1, { now: NOW })).toMatchObject({ rerouted: false, reason: 'not_open' });
    expect(ticketServiceMock.assignTicket).not.toHaveBeenCalled();
  });

  test('switch off → nothing, and nothing is read', async () => {
    rulesMock.getRequesterReplyRules.mockResolvedValue({ rerouteWhenOwnerAway: false, suggestNewRequest: true });
    expect(await service.afterRequesterReply(501, 1, { now: NOW })).toEqual({ rerouted: false, reason: 'switch_off' });
    expect(prismaMock.ticket.findFirst).not.toHaveBeenCalled();
    expect(ticketServiceMock.assignTicket).not.toHaveBeenCalled();
  });

  test('nobody owns it → nothing', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...TP_TICKET, assignedTechId: null, assignedTech: null });
    expect(await service.afterRequesterReply(501, 1, { now: NOW })).toMatchObject({ rerouted: false, reason: 'no_owner' });
  });

  test('owner is here today → nothing', async () => {
    prismaMock.technicianLeave.findMany.mockResolvedValue(leave('2026-10-19', '2026-10-20'));
    expect(await service.afterRequesterReply(501, 1, { now: NOW })).toMatchObject({ rerouted: false, reason: 'owner_not_away' });
    expect(ticketServiceMock.assignTicket).not.toHaveBeenCalled();
  });

  test('back on the next working day → left alone (a one-day absence does not shuffle tickets)', async () => {
    prismaMock.technicianLeave.findMany.mockResolvedValue(leave('2026-10-13'));
    expect(await service.afterRequesterReply(501, 1, { now: NOW })).toMatchObject({ rerouted: false, reason: 'back_next_working_day' });
    expect(ticketServiceMock.assignTicket).not.toHaveBeenCalled();
  });

  test('a holiday is not a working day: off Friday, Monday is Thanksgiving, back Tuesday = one day', async () => {
    prismaMock.technicianLeave.findMany.mockResolvedValue(leave('2026-10-09'));
    const friday = new Date('2026-10-09T17:00:00Z');
    expect(await service.afterRequesterReply(501, 1, { now: friday })).toMatchObject({ rerouted: false, reason: 'back_next_working_day', absence: expect.objectContaining({ backOn: '2026-10-13' }) });
  });

  test('half days do not count; working from home and site visits are not read at all', async () => {
    prismaMock.technicianLeave.findMany.mockResolvedValue([
      { leaveDate: new Date('2026-10-13T00:00:00Z'), isFullDay: false },
      { leaveDate: new Date('2026-10-14T00:00:00Z'), isFullDay: false },
    ]);
    expect(await service.afterRequesterReply(501, 1, { now: NOW })).toMatchObject({ rerouted: false, reason: 'owner_not_away' });
    // Category OFF only: a WFH or OTHER row never reaches the service.
    expect(prismaMock.technicianLeave.findMany.mock.calls[0][0].where.category).toBe('OFF');
  });

  test('parked by the onboarding engine → left alone', async () => {
    prismaMock.ticketPark.findFirst.mockResolvedValue({ id: 3 });
    expect(await service.afterRequesterReply(501, 1, { now: NOW })).toMatchObject({ rerouted: false, reason: 'parked_by_onboarding' });
    expect(prismaMock.ticketPark.findFirst.mock.calls[0][0].where).toEqual({ ticketId: 501, endedAt: null, source: 'suggested_hr' });
    expect(ticketServiceMock.assignTicket).not.toHaveBeenCalled();
  });

  test('a child or the parent of an onboarding family → left alone', async () => {
    prismaMock.hrLifecycleFamilyMember.findFirst.mockResolvedValue({ id: 9 });
    expect(await service.afterRequesterReply(501, 1, { now: NOW })).toMatchObject({ rerouted: false, reason: 'onboarding_family' });
    prismaMock.hrLifecycleFamilyMember.findFirst.mockResolvedValue(null);
    prismaMock.hrLifecycleFamily.findFirst.mockResolvedValue({ id: 4 });
    expect(await service.afterRequesterReply(501, 1, { now: NOW })).toMatchObject({ rerouted: false, reason: 'onboarding_family' });
    expect(ticketServiceMock.assignTicket).not.toHaveBeenCalled();
  });

  test('trusted intake → left alone', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...TP_TICKET, triageMode: 'trusted' });
    expect(await service.afterRequesterReply(501, 1, { now: NOW })).toMatchObject({ rerouted: false, reason: 'trusted_intake' });
    expect(ticketServiceMock.assignTicket).not.toHaveBeenCalled();
  });

  test('no ping-pong: already sent back for this absence → stays with whoever has it', async () => {
    prismaMock.ticketActivity.findMany.mockResolvedValue([
      { details: { technicianId: 7, firstDay: '2026-10-13', lastDay: '2026-10-16', backOn: '2026-10-19' } },
    ]);
    expect(await service.afterRequesterReply(501, 1, { now: NOW })).toMatchObject({ rerouted: false, reason: 'already_rerouted_this_absence' });
    expect(ticketServiceMock.assignTicket).not.toHaveBeenCalled();
  });

  test('an earlier absence of the same person, or another person\'s, does not block this one', async () => {
    prismaMock.ticketActivity.findMany.mockResolvedValue([
      { details: { technicianId: 7, firstDay: '2026-08-03', lastDay: '2026-08-14', backOn: '2026-08-17' } },
      { details: { technicianId: 99, firstDay: '2026-10-13', lastDay: '2026-10-16', backOn: '2026-10-19' } },
    ]);
    expect((await service.afterRequesterReply(501, 1, { now: NOW })).rerouted).toBe(true);
  });

  test('two replies a second apart move the ticket once', async () => {
    let release;
    ticketServiceMock.assignTicket.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ changed: true }); }));
    const first = service.afterRequesterReply(501, 1, { now: NOW });
    await new Promise((r) => setTimeout(r, 20));
    const second = await service.afterRequesterReply(501, 1, { now: NOW });
    expect(second).toEqual({ rerouted: false, reason: 'in_progress' });
    release();
    expect((await first).rerouted).toBe(true);
    expect(ticketServiceMock.assignTicket).toHaveBeenCalledTimes(1);
  });

  test('a failed write to FreshService leaves no marker, so the next reply tries again', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...FS_TICKET });
    ticketServiceMock.updateFsTicket.mockRejectedValueOnce(new Error('FS_QUEUE_TIMEOUT'));
    expect(await service.afterRequesterReply(502, 1, { now: NOW })).toMatchObject({ rerouted: false, reason: 'error' });
    expect(activityRepoMock.create).not.toHaveBeenCalled();
    expect(reboundMock.queueReboundRun).not.toHaveBeenCalled();
    expect((await service.afterRequesterReply(502, 1, { now: NOW })).rerouted).toBe(true);
  });

  test('no business hours set: Monday to Friday is assumed', async () => {
    calendarMock.loadCalendar.mockResolvedValue(null);
    expect((await service.afterRequesterReply(501, 1, { now: NOW })).rerouted).toBe(true);
  });
});
