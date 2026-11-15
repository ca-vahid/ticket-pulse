import { jest } from '@jest/globals';

/**
 * MEGA 11-14 Part I: one Teams card a day per approver, at 9:00 in their own
 * time zone on working days, listing every time-away request still waiting
 * for them, urgent ones first. Once a day (refKey av:approver:<email>:<day>);
 * the person's own switch, quiet hours, Teams off and being away are kept;
 * a request is first listed the working morning after it arrived; when Teams
 * cannot reach the approver the same list goes by e-mail.
 */

const prismaMock = {
  technician: { findMany: jest.fn(), findFirst: jest.fn() },
  workspaceAccess: { findFirst: jest.fn(), findMany: jest.fn() },
  avApprovalGroupMember: { findMany: jest.fn() },
  avRequest: { findMany: jest.fn() },
  avPerson: { findMany: jest.fn() },
  avLeaveType: { findMany: jest.fn() },
  holiday: { findMany: jest.fn() },
  teamsDelivery: { findFirst: jest.fn(), create: jest.fn() },
};
const settingsMock = { get: jest.fn() };
const teamsMock = {
  workspaceSettings: jest.fn(), _prefsFor: jest.fn(), _inQuietHours: jest.fn(), _awayReason: jest.fn(), _record: jest.fn(), _send: jest.fn(),
};
const botMock = { isTeamsConfigured: jest.fn(() => true) };
const sendEmail = jest.fn();
const isWeekday = (d) => { const w = new Date(`${d}T12:00:00Z`).getUTCDay(); return w >= 1 && w <= 5; };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/teamsNotificationService.js', () => ({ default: teamsMock }));
jest.unstable_mockModule('../src/integrations/teamsBotClient.js', () => ({ default: botMock }));
jest.unstable_mockModule('../src/services/teamsCards.js', () => ({ textCard: (title, lines, actions, opts) => ({ title, lines, actions, opts }) }));
jest.unstable_mockModule('../src/utils/publicBaseUrl.js', () => ({ resolvePublicBaseUrl: () => 'https://tp.example' }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ sendEmail }));
jest.unstable_mockModule('../src/services/businessCalendarService.js', () => ({
  default: { loadCalendarSafe: jest.fn(async () => null), isWorkingDate: (d) => isWeekday(d) },
}));

const { default: avTeams, urgencyOf, orderForApprover, waitedFor } = await import('../src/services/availability/availabilityTeams.js');
const { toDay } = await import('../src/services/availability/availabilityRules.js');

const APPROVER = 'alex.rivera@example.com';
// Mon 16 Nov 2026, 9:15 AM in Vancouver.
const MON_915 = new Date('2026-11-16T17:15:00Z');
const req = (id, email, start, end, createdAt, over = {}) => ({
  id, email, leaveTypeId: 1, startDate: toDay(start), endDate: toDay(end), dayPart: 'full', startMinute: null, endMinute: null,
  days: 1, hours: 8, createdAt: new Date(createdAt), updatedAt: new Date(createdAt), ...over,
});
const LATER = req(201, 'sam.ortiz@example.com', '2026-11-23', '2026-11-27', '2026-11-12T18:00:00Z', { days: 5 });
const TOMORROW = req(202, 'jo.park@example.com', '2026-11-17', '2026-11-17', '2026-11-13T19:00:00Z');

const OLD = process.env.AVAILABILITY_TEAMS;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.AVAILABILITY_TEAMS = 'true';
  settingsMock.get.mockResolvedValue('');
  prismaMock.workspaceAccess.findMany.mockResolvedValue([]);
  prismaMock.avApprovalGroupMember.findMany.mockResolvedValue([{ group: { id: 1, approvers: [{ email: APPROVER }] } }]);
  prismaMock.avRequest.findMany.mockResolvedValue([LATER, TOMORROW]);
  prismaMock.avLeaveType.findMany.mockResolvedValue([{ id: 1, name: 'Vacation', unit: 'day' }]);
  prismaMock.avPerson.findMany.mockResolvedValue([
    { email: 'sam.ortiz@example.com', name: 'Sam Ortiz', workdays: null },
    { email: 'jo.park@example.com', name: 'Jo Park', workdays: null },
    { email: APPROVER, name: 'Alex Rivera', workdays: [1, 2, 3, 4, 5] },
  ]);
  prismaMock.holiday.findMany.mockResolvedValue([]);
  prismaMock.technician.findMany.mockResolvedValue([{ id: 21, name: 'Alex Rivera', email: APPROVER, workspaceId: 1, timezone: 'America/Vancouver' }]);
  prismaMock.teamsDelivery.findFirst.mockResolvedValue(null);
  teamsMock.workspaceSettings.mockResolvedValue({ teamsEnabled: true, defaults: {} });
  teamsMock._prefsFor.mockResolvedValue({ events: { av_approval_waiting: 'teams' } });
  teamsMock._inQuietHours.mockResolvedValue(false);
  teamsMock._awayReason.mockResolvedValue(null);
  teamsMock._send.mockResolvedValue('act-1');
  sendEmail.mockResolvedValue({});
});
afterAll(() => { process.env.AVAILABILITY_TEAMS = OLD; });

