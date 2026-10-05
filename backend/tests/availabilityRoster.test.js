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
  workspaceAccess: { findFirst: jest.fn() },
  avPerson: { findMany: jest.fn().mockResolvedValue([]) },
  avRequest: { findMany: jest.fn().mockResolvedValue([]) },
  avLeaveType: { findMany: jest.fn().mockResolvedValue([]) },
  holiday: { findMany: jest.fn().mockResolvedValue([]) },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: svc } = await import('../src/services/availability/availabilityService.js');

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.workspaceAccess.findFirst.mockResolvedValue(null);
  prismaMock.technician.findFirst.mockResolvedValue(null);
});

test('an agent in IT sees the IT agents only, queried as active agents of that workspace', async () => {
  prismaMock.technician.findFirst.mockResolvedValue({ id: 1 });
  const roster = await svc.rosterFor({ email: 'VHaeri@bgc.ca', role: 'agent' }, 1);
  expect([...roster].sort()).toEqual(['snasiri@bgc.ca', 'vhaeri@bgc.ca']);
  expect(techFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: { in: [1] }, isActive: true }) }));
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
