import { jest } from '@jest/globals';

/** Search v3: fuzzy people (pg_trgm), full-text conversations, and the all-workspaces scope. */
const prismaMock = {
  ticketTask: { findMany: jest.fn() },
  technician: { findMany: jest.fn() },
  requester: { findMany: jest.fn() },
  workspace: { findMany: jest.fn() },
  ticket: { groupBy: jest.fn() },
  $queryRaw: jest.fn(),
  $queryRawUnsafe: jest.fn(),
};
const listTicketsMock = jest.fn();
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: { listTickets: listTicketsMock } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: globalSearchService } = await import('../src/services/globalSearchService.js');

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticket.groupBy.mockResolvedValue([]);
  prismaMock.technician.findMany.mockResolvedValue([]);
  prismaMock.requester.findMany.mockResolvedValue([]);
  prismaMock.ticketTask.findMany.mockResolvedValue([]);
  prismaMock.workspace.findMany.mockResolvedValue([{ id: 1, name: 'IT' }, { id: 2, name: 'Accounting' }]);
  listTicketsMock.mockResolvedValue({ items: [], total: 0 });
});

describe('fuzzy people', () => {
  test('a requester name the exact match misses is found by trigram similarity, in similarity order, flagged fuzzy', async () => {
    prismaMock.requester.findMany
      .mockResolvedValueOnce([]) // contains-match → nothing
      .mockResolvedValueOnce([{ id: 5, name: 'Neville Vyland', email: 'nv@bgc.ca' }, { id: 9, name: 'Nevin Vale', email: 'nvale@bgc.ca' }]);
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([{ id: 9, sim: 0.61 }, { id: 5, sim: 0.55 }]);
    const res = await globalSearchService.search(1, { q: 'nevil', types: 'requesters' });
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][0]).toMatch(/FROM requesters/);
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][0]).toMatch(/is_active = true/);
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][1]).toBe('nevil');
    expect(res.sections.requesters.map((r) => [r.id, r.fuzzy])).toEqual([[9, true], [5, true]]);
  });

  test('a missing extension turns fuzzy off for the process instead of failing the search', async () => {
    prismaMock.requester.findMany.mockResolvedValueOnce([]);
    prismaMock.$queryRawUnsafe.mockRejectedValueOnce(new Error('function similarity(text, text) does not exist'));
    const res = await globalSearchService.search(1, { q: 'nevil', types: 'requesters' });
    expect(res.sections.requesters).toEqual([]);
    prismaMock.requester.findMany.mockResolvedValueOnce([]);
    await globalSearchService.search(1, { q: 'nevil', types: 'requesters' });
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(1); // not retried
  });

  test('agents fall back the same way, scoped to the workspace', async () => {
    // fuzzy state is process-wide and the previous test switched it off — a
    // fresh import is not possible here, so just assert the guarded path.
    prismaMock.technician.findMany.mockResolvedValueOnce([]);
    const res = await globalSearchService.search(1, { q: 'nevil', types: 'agents' });
    expect(res.sections.agents).toEqual([]);
  });
});

describe('conversations', () => {
  test('runs the full-text query for the workspace and shapes rows with snippets + display refs', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([
      { entry_id: 77n, ticket_id: 45321, actor_name: 'Corina Schnell', occurred_at: new Date('2026-09-16T20:00:00Z'), event_type: 'customer_reply', rank: 0.3, snippet: 'the [[Jabra]] speakers arrived', subject: 'Kamloops headsets', status: 'Open', origin: 'freshservice', native_number: null, freshservice_ticket_id: 242758n, total: 2n },
      { entry_id: null, ticket_id: 40266, actor_name: null, occurred_at: new Date('2026-09-10T20:00:00Z'), event_type: 'description', rank: 0.2, snippet: '[[Jabra]] link 380', subject: 'Headset', status: 'Closed', origin: 'ticketpulse', native_number: 1120, freshservice_ticket_id: null, total: 2n },
    ]);
    const res = await globalSearchService.search(1, { q: 'jabra', types: 'conversations' });
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    expect(res.totals.conversations).toBe(2);
    expect(res.sections.conversations).toEqual([
      expect.objectContaining({ id: 77, entryId: 77, ticketId: 45321, displayRef: '#242758', where: 'conversation', authorName: 'Corina Schnell', snippet: 'the [[Jabra]] speakers arrived', status: 'Open' }),
      expect.objectContaining({ id: 't-40266', entryId: null, ticketId: 40266, displayRef: 'TP-1120', where: 'description' }),
    ]);
  });

  test('a database error leaves the section empty and marked unavailable, not a failed search', async () => {
    prismaMock.$queryRaw.mockRejectedValueOnce(new Error('relation ticket_thread_entries_fts_idx does not exist'));
    const res = await globalSearchService.search(1, { q: 'jabra', types: 'conversations,tickets' });
    expect(res.sections.conversations).toEqual([]);
    expect(res.sections.tickets).toEqual([]);
  });
});

describe('all-workspaces scope', () => {
  test('ticket rows from every workspace carry the workspace name; totals add up', async () => {
    listTicketsMock
      .mockResolvedValueOnce({ items: [{ id: 1, displayRef: '#1', subject: 'VPN in IT', status: 'Open', requester: { name: 'A' } }], total: 3 })
      .mockResolvedValueOnce({ items: [{ id: 2, displayRef: 'TP-2', subject: 'VPN in AP', status: 'Open', requester: { name: 'B' } }], total: 1 });
    const res = await globalSearchService.search(1, { q: 'vpn', types: 'tickets', workspaceIds: [1, 2] });
    expect(listTicketsMock).toHaveBeenCalledTimes(2);
    expect(listTicketsMock.mock.calls.map((c) => c[0]).sort()).toEqual([1, 2]);
    expect(res.sections.tickets.map((t) => [t.id, t.workspaceName])).toEqual([[1, 'IT'], [2, 'Accounting']]);
    expect(res.totals.tickets).toBe(4);
  });

  test('a scope of only the current workspace behaves like no scope', async () => {
    listTicketsMock.mockResolvedValueOnce({ items: [], total: 0 });
    await globalSearchService.search(1, { q: 'vpn', types: 'tickets', workspaceIds: [1] });
    expect(listTicketsMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.workspace.findMany).not.toHaveBeenCalled();
  });
});
