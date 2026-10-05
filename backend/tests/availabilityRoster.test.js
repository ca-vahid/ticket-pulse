import { jest } from '@jest/globals';

/**
 * Availability team calendar scope (5 Oct 2026, Vahid): the calendar shows the
 * active agents of the workspace you are in, not every Ticket Pulse user, and
 * not the "Other teams" people kept assignable-only (isActive false).
 */

const IT = [
  { email: 'vhaeri@bgc.ca', workspaceId: 1 },
  { email: 'snasiri@bgc.ca', workspaceId: 1 },
];
const AP = [{ email: 'alexa@bgc.ca', workspaceId: 2 }];
const techFindMany = jest.fn(async ({ where }) => {
  const all = [...IT, ...AP];
  if (where.workspaceId?.in) return all.filter((t) => where.workspaceId.in.includes(t.workspaceId)).map((t) => ({ email: t.email }));
  // "workspaces I am an active agent in"
  return all.filter((t) => t.email === String(where.email.equals).toLowerCase()).map((t) => ({ workspaceId: t.workspaceId }));
});
const prismaMock = {
  technician: { findMany: techFindMany, findFirst: jest.fn() },
  workspaceAccess: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  avPerson: { findMany: jest.fn().mockResolvedValue([]) },
  avRequest: { findMany: jest.fn().mockResolvedValue([]) },
  avLeaveType: { findMany: jest.fn().mockResolvedValue([]) },
  holiday: { findMany: jest.fn().mockResolvedValue([]) },
  avApprovalGroupMember: { findMany: jest.fn().mockResolvedValue([]) },
  avApprovalGroup: { findMany: jest.fn().mockResolvedValue([]) },
  avOffice: { findMany: jest.fn().mockResolvedValue([]) },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: svc } = await import('../src/services/availability/availabilityService.js');

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.workspaceAccess.findFirst.mockResolvedValue(null);
  prismaMock.workspaceAccess.findMany.mockResolvedValue([]);
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.avApprovalGroupMember.findMany.mockResolvedValue([]);
  prismaMock.avRequest.findMany.mockResolvedValue([]);
  prismaMock.holiday.findMany.mockResolvedValue([]);
});

test('an agent in IT sees the IT agents only, queried as active agents of that workspace', async () => {
  prismaMock.technician.findFirst.mockResolvedValue({ id: 1 });
  const roster = await svc.rosterFor({ email: 'VHaeri@bgc.ca', role: 'agent' }, 1);
  expect([...roster].sort()).toEqual(['snasiri@bgc.ca', 'vhaeri@bgc.ca']);
  expect(techFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: { in: [1] }, isActive: true }) }));
});

test('service accounts (the Ticket Pulse agent, domain-admin twins) are not on the team', async () => {
  prismaMock.technician.findFirst.mockResolvedValue({ id: 1 });
  const techs = techFindMany.getMockImplementation();
  techFindMany.mockImplementation(async (args) => (args.where?.workspaceId?.in
    ? [{ email: 'a@bgc.ca', name: 'Ann Lo' }, { email: 'tp@bgc.ca', name: 'Ticket Pulse' }, { email: 'adm@bgc.ca', name: 'Vahid Haeri Domain Admin' }]
    : techs(args)));
  const roster = await svc.rosterFor({ email: 'vhaeri@bgc.ca', role: 'agent' }, 5);
  techFindMany.mockImplementation(techs);
  expect([...roster].sort()).toEqual(['a@bgc.ca', 'vhaeri@bgc.ca']);
});

test('a workspace the viewer does not belong to falls back to their own workspaces', async () => {
  const roster = await svc.rosterFor({ email: 'alexa@bgc.ca', role: 'agent' }, 1);
  expect([...roster]).toEqual(['alexa@bgc.ca']);
});

test('a member (no agent row) of the workspace sees its agents, and themselves', async () => {
  prismaMock.workspaceAccess.findFirst.mockResolvedValue({ id: 4 });
  const roster = await svc.rosterFor({ email: 'manager@bgc.ca', role: 'user' }, 2);
  expect([...roster].sort()).toEqual(['alexa@bgc.ca', 'manager@bgc.ca']);
});

test('an app admin may look at any workspace', async () => {
  const roster = await svc.rosterFor({ email: 'boss@bgc.ca', role: 'admin' }, 2);
  expect(roster.has('alexa@bgc.ca')).toBe(true);
  expect(roster.has('snasiri@bgc.ca')).toBe(false);
});

test('the calendar only asks for people on the roster', async () => {
  prismaMock.technician.findFirst.mockResolvedValue({ id: 1 });
  await svc.calendar({ email: 'vhaeri@bgc.ca', role: 'agent' }, { from: '2026-10-01', to: '2026-10-31', workspaceId: 1 });
  const where = prismaMock.avPerson.findMany.mock.calls[0][0].where;
  expect(where.email.in.sort()).toEqual(['snasiri@bgc.ca', 'vhaeri@bgc.ca']);
});

