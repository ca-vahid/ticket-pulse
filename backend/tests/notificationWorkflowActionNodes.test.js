import { jest } from '@jest/globals';

const prismaMock = {
  technician: { findMany: jest.fn(), findFirst: jest.fn() },
  ticket: { groupBy: jest.fn(), findUnique: jest.fn() },
  ticketAssignmentEpisode: { groupBy: jest.fn() },
  groupMember: { findMany: jest.fn() },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  resolveAssignmentTarget,
  resolveInternalGroupEmails,
  webhookUrlProblem,
} = await import('../src/services/notificationWorkflowActionNodes.js');

beforeEach(() => jest.clearAllMocks());

describe('assignment strategies', () => {
  const team = [
    { id: 1, name: 'Alice' },
    { id: 2, name: 'Bob' },
    { id: 3, name: 'Cora' },
  ];

  test('tech mode validates the configured technician is active in the workspace', async () => {
    prismaMock.technician.findFirst.mockResolvedValue({ id: 2, name: 'Bob' });
    const target = await resolveAssignmentTarget(1, { mode: 'tech', technicianId: 2 });
    expect(target).toEqual({ techId: 2, techName: 'Bob', mode: 'tech' });

    prismaMock.technician.findFirst.mockResolvedValue(null);
    const missing = await resolveAssignmentTarget(1, { mode: 'tech', technicianId: 99 });
    expect(missing.error).toMatch(/not active/i);
  });

  test('least_loaded picks the tech with the fewest open tickets', async () => {
    prismaMock.technician.findMany.mockResolvedValue(team);
    prismaMock.ticket.groupBy.mockResolvedValue([
      { assignedTechId: 1, _count: { _all: 7 } },
      { assignedTechId: 2, _count: { _all: 2 } },
      // Cora has none — wins.
    ]);
    const target = await resolveAssignmentTarget(1, { mode: 'least_loaded' });
    expect(target.techId).toBe(3);
    expect(target.load).toBe(0);
  });

  test('round_robin picks the least-recently-assigned (never-assigned first)', async () => {
    prismaMock.technician.findMany.mockResolvedValue(team);
    prismaMock.ticketAssignmentEpisode.groupBy.mockResolvedValue([
      { technicianId: 1, _max: { startedAt: new Date('2026-07-06T10:00:00Z') } },
      { technicianId: 3, _max: { startedAt: new Date('2026-07-06T09:00:00Z') } },
      // Bob has never been assigned — wins.
    ]);
    const target = await resolveAssignmentTarget(1, { mode: 'round_robin' });
    expect(target.techId).toBe(2);
  });

  test('no active technicians is a clean error, not a crash', async () => {
    prismaMock.technician.findMany.mockResolvedValue([]);
    const target = await resolveAssignmentTarget(1, { mode: 'least_loaded' });
    expect(target.error).toMatch(/no active technicians/i);
  });
});

describe('webhook URL guard (SSRF)', () => {
  test.each([
    ['https://example.com/hook', null],
    ['http://api.partner.io/x', null],
    ['ftp://example.com', 'must be http'],
    ['not a url', 'not a valid URL'],
    ['http://localhost:3000/x', 'private'],
    ['http://127.0.0.1/x', 'private'],
    ['http://10.1.2.3/x', 'private'],
    ['http://192.168.1.5/x', 'private'],
    ['http://172.16.0.9/x', 'private'],
    ['http://169.254.169.254/latest/meta-data', 'private'],
  ])('%s → %s', (url, fragment) => {
    const problem = webhookUrlProblem(url);
    if (fragment === null) expect(problem).toBeNull();
    else expect(problem).toMatch(new RegExp(fragment, 'i'));
  });
});

describe('internal group recipient resolution', () => {
  test('resolves active member emails and ignores inactive/missing', async () => {
    prismaMock.groupMember.findMany.mockResolvedValue([
      { technician: { email: 'a@x.io', isActive: true } },
      { technician: { email: 'b@x.io', isActive: false } },
      { technician: { email: null, isActive: true } },
    ]);
    const emails = await resolveInternalGroupEmails(['internal_group:5', 'requester']);
    expect(emails).toEqual(['a@x.io']);
    expect(prismaMock.groupMember.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { groupId: { in: [5] } },
    }));
  });

  test('no group tokens → no query', async () => {
    const emails = await resolveInternalGroupEmails(['requester', 'assigned_agent']);
    expect(emails).toEqual([]);
    expect(prismaMock.groupMember.findMany).not.toHaveBeenCalled();
  });
});
