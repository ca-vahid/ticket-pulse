import { jest } from '@jest/globals';

/**
 * QA 10-13, Availability items 6, 7, 8 and 10:
 *   7  "view as a role" in another workspace shows that workspace's people
 *   8  a workspace admin acts only on their own workspaces' people; the
 *      approvals list says which requests are the caller's to decide
 *   10 a request for more days than are left is never approved automatically
 *   6  Teams notices honour the person's choice and are sent once
 */

const prismaMock = {
  technician: { findMany: jest.fn(), findFirst: jest.fn() },
  workspaceAccess: { findFirst: jest.fn(), findMany: jest.fn() },
  avApprovalGroupMember: { findMany: jest.fn() },
  avRequest: { findMany: jest.fn(), findUnique: jest.fn() },
  avPerson: { findMany: jest.fn(), findUnique: jest.fn() },
  avBalanceAdjustment: { create: jest.fn() },
  teamsDelivery: { findFirst: jest.fn(), create: jest.fn() },
};
const settingsMock = { get: jest.fn() };
const teamsMock = { workspaceSettings: jest.fn(), _prefsFor: jest.fn(), _inQuietHours: jest.fn(), _record: jest.fn(), _send: jest.fn() };
const botMock = { isTeamsConfigured: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/teamsNotificationService.js', () => ({ default: teamsMock }));
jest.unstable_mockModule('../src/integrations/teamsBotClient.js', () => ({ default: botMock }));
jest.unstable_mockModule('../src/services/teamsCards.js', () => ({ textCard: (title, lines, actions) => ({ title, lines, actions }) }));
jest.unstable_mockModule('../src/utils/publicBaseUrl.js', () => ({ resolvePublicBaseUrl: () => 'https://tp.example' }));

const { default: svc } = await import('../src/services/availability/availabilityService.js');
const { default: avTeams } = await import('../src/services/availability/availabilityTeams.js');
const { decide, overBalance, toDay } = await import('../src/services/availability/availabilityRules.js');

const SUPER = { email: 'boss@bgc.ca', role: 'admin' };
const asReviewerInPA = { email: 'boss@bgc.ca', role: 'viewer', viewAs: { mode: 'role', role: 'reviewer', workspaceId: 5, by: 'boss@bgc.ca' } };
const asAdminInPA = { email: 'boss@bgc.ca', role: 'viewer', viewAs: { mode: 'role', role: 'admin', workspaceId: 5, by: 'boss@bgc.ca' } };
const WS_ADMIN = { email: 'padmin@bgc.ca', role: 'viewer' };

beforeEach(() => {
  jest.clearAllMocks();
  settingsMock.get.mockResolvedValue('boss@bgc.ca');
  prismaMock.workspaceAccess.findFirst.mockResolvedValue(null);
  prismaMock.workspaceAccess.findMany.mockResolvedValue([]);
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.technician.findMany.mockResolvedValue([]);
  prismaMock.avApprovalGroupMember.findMany.mockResolvedValue([]);
  prismaMock.avPerson.findMany.mockResolvedValue([]);
  prismaMock.teamsDelivery.findFirst.mockResolvedValue(null);
  prismaMock.teamsDelivery.create.mockResolvedValue({});
});

describe('#7 view as a role in another workspace', () => {
  test('the roster is the viewed workspace, never the viewer\'s own team', async () => {
    prismaMock.technician.findMany.mockImplementation(async ({ where }) => (where.workspaceId?.in ? [{ email: 'pa1@bgc.ca', name: 'Pa One' }] : [{ workspaceId: 1 }]));
    const roster = await svc.rosterFor(asReviewerInPA, 5);
    expect([...roster].sort()).toEqual(['boss@bgc.ca', 'pa1@bgc.ca']);
    expect(prismaMock.technician.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.technician.findMany.mock.calls[0][0].where.workspaceId).toEqual({ in: [5] });
  });

  test('a role view is not a super admin and is an admin only when that is the role', async () => {
    expect(await svc.isSuperAdmin(SUPER)).toBe(true);
    expect(await svc.isSuperAdmin(asReviewerInPA)).toBe(false);
    expect(await svc.isAdmin(asReviewerInPA)).toBe(false);
    expect(await svc.isAdmin(asAdminInPA)).toBe(true);
    expect(await svc._adminWorkspaceIds(asAdminInPA)).toEqual([5]);
  });
});

describe('#8 workspace admins act on their own people only', () => {
  beforeEach(() => {
    prismaMock.workspaceAccess.findMany.mockResolvedValue([{ workspaceId: 5 }]);
  });

  test('someone in a workspace they administer: yes; someone elsewhere: no', async () => {
    prismaMock.technician.findFirst.mockResolvedValueOnce({ id: 9 });
    expect(await svc.canManagePerson(WS_ADMIN, 'pa1@bgc.ca')).toBe(true);
    expect(prismaMock.technician.findFirst.mock.calls[0][0].where.workspaceId).toEqual({ in: [5] });
    expect(await svc.canManagePerson(WS_ADMIN, 'reza@bgc.ca')).toBe(false);
    expect(await svc.canManagePerson(SUPER, 'reza@bgc.ca')).toBe(true);
  });

  test('another workspace\'s request cannot be opened or cancelled, and a balance cannot be adjusted', async () => {
    prismaMock.avRequest.findUnique.mockResolvedValue({ id: 140, email: 'reza@bgc.ca', status: 'pending', source: 'app', startDate: toDay('2026-11-25'), endDate: toDay('2026-11-25') });
    prismaMock.avApprovalGroupMember.findMany.mockResolvedValue([{ group: { id: 1, approvers: [{ email: 'gaby@bgc.ca' }] } }]);
    await expect(svc.getRequest(140, WS_ADMIN)).rejects.toThrow('Request not found');
    await expect(svc.cancelRequest(140, WS_ADMIN)).rejects.toThrow('You can only cancel your own requests');
    prismaMock.workspaceAccess.findFirst.mockImplementation(async ({ where }) => (where.role === 'admin' ? { id: 1 } : null)); // an admin, of workspace 5
    await expect(svc.adjustBalance({ email: 'reza@bgc.ca', leaveTypeId: 1, year: 2026, days: 5, note: 'x' }, { ...WS_ADMIN })).rejects.toThrow(/workspaces you administer/);
    expect(prismaMock.avBalanceAdjustment.create).not.toHaveBeenCalled();
  });

  test('waiting and private entries are for the admins of the workspace on screen', async () => {
    expect(await svc._privilegedIn(WS_ADMIN, 5)).toBe(true);
    expect(await svc._privilegedIn(WS_ADMIN, 1)).toBe(false);
    expect(await svc._privilegedIn(SUPER, 1)).toBe(true);
  });

  test('the approvals list marks what is the caller\'s to decide and names who the rest is waiting on', async () => {
    prismaMock.avRequest.findMany.mockResolvedValue([
      { id: 140, email: 'reza@bgc.ca', status: 'pending', startDate: toDay('2026-11-25'), endDate: toDay('2026-11-25') },
      { id: 141, email: 'pa1@bgc.ca', status: 'pending', startDate: toDay('2026-11-26'), endDate: toDay('2026-11-26') },
    ]);
    prismaMock.avApprovalGroupMember.findMany.mockImplementation(async ({ where }) => (where.email === 'reza@bgc.ca'
      ? [{ group: { id: 1, approvers: [{ email: 'gaby@bgc.ca' }] } }]
      : [{ group: { id: 2, approvers: [{ email: 'boss@bgc.ca' }] } }]));
    prismaMock.avPerson.findMany.mockResolvedValue([{ email: 'reza@bgc.ca', name: 'Reza Zaim' }, { email: 'gaby@bgc.ca', name: 'Gaby Tonnova' }]);
    prismaMock.technician.findMany.mockResolvedValue([{ email: 'Reza@bgc.ca', workspace: { name: 'IT' } }]);
    const list = await svc.listPendingFor(SUPER);
    expect(list.map((r) => [r.id, r.mine])).toEqual([[140, false], [141, true]]);
    expect(list[0]).toMatchObject({ name: 'Reza Zaim', teams: ['IT'], waitingOn: [{ email: 'gaby@bgc.ca', name: 'Gaby Tonnova' }] });
    expect(list[1].waitingOn).toEqual([]);
    // Someone who is neither a named approver nor a super admin sees nothing.
    expect(await svc.listPendingFor(WS_ADMIN)).toEqual([]);
  });
});

describe('#10 more days than are left is never approved automatically', () => {
  const VAC = { id: 1, name: 'Vacation', requiresApproval: true, tracksBalance: true };
  const SICK = { id: 2, name: 'Sick', requiresApproval: false, tracksBalance: true };
  const WFH = { id: 3, name: 'Working from home', requiresApproval: false, tracksBalance: false };
  const person = { email: 'sxu@bgc.ca', officeId: 4 };
  const ctx = (over = {}) => ({ today: toDay('2026-10-13'), startDate: toDay('2026-10-13'), endDate: toDay('2026-11-28'), dates: [], days: 33, remaining: 10, ...over });

  test('a group that skips approval for every type still sends an 8-week vacation to an approver', () => {
    const v = decide({ rules: [], leaveType: VAC, person, groupAutoApprove: true, ctx: ctx() });
    expect(v).toMatchObject({ outcome: 'pending', guard: 'balance' });
    expect(v.reason).toBe('You have 10 vacation days left and this needs 33, so an approver has to confirm it.');
  });

  test('sick days past the allowance go to an approver; inside it they are still automatic', () => {
    expect(decide({ rules: [], leaveType: SICK, person, ctx: ctx({ days: 14, remaining: 5 }) }).outcome).toBe('pending');
    expect(decide({ rules: [], leaveType: SICK, person, ctx: ctx({ days: 14, remaining: 0 }) }).reason).toMatch(/^You have no sick days left/);
    expect(decide({ rules: [], leaveType: SICK, person, ctx: ctx({ days: 2, remaining: 5 }) }).outcome).toBe('approved');
    expect(decide({ rules: [], leaveType: VAC, person, groupAutoApprove: true, ctx: ctx({ days: 5, remaining: 10 }) }).outcome).toBe('approved');
  });

  test('an auto-approve rule does not get past it either, and untracked types are untouched', () => {
    const always = { id: 9, name: 'Always yes', scopeType: 'company', condition: { kind: 'always' }, outcome: 'auto_approve' };
    expect(decide({ rules: [always], leaveType: VAC, person, ctx: ctx() }).outcome).toBe('pending');
    expect(decide({ rules: [], leaveType: WFH, person, ctx: ctx({ remaining: null }) }).outcome).toBe('approved');
  });

  test('a balance rule the admin wrote for the type decides instead', () => {
    const lenient = { id: 7, name: 'Up to 40 days over', scopeType: 'company', leaveTypeIds: [1], condition: { kind: 'balance', allowNegativeDays: 40 }, outcome: 'needs_approval' };
    expect(overBalance({ rules: [lenient], leaveType: VAC, person, ctx: ctx() })).toBeNull();
    expect(decide({ rules: [lenient], leaveType: VAC, person, groupAutoApprove: true, ctx: ctx() }).outcome).toBe('approved');
    const strict = { ...lenient, condition: { kind: 'balance' }, outcome: 'refuse' };
    expect(decide({ rules: [strict], leaveType: VAC, person, groupAutoApprove: true, ctx: ctx() }).outcome).toBe('refused');
    // A balance rule for another type does not switch the guard off for this one.
    expect(overBalance({ rules: [{ ...lenient, leaveTypeIds: [2] }], leaveType: VAC, person, ctx: ctx() })).not.toBeNull();
  });
});

describe('#6 Teams notices', () => {
  const OLD = process.env.AVAILABILITY_TEAMS;
  beforeEach(() => {
    process.env.AVAILABILITY_TEAMS = 'true';
    botMock.isTeamsConfigured.mockReturnValue(true);
    prismaMock.technician.findMany.mockResolvedValue([{ id: 3, email: 'Reza@bgc.ca', workspaceId: 2 }, { id: 4, email: 'Reza@bgc.ca', workspaceId: 1 }]);
    teamsMock.workspaceSettings.mockImplementation(async (id) => ({ teamsEnabled: id === 1, defaults: {} }));
    teamsMock._prefsFor.mockResolvedValue({ events: { av_submitted: 'teams', av_decided: 'off', av_reminder: 'digest', av_approval_waiting: 'teams' } });
    teamsMock._inQuietHours.mockResolvedValue(false);
    teamsMock._send.mockResolvedValue('activity-1');
  });
  afterAll(() => { process.env.AVAILABILITY_TEAMS = OLD; });

  test('sent through the workspace that has Teams on, with a link and a once-only key', async () => {
    const res = await avTeams.notify('reza@bgc.ca', 'av_submitted', { title: 'Booked: Working from home', lines: ['Fri, Oct 16 · 1 day', null], refKey: 'av:138:submitted', path: '/availability/my-time' });
    expect(res).toEqual({ sent: true });
    const [to, card, opts] = teamsMock._send.mock.calls[0];
    expect(to).toBe('Reza@bgc.ca');
    expect(card).toMatchObject({ title: 'Booked: Working from home', lines: ['Fri, Oct 16 · 1 day'], actions: [{ url: 'https://tp.example/availability/my-time' }] });
    expect(opts).toMatchObject({ workspaceId: 1, technicianId: 4, eventKey: 'av_submitted', refKey: 'av:138:submitted' });
  });

  test('turned off by the person: nothing; Digest: held for the morning; already sent: not again', async () => {
    expect(await avTeams.notify('reza@bgc.ca', 'av_decided', { title: 'Approved: Vacation' })).toEqual({ skipped: 'off' });
    expect(await avTeams.notify('reza@bgc.ca', 'av_reminder', { title: 'Tomorrow: Vacation', lines: ['Wed, Oct 14'], refKey: 'av:1:reminder' })).toEqual({ held: true });
    expect(teamsMock._record).toHaveBeenCalledWith(expect.objectContaining({ status: 'digest', reason: 'av:1:reminder', summary: 'Tomorrow: Vacation — Wed, Oct 14' }));
    prismaMock.teamsDelivery.findFirst.mockResolvedValue({ id: 1 });
    expect(await avTeams.notify('reza@bgc.ca', 'av_submitted', { title: 'x', refKey: 'av:138:submitted' })).toEqual({ skipped: 'already' });
    expect(teamsMock._send).not.toHaveBeenCalled();
  });

  test('quiet hours are kept, people outside a Teams workspace are skipped, and a failure never throws', async () => {
    teamsMock._inQuietHours.mockResolvedValueOnce(true);
    expect(await avTeams.notify('reza@bgc.ca', 'av_submitted', { title: 'x' })).toEqual({ skipped: 'quiet_hours' });
    teamsMock.workspaceSettings.mockResolvedValue({ teamsEnabled: false });
    expect(await avTeams.notify('pa1@bgc.ca', 'av_submitted', { title: 'x' })).toEqual({ skipped: 'teams_off' });
    teamsMock.workspaceSettings.mockResolvedValue({ teamsEnabled: true });
    teamsMock._send.mockRejectedValue(new Error('bot down'));
    expect(await avTeams.notify('reza@bgc.ca', 'av_submitted', { title: 'x' })).toEqual({ failed: true });
    expect(prismaMock.teamsDelivery.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'failed', reason: 'bot down' }) });
  });

  test('off outside production unless the flag is set', async () => {
    delete process.env.AVAILABILITY_TEAMS;
    expect(await avTeams.notify('reza@bgc.ca', 'av_submitted', { title: 'x' })).toEqual({ skipped: 'off_here' });
    expect(await avTeams.runReminders(new Date('2026-10-13T22:00:00Z'))).toEqual({ checked: 0, sent: 0 });
    expect(teamsMock._send).not.toHaveBeenCalled();
  });
});
