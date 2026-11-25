import { jest } from '@jest/globals';

/**
 * QA 11-24 #2: Analytics → Demand → Tickets by department. Deterministic
 * counts of tickets CREATED in range, by the requester's department (Entra job
 * class without its level, through the department table) and by city.
 * The database groups; the ~90 Entra values map in JS; no photoUrl is read.
 */

const prismaMock = {
  ticket: { groupBy: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  requester: { findMany: jest.fn() },
  appSettings: { findUnique: jest.fn().mockResolvedValue(null) },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { getTicketsByDepartment, groupTicketsByPlace } = await import('../src/services/analyticsService.js');

describe('groupTicketsByPlace', () => {
  const people = new Map([
    [1, { id: 1, entraDepartment: 'Accountant I', entraCity: 'Calgary', department: 'Calgary' }],
    [2, { id: 2, entraDepartment: 'Senior II', entraCity: null, entraOfficeLocation: null, department: 'Vancouver' }],
    [3, { id: 3, entraDepartment: null, department: 'Vancouver - Software' }],
    [4, { id: 4, entraDepartment: null, department: 'Kamloops' }],
  ]);

  test('counts by department and by city, with shares, biggest first and Unknown last', () => {
    const out = groupTicketsByPlace([
      { requesterId: 1, ticketDepartment: 'Calgary', count: 5 },
      { requesterId: 2, ticketDepartment: 'Vancouver', count: 3 },
      { requesterId: 3, ticketDepartment: 'Vancouver - Software', count: 1 },
      { requesterId: 4, ticketDepartment: 'Kamloops', count: 6 },
      { requesterId: null, ticketDepartment: null, count: 1 },
    ], people);
    expect(out.total).toBe(16);
    expect(out.departments).toEqual([
      { label: 'Accounting', count: 5, pct: 31.3, unknown: false },
      { label: 'Geoscience & Engineering', count: 3, pct: 18.8, unknown: false },
      { label: 'Software', count: 1, pct: 6.3, unknown: false },
      // Kamloops (a city, no Entra department) + the ticket with no requester
      { label: 'Unknown', count: 7, pct: 43.8, unknown: true },
    ]);
    expect(out.cities.map((r) => [r.label, r.count])).toEqual([
      ['Kamloops', 6], ['Calgary', 5], ['Vancouver', 4], ['Unknown', 1],
    ]);
    expect(out.coverage).toEqual({ departmentKnown: 9, cityKnown: 15, total: 16 });
  });

  test('no tickets → empty lists', () => {
    expect(groupTicketsByPlace([], new Map())).toEqual({ total: 0, departments: [], cities: [], coverage: { departmentKnown: 0, cityKnown: 0, total: 0 } });
  });
});

describe('getTicketsByDepartment', () => {
  beforeEach(() => jest.clearAllMocks());

  test('groups in the database within the workspace, range and noise switch; reads four profile columns, never photoUrl', async () => {
    prismaMock.ticket.groupBy.mockResolvedValue([
      { requesterId: 7, department: 'Vancouver', _count: { _all: 4 } },
      { requesterId: 8, department: 'Calgary', _count: { _all: 2 } },
    ]);
    prismaMock.requester.findMany.mockResolvedValue([
      { id: 7, department: 'Vancouver', entraDepartment: 'CAD II', entraCity: 'Vancouver', entraOfficeLocation: null },
      { id: 8, department: 'Calgary', entraDepartment: 'Information Technology I', entraCity: null, entraOfficeLocation: 'Calgary' },
    ]);
    const data = await getTicketsByDepartment(42, { range: 'custom', start: '2026-10-01', end: '2026-10-31', excludeNoise: 'true', timezone: 'America/Vancouver' });

    const args = prismaMock.ticket.groupBy.mock.calls[0][0];
    expect(args.by).toEqual(['requesterId', 'department']);
    expect(args.where.workspaceId).toBe(42);
    expect(args.where.isNoise).toBe(false);
    expect(args.where.createdAt.gte).toBeInstanceOf(Date);
    expect(args.where.createdAt.lte).toBeInstanceOf(Date);
    const reqArgs = prismaMock.requester.findMany.mock.calls[0][0];
    expect(reqArgs.where).toEqual({ id: { in: [7, 8] } });
    expect(reqArgs.select).toEqual({ id: true, department: true, entraDepartment: true, entraCity: true, entraOfficeLocation: true });
    expect(JSON.stringify(reqArgs.select)).not.toMatch(/photo/i);

    expect(data.total).toBe(6);
    expect(data.departments.map((r) => [r.label, r.count, r.pct])).toEqual([['CAD', 4, 66.7], ['IT', 2, 33.3]]);
    expect(data.cities.map((r) => r.label)).toEqual(['Vancouver', 'Calgary']);
    expect(data.metadata.range).toMatchObject({ start: '2026-10-01', end: '2026-10-31' });
  });

  test('the same query is served from the analytics cache', async () => {
    prismaMock.ticket.groupBy.mockResolvedValue([]);
    const q = { range: '7d', excludeNoise: 'false', timezone: 'America/Vancouver', probe: 'cache' };
    await getTicketsByDepartment(43, q);
    await getTicketsByDepartment(43, q);
    expect(prismaMock.ticket.groupBy).toHaveBeenCalledTimes(1);
    expect(prismaMock.requester.findMany).not.toHaveBeenCalled();
  });
});