// 5 Oct 2026 (Vahid): waiting requests are only for the people who decide them.
describe('waiting requests and holidays on the calendar', () => {
  const TYPES = [{ id: 1, name: 'Vacation', color: 'emerald', visibility: 'public', availability: 'OFF' }];
  const ROWS = [
    { id: 10, email: 'snasiri@bgc.ca', leaveTypeId: 1, startDate: new Date('2026-10-13T00:00:00Z'), endDate: new Date('2026-10-14T00:00:00Z'), dayPart: 'full', status: 'approved' },
    { id: 11, email: 'snasiri@bgc.ca', leaveTypeId: 1, startDate: new Date('2026-10-20T00:00:00Z'), endDate: new Date('2026-10-20T00:00:00Z'), dayPart: 'full', status: 'pending' },
  ];
  beforeEach(() => {
    prismaMock.technician.findFirst.mockResolvedValue({ id: 1 });
    prismaMock.avPerson.findMany.mockResolvedValue([{ email: 'snasiri@bgc.ca', name: 'Soheil Nasiri', officeId: 1 }]);
    prismaMock.avLeaveType.findMany.mockResolvedValue(TYPES);
    prismaMock.avRequest.findMany.mockResolvedValue(ROWS);
  });

  test('a colleague who is not their approver sees the approved leave only', async () => {
    prismaMock.avApprovalGroupMember.findMany.mockResolvedValue([{ group: { approvers: [{ email: 'boss@bgc.ca', isDelegate: false }] } }]);
    const cal = await svc.calendar({ email: 'vhaeri@bgc.ca', role: 'agent' }, { from: '2026-10-01', to: '2026-10-31', workspaceId: 1 });
    expect(cal.entries.map((e) => e.status)).toEqual(['approved']);
    expect(cal.canSeePending).toBe(false);
  });

  test('their approver sees the waiting request too', async () => {
    prismaMock.avApprovalGroupMember.findMany.mockResolvedValue([{ group: { approvers: [{ email: 'vhaeri@bgc.ca', isDelegate: false }] } }]);
    const cal = await svc.calendar({ email: 'vhaeri@bgc.ca', role: 'agent' }, { from: '2026-10-01', to: '2026-10-31', workspaceId: 1 });
    expect(cal.entries.map((e) => e.status).sort()).toEqual(['approved', 'pending']);
    expect(cal.canSeePending).toBe(true);
  });

  test('holidays come back with their names (recurring by month and day)', async () => {
    prismaMock.holiday.findMany.mockResolvedValue([
      { date: new Date('2026-10-12T00:00:00Z'), name: 'Thanksgiving', isRecurring: false, isEnabled: true },
      { date: new Date('2020-11-11T00:00:00Z'), name: 'Remembrance Day', isRecurring: true, isEnabled: true },
    ]);
    const cal = await svc.calendar({ email: 'vhaeri@bgc.ca', role: 'agent' }, { from: '2026-10-01', to: '2026-11-30', workspaceId: 1 });
    expect(cal.holidayNames).toEqual({ '2026-10-12': 'Thanksgiving', '2026-11-11': 'Remembrance Day' });
    expect(cal.holidays).toEqual(['2026-10-12', '2026-11-11']);
    const next = await svc.upcomingHolidays({ from: new Date(2026, 9, 5), limit: 1 });
    expect(next).toEqual([{ date: '2026-10-12', name: 'Thanksgiving' }]);
  });
});

describe('roster for the team views', () => {
  test('people with photo, office and approval groups; only groups that have someone here', async () => {
    prismaMock.technician.findFirst.mockResolvedValue({ id: 1 });
    prismaMock.avPerson.findMany.mockResolvedValue([
      { email: 'snasiri@bgc.ca', name: 'snasiri', officeId: 2 },
      { email: 'vhaeri@bgc.ca', name: 'Vahid Haeri', officeId: 1 },
    ]);
    const techs = techFindMany.getMockImplementation();
    techFindMany.mockImplementation(async (args) => (args.select?.photoUrl
      ? [{ email: 'SNasiri@bgc.ca', name: 'Soheil Nasiri', photoUrl: 'data:image/png;base64,xx' }]
      : techs(args)));
    prismaMock.avApprovalGroupMember.findMany.mockResolvedValue([{ email: 'snasiri@bgc.ca', groupId: 7 }]);
    prismaMock.avApprovalGroup.findMany.mockResolvedValue([{ id: 7, name: 'IT' }, { id: 8, name: 'Accounting' }]);
    prismaMock.avOffice.findMany.mockResolvedValue([{ id: 1, name: 'Vancouver' }]);
    const out = await svc.roster({ email: 'vhaeri@bgc.ca', role: 'agent' }, 1);
    techFindMany.mockImplementation(techs);
    expect(out.people).toEqual([
      { email: 'snasiri@bgc.ca', name: 'Soheil Nasiri', officeId: 2, photoUrl: 'data:image/png;base64,xx', groupIds: [7] },
      { email: 'vhaeri@bgc.ca', name: 'Vahid Haeri', officeId: 1, photoUrl: null, groupIds: [] },
    ]);
    expect(out.groups).toEqual([{ id: 7, name: 'IT' }]);
    expect(out.offices).toEqual([{ id: 1, name: 'Vancouver' }]);
  });
});
