import { jest } from '@jest/globals';

/**
 * Multi-entity search service (QA 08-04 #2, Phase 7): section fan-out,
 * per-section caps, and — above all — workspace isolation.
 */

const prismaMock = {
  ticketTask: { findMany: jest.fn() },
  technician: { findMany: jest.fn() },
  requester: { findMany: jest.fn() },
};
const listTicketsMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({
  default: { listTickets: listTicketsMock },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: globalSearchService, parseSearchTypes, SEARCH_SECTIONS } =
  await import('../src/services/globalSearchService.js');

// A cross-workspace task fixture: the mock honours the where-clause's
// workspaceId filters the same way Postgres would, so a scoping regression in
// the service (dropping either filter) surfaces as a ws2 leak here.
const TASK_ROWS = [
  {
    id: 1, workspaceId: 1, title: 'Replace printer toner', status: 'open', dueAt: null,
    assignedTech: { id: 9, name: 'Mehdi' },
    ticket: { id: 100, workspaceId: 1, subject: 'Printer down', origin: 'ticketpulse', nativeNumber: 42, freshserviceTicketId: null },
  },
  {
    id: 2, workspaceId: 2, title: 'Replace printer fuser', status: 'done', dueAt: null,
    assignedTech: null,
    ticket: { id: 200, workspaceId: 2, subject: 'AP printer', origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 555n },
  },
];

function honourTaskScoping(where) {
  return TASK_ROWS.filter((row) => {
    if (where.workspaceId !== undefined && row.workspaceId !== where.workspaceId) return false;
    const joinWs = where.ticket?.is?.workspaceId;
    if (joinWs !== undefined && row.ticket.workspaceId !== joinWs) return false;
    return (row.title || '').toLowerCase().includes(String(where.title?.contains || '').toLowerCase());
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  listTicketsMock.mockResolvedValue({ items: [] });
  prismaMock.ticketTask.findMany.mockImplementation(async ({ where }) => honourTaskScoping(where));
  prismaMock.technician.findMany.mockResolvedValue([]);
  prismaMock.requester.findMany.mockResolvedValue([]);
});

describe('parseSearchTypes', () => {
  test('defaults to every section', () => {
    expect(parseSearchTypes(undefined)).toEqual(SEARCH_SECTIONS);
    expect(parseSearchTypes('')).toEqual(SEARCH_SECTIONS);
  });

  test('keeps only known sections, case-insensitively', () => {
    expect(parseSearchTypes('Tasks, agents ,bogus')).toEqual(['tasks', 'agents']);
  });

  test('all-unknown input falls back to every section', () => {
    expect(parseSearchTypes('bogus,nope')).toEqual(SEARCH_SECTIONS);
  });
});

describe('globalSearchService.search', () => {
  test('short queries return empty sections without touching the database', async () => {
    const result = await globalSearchService.search(1, { q: 'p' });
    expect(result.sections).toEqual({ tickets: [], tasks: [], agents: [], requesters: [], departments: [] });
    expect(listTicketsMock).not.toHaveBeenCalled();
    expect(prismaMock.ticketTask.findMany).not.toHaveBeenCalled();
  });

  test('types narrows which sections run', async () => {
    const result = await globalSearchService.search(1, { q: 'printer', types: 'tasks' });
    expect(Object.keys(result.sections)).toEqual(['tasks']);
    expect(listTicketsMock).not.toHaveBeenCalled();
    expect(prismaMock.technician.findMany).not.toHaveBeenCalled();
    expect(prismaMock.requester.findMany).not.toHaveBeenCalled();
    expect(prismaMock.ticketTask.findMany).toHaveBeenCalledTimes(1);
  });

  test('tickets section reuses listTickets q semantics and slims the rows', async () => {
    listTicketsMock.mockResolvedValue({
      items: [{
        id: 7, displayRef: 'TP-7', subject: 'VPN broken', status: 'Open',
        requester: { name: 'Ana', email: 'ana@x.com' }, description: 'huge body that must not leak',
      }],
    });
    const result = await globalSearchService.search(3, { q: 'vpn', types: 'tickets' });
    expect(listTicketsMock).toHaveBeenCalledWith(3, { q: 'vpn', pageSize: 7 });
    expect(result.sections.tickets).toEqual([
      { id: 7, displayRef: 'TP-7', subject: 'VPN broken', status: 'Open', requesterName: 'Ana' },
    ]);
  });

  test('WORKSPACE ISOLATION: a ws2 task never appears in a ws1 search', async () => {
    const result = await globalSearchService.search(1, { q: 'printer', types: 'tasks' });
    expect(result.sections.tasks).toHaveLength(1);
    expect(result.sections.tasks[0]).toMatchObject({
      id: 1, title: 'Replace printer toner', status: 'open', assignedTechName: 'Mehdi',
      ticket: { id: 100, displayRef: 'TP-42', subject: 'Printer down' },
    });
    // Belt AND braces: both the denormalized column and the parent-ticket join
    // must carry the workspace id.
    const { where, take } = prismaMock.ticketTask.findMany.mock.calls[0][0];
    expect(where.workspaceId).toBe(1);
    expect(where.ticket).toEqual({ is: { workspaceId: 1 } });
    expect(where.title).toEqual({ contains: 'printer', mode: 'insensitive' });
    expect(take).toBe(7);
  });

  test('ws2 search sees only the ws2 task, with its FS-born parent ref', async () => {
    const result = await globalSearchService.search(2, { q: 'printer', types: 'tasks' });
    expect(result.sections.tasks).toHaveLength(1);
    expect(result.sections.tasks[0].ticket.displayRef).toBe('#555');
    expect(result.sections.tasks[0].assignedTechName).toBeNull();
  });

  test('agents are workspace-scoped, active-only, and match name OR email', async () => {
    prismaMock.technician.findMany.mockResolvedValue([
      { id: 4, name: 'Gaby', email: 'gaby@bgc.ca', photoUrl: null, location: 'Vancouver' },
    ]);
    const result = await globalSearchService.search(5, { q: 'gaby@', types: 'agents' });
    const args = prismaMock.technician.findMany.mock.calls[0][0];
    expect(args.where.workspaceId).toBe(5);
    expect(args.where.isActive).toBe(true);
    expect(args.where.OR).toEqual([
      { name: { contains: 'gaby@', mode: 'insensitive' } },
      { email: { contains: 'gaby@', mode: 'insensitive' } },
    ]);
    expect(args.take).toBe(7);
    expect(result.sections.agents).toEqual([
      { id: 4, name: 'Gaby', email: 'gaby@bgc.ca', photoUrl: null, location: 'Vancouver' },
    ]);
  });

  test('requesters match by email, are active-only, and skip the Entra directory', async () => {
    prismaMock.requester.findMany.mockResolvedValue([
      { id: 11, name: 'Ana Ruiz', email: 'ana.ruiz@bgc.ca', department: null, entraDepartment: 'Geotech', jobTitle: 'Engineer' },
    ]);
    const result = await globalSearchService.search(1, { q: 'ana.ruiz@', types: 'requesters' });
    const args = prismaMock.requester.findMany.mock.calls[0][0];
    expect(args.where.isActive).toBe(true);
    expect(args.where.OR).toEqual([
      { name: { contains: 'ana.ruiz@', mode: 'insensitive' } },
      { email: { contains: 'ana.ruiz@', mode: 'insensitive' } },
    ]);
    expect(args.take).toBe(7);
    // entraDepartment backfills the department display field
    expect(result.sections.requesters).toEqual([
      { id: 11, name: 'Ana Ruiz', email: 'ana.ruiz@bgc.ca', department: 'Geotech', jobTitle: 'Engineer' },
    ]);
  });

  test('departments merge both columns case-insensitively, scoped to requesters with tickets here', async () => {
    prismaMock.requester.findMany
      .mockResolvedValueOnce([{ department: 'Accounting' }, { department: 'accounts payable' }, { department: '  ' }])
      .mockResolvedValueOnce([{ entraDepartment: 'ACCOUNTING' }, { entraDepartment: 'Accounting Ops' }]);
    const result = await globalSearchService.search(2, { q: 'acc', types: 'departments' });
    expect(result.sections.departments).toEqual([
      { name: 'Accounting' }, { name: 'Accounting Ops' }, { name: 'accounts payable' },
    ]);
    for (const call of prismaMock.requester.findMany.mock.calls) {
      expect(call[0].where.tickets).toEqual({ some: { workspaceId: 2 } });
    }
  });

  test('departments cap at 7 after merging', async () => {
    prismaMock.requester.findMany
      .mockResolvedValueOnce(Array.from({ length: 6 }, (_, i) => ({ department: `Dept ${i}` })))
      .mockResolvedValueOnce(Array.from({ length: 6 }, (_, i) => ({ entraDepartment: `Entra ${i}` })));
    const result = await globalSearchService.search(1, { q: 'dep', types: 'departments' });
    expect(result.sections.departments).toHaveLength(7);
  });
});