describe('the morning list', () => {
  test('one card for two waiting requests, the urgent one first, with the review button', async () => {
    const out = await avTeams.runApproverReminders(MON_915);
    expect(out).toMatchObject({ approvers: 1, sent: 1 });
    expect(teamsMock._send).toHaveBeenCalledTimes(1);
    const [to, card, opts] = teamsMock._send.mock.calls[0];
    expect(to).toBe(APPROVER);
    expect(card.title).toBe('2 time-away requests are waiting for you');
    expect(card.lines[0]).toMatch(/^\*\*Starts tomorrow\*\* · \*\*Jo Park\*\* · Vacation · Tue, Nov 17 · 1 day · waiting 2 days$/);
    expect(card.lines[1]).toMatch(/^\*\*Sam Ortiz\*\* · Vacation · Mon, Nov 23 – Fri, Nov 27 · 5 days · waiting 3 days$/);
    expect(card.actions).toEqual([{ type: 'Action.OpenUrl', title: 'Review the requests', url: 'https://tp.example/availability/approvals' }]);
    expect(card.opts).toMatchObject({ word: 'Vacation Pulse' });
    expect(opts).toMatchObject({ eventKey: 'av_approval_waiting', refKey: 'av:approver:alex.rivera@example.com:2026-11-16', workspaceId: 1, technicianId: 21 });
    expect(typeof opts.emailFallback).toBe('function');
  });

  test('none on a weekend or a holiday', async () => {
    expect((await avTeams.runApproverReminders(new Date('2026-11-15T17:15:00Z'))).skipped).toEqual({ not_a_working_day: 1 }); // Sunday
    prismaMock.holiday.findMany.mockResolvedValue([{ date: toDay('2026-11-16'), isRecurring: false, isEnabled: true, workspaceId: null }]);
    expect((await avTeams.runApproverReminders(MON_915)).skipped).toEqual({ not_a_working_day: 1 });
    // Another workspace's holiday does not count for this approver.
    prismaMock.holiday.findMany.mockResolvedValue([{ date: toDay('2026-11-16'), isRecurring: false, isEnabled: true, workspaceId: 4 }]);
    expect((await avTeams.runApproverReminders(MON_915)).sent).toBe(1);
  });

  test('not before 9:00 in the approver\'s own time zone', async () => {
    expect((await avTeams.runApproverReminders(new Date('2026-11-16T16:45:00Z'))).skipped).toEqual({ not_now: 1 }); // 8:45 in Vancouver
    // In Halifax it is already 12:45: the card goes.
    prismaMock.technician.findMany.mockResolvedValue([{ id: 21, name: 'Alex Rivera', email: APPROVER, workspaceId: 1, timezone: 'America/Halifax' }]);
    expect((await avTeams.runApproverReminders(new Date('2026-11-16T16:45:00Z'))).sent).toBe(1);
  });

  test('stops by itself: only requests still waiting are read, and none waiting means no card', async () => {
    prismaMock.avRequest.findMany.mockResolvedValue([]);
    expect(await avTeams.runApproverReminders(MON_915)).toMatchObject({ approvers: 0, sent: 0 });
    // The only one left after a decision is listed alone.
    prismaMock.avRequest.findMany.mockResolvedValue([LATER]);
    await avTeams.runApproverReminders(MON_915);
    expect(prismaMock.avRequest.findMany.mock.calls[0][0].where).toEqual({ status: 'pending' });
    expect(teamsMock._send.mock.calls[0][1].title).toBe('1 time-away request is waiting for you');
  });

  test('urgent order: started, then today, then soon, then the rest', () => {
    const today = '2026-11-16';
    const items = [
      { id: 1, startDate: toDay('2026-12-01'), createdAt: '2026-11-01' },
      { id: 2, startDate: toDay('2026-11-17'), createdAt: '2026-11-10' },
      { id: 3, startDate: toDay('2026-11-14'), createdAt: '2026-11-05' },
      { id: 4, startDate: toDay('2026-11-16'), createdAt: '2026-11-09' },
    ].map((r) => ({ ...r, ...urgencyOf(r.startDate, today) }));
    expect(orderForApprover(items).map((r) => r.id)).toEqual([3, 4, 2, 1]);
    expect(urgencyOf(toDay('2026-11-14'), today).label).toBe('Started 2 days ago');
    expect(urgencyOf(toDay('2026-11-15'), today).label).toBe('Started yesterday');
    expect(urgencyOf(toDay('2026-11-18'), today)).toMatchObject({ urgent: true, label: 'Starts in 2 days' });
    expect(urgencyOf(toDay('2026-11-19'), today)).toMatchObject({ urgent: false, label: null });
    expect(waitedFor('2026-11-16T12:00:00Z', MON_915)).toBe('waiting 5 hours');
  });

  test('approver away today: skipped (the list waits for their return); before their shift: tried again later', async () => {
    teamsMock._awayReason.mockResolvedValueOnce('on_leave');
    expect((await avTeams.runApproverReminders(MON_915)).skipped).toEqual({ away: 1 });
    teamsMock._awayReason.mockResolvedValueOnce('off_shift');
    expect((await avTeams.runApproverReminders(MON_915)).skipped).toEqual({ off_shift: 1 });
    expect(teamsMock._send).not.toHaveBeenCalled();
    expect(teamsMock._record).not.toHaveBeenCalled(); // no noise rows; the next tick tries again
  });

  test('the person\'s switch: off → nothing; Digest → held for their digest, once', async () => {
    teamsMock._prefsFor.mockResolvedValue({ events: { av_approval_waiting: 'off' } });
    expect((await avTeams.runApproverReminders(MON_915)).skipped).toEqual({ off: 1 });
    teamsMock._prefsFor.mockResolvedValue({ events: { av_approval_waiting: 'digest' } });
    expect((await avTeams.runApproverReminders(MON_915)).held).toBe(1);
    expect(teamsMock._record).toHaveBeenCalledWith(expect.objectContaining({ status: 'digest', reason: 'av:approver:alex.rivera@example.com:2026-11-16' }));
    expect(teamsMock._send).not.toHaveBeenCalled();
  });

  test('quiet hours and Teams off are kept', async () => {
    teamsMock._inQuietHours.mockResolvedValue(true);
    expect((await avTeams.runApproverReminders(MON_915)).skipped).toEqual({ quiet_hours: 1 });
    teamsMock._inQuietHours.mockResolvedValue(false);
    teamsMock.workspaceSettings.mockResolvedValue({ teamsEnabled: false });
    expect((await avTeams.runApproverReminders(MON_915)).skipped).toEqual({ teams_off: 1 });
    expect(teamsMock._send).not.toHaveBeenCalled();
  });

  test('never twice a day: the day\'s key is looked for first', async () => {
    prismaMock.teamsDelivery.findFirst.mockResolvedValue({ id: 9 });
    expect((await avTeams.runApproverReminders(MON_915)).skipped).toEqual({ already: 1 });
    expect(prismaMock.teamsDelivery.findFirst.mock.calls[0][0].where).toMatchObject({
      email: APPROVER, eventKey: 'av_approval_waiting', status: { in: ['sent', 'digest', 'emailed'] }, reason: 'av:approver:alex.rivera@example.com:2026-11-16',
    });
    expect(teamsMock._send).not.toHaveBeenCalled();
  });

  test('first-day skip: a request that arrived (or was changed) today waits for tomorrow morning', async () => {
    const NEW = req(203, 'jo.park@example.com', '2026-11-30', '2026-11-30', '2026-11-16T16:00:00Z'); // 8:00 today
    prismaMock.avRequest.findMany.mockResolvedValue([NEW]);
    expect((await avTeams.runApproverReminders(MON_915)).skipped).toEqual({ first_day: 1 });
    const CHANGED = { ...LATER, updatedAt: new Date('2026-11-16T16:30:00Z') };
    prismaMock.avRequest.findMany.mockResolvedValue([CHANGED, NEW, TOMORROW]);
    await avTeams.runApproverReminders(MON_915);
    expect(teamsMock._send.mock.calls[0][1].title).toBe('1 time-away request is waiting for you');
  });

  test('an approver is never reminded about their own request', async () => {
    prismaMock.avRequest.findMany.mockResolvedValue([req(204, APPROVER, '2026-11-20', '2026-11-20', '2026-11-10T18:00:00Z')]);
    expect(await avTeams.runApproverReminders(MON_915)).toMatchObject({ approvers: 0, sent: 0 });
  });

  test('Teams cannot reach the approver: the same list by e-mail', async () => {
    teamsMock._send.mockImplementation(async (_to, _card, opts) => {
      await opts.emailFallback();
      opts.outcome.via = 'email';
      return null;
    });
    const out = await avTeams.runApproverReminders(MON_915);
    expect(out).toMatchObject({ emailed: 1, sent: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail).toMatchObject({ to: [APPROVER], subject: 'Vacation Pulse: 2 time-away requests wait for you (1 soon)', context: 'availability' });
    expect(mail.html).toContain('Starts tomorrow: Jo Park');
    expect(mail.html).toContain('https://tp.example/availability/approvals');
    expect(mail.html).toContain('Ticket Pulse · Vacation Pulse');
    expect(mail.html).not.toContain('**');
  });

  test('off outside production unless the flag is set; the tick runs both reminders', async () => {
    delete process.env.AVAILABILITY_TEAMS;
    expect(await avTeams.runApproverReminders(MON_915)).toMatchObject({ approvers: 0, sent: 0 });
    process.env.AVAILABILITY_TEAMS = 'true';
    await avTeams.tick(MON_915);
    expect(teamsMock._send).toHaveBeenCalledTimes(1); // 9:15 is outside the day-before window, inside the approvers'
  });
});
