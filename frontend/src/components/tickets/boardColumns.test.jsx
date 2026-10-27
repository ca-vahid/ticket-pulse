/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render as rtlRender, renderHook, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// QA 10-27 #4: the board's columns fetch their own statuses. The QA case:
// Open + Pending + Closed ticked, 2 / 2 / 223 tickets — the old board sliced
// the 50 newest rows and Pending read "0 on page".
const list = vi.hoisted(() => vi.fn());
vi.mock('../../services/api', () => ({ ticketsAPI: { list } }));

import { BOARD_PAGE, boardColumnScopes, columnQuery, useBoardColumns } from './boardColumns';
import TicketBoard from './TicketBoard';

const DEFS = [
  { name: 'Open', baseStatus: 'Open' },
  { name: 'Pending', baseStatus: 'Pending' },
  { name: 'Resolved', baseStatus: 'Resolved' },
  { name: 'Closed', baseStatus: 'Closed' },
  { name: 'In Triage', baseStatus: 'Open' },
];
const ALL = DEFS.length + 1; // + Parked
const byKey = (scopes) => Object.fromEntries(scopes.map((s) => [s.key, s]));
const t = (id, status) => ({ id, status, subject: `Ticket ${id}`, displayRef: `TP-${id}`, priority: 2, origin: 'ticketpulse', tags: [] });

afterEach(cleanup);
beforeEach(() => { list.mockReset(); });

describe('boardColumnScopes', () => {
  test('no status filter → every column, Pending also takes parked tickets', () => {
    const s = byKey(boardColumnScopes({ statusDefs: DEFS, statuses: [], allCount: ALL }));
    expect(s.open.statusParam).toBe('Open,In Triage');
    expect(s.pending.statusParam).toBe('Pending,Waiting on Customer,Waiting on Third Party,parked');
    expect(s.closed.statusParam).toBe('Resolved,Closed');
    expect(s.closed.note).toBe('incl. Resolved');
  });

  test('the QA pick (Open, Pending, Closed) → each column asks for its own; Closed alone, no Resolved note', () => {
    const s = byKey(boardColumnScopes({ statusDefs: DEFS, statuses: ['Open', 'Pending', 'Closed'], allCount: ALL }));
    expect(s.open.statusParam).toBe('Open');
    expect(s.pending.statusParam).toBe('Pending');
    expect(s.closed.statusParam).toBe('Closed');
    expect(s.closed.label).toBeUndefined();
    expect(s.closed.note).toBeUndefined();
  });

  test('Pending + Resolved → no Open column; the terminal column is titled Resolved and resolves on drop', () => {
    const s = byKey(boardColumnScopes({ statusDefs: DEFS, statuses: ['Pending', 'Resolved'], allCount: ALL }));
    expect(s.open.inScope).toBe(false);
    expect(s.pending.inScope).toBe(true);
    expect(s.closed).toMatchObject({ inScope: true, statusParam: 'Resolved', label: 'Resolved', dropStatus: 'Resolved' });
  });

  test('Parked alone → only the Pending column, asking for parked tickets', () => {
    const s = byKey(boardColumnScopes({ statusDefs: DEFS, statuses: ['parked'], allCount: ALL }));
    expect(s.pending.statusParam).toBe('parked');
    expect(s.open.inScope).toBe(false);
    expect(s.closed.inScope).toBe(false);
  });

  test('segments keep their own scope', () => {
    const unassigned = byKey(boardColumnScopes({ statusDefs: DEFS, segment: 'unassigned', allCount: ALL }));
    expect([unassigned.open.inScope, unassigned.pending.inScope, unassigned.closed.inScope]).toEqual([true, true, false]);
    expect(unassigned.pending.statusParam).not.toContain('parked');
    const overdue = byKey(boardColumnScopes({ statusDefs: DEFS, segment: 'overdue', allCount: ALL }));
    expect([overdue.open.inScope, overdue.pending.inScope, overdue.closed.inScope]).toEqual([true, false, false]);
    const deleted = boardColumnScopes({ statusDefs: DEFS, segment: 'deleted', allCount: ALL });
    expect(deleted.every((c) => !c.inScope)).toBe(true);
  });

  test('columnQuery keeps the page filters and swaps in the column statuses', () => {
    const scope = byKey(boardColumnScopes({ statusDefs: DEFS, statuses: ['Pending'], allCount: ALL })).pending;
    expect(columnQuery({ page: 3, pageSize: 50, facets: 'status', status: 'Pending,Closed', parkedSplit: '1', assignedTechId: '7', q: 'vpn', sort: 'createdAt' }, scope))
      .toEqual({ assignedTechId: '7', q: 'vpn', sort: 'createdAt', status: 'Pending', parkedSplit: '1', page: 1, pageSize: BOARD_PAGE });
  });
});

describe('useBoardColumns', () => {
  test('one request per column in scope, each with its own total; load more appends the next page', async () => {
    list.mockImplementation((params) => {
      const n = { Open: 2, Pending: 2, Closed: 223 }[params.status];
      const start = (params.page - 1) * params.pageSize;
      const items = Array.from({ length: Math.max(0, Math.min(params.pageSize, n - start)) }, (_, i) => t(`${params.status}-${start + i}`, params.status));
      return Promise.resolve({ data: { items, total: n } });
    });
    const scopes = boardColumnScopes({ statusDefs: DEFS, statuses: ['Open', 'Pending', 'Closed'], allCount: ALL });
    const { result } = renderHook(() => useBoardColumns({ enabled: true, baseParams: { sort: 'createdAt' }, scopes, refreshKey: 0 }));
    await waitFor(() => expect(result.current.columns.closed?.loading).toBe(false));
    expect(list).toHaveBeenCalledTimes(3);
    expect(result.current.columns.pending).toMatchObject({ total: 2 });
    expect(result.current.columns.pending.items).toHaveLength(2);
    expect(result.current.columns.closed.items).toHaveLength(50);
    await act(async () => { result.current.loadMore('closed'); });
    await waitFor(() => expect(result.current.columns.closed.items).toHaveLength(100));
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'Closed', page: 2, pageSize: 50 }));
  });

  test('disabled (list layout) → no requests', () => {
    const scopes = boardColumnScopes({ statusDefs: DEFS, statuses: [], allCount: ALL });
    renderHook(() => useBoardColumns({ enabled: false, baseParams: {}, scopes, refreshKey: 0 }));
    expect(list).not.toHaveBeenCalled();
  });
});

describe('TicketBoard with per-column data', () => {
  const render = (ui) => rtlRender(ui, { wrapper: MemoryRouter });

  test('headers show each column\'s true total; a column out of scope is not shown; Load more is per column', () => {
    const scopes = boardColumnScopes({ statusDefs: DEFS, statuses: ['Pending', 'Closed'], allCount: ALL });
    const loadMore = vi.fn();
    const columns = {
      pending: { items: [t(1, 'Pending'), t(2, 'Pending')], total: 8, loading: false },
      closed: { items: [t(3, 'Closed')], total: 20265, loading: false },
    };
    render(<TicketBoard tickets={[]} ticketingOn statusDefs={DEFS} columnData={{ scopes, columns, loadMore }} />);
    expect(screen.queryByRole('region', { name: 'Open column' })).toBeNull();
    const pending = screen.getByRole('region', { name: 'Pending column' });
    expect(within(pending).getByTestId('board-column-count')).toHaveTextContent('8');
    expect(screen.queryByText(/on page/)).toBeNull();
    expect(within(pending).getByText('Ticket 1')).toBeInTheDocument();
    const closed = screen.getByRole('region', { name: 'Closed column' });
    expect(within(closed).getByTestId('board-column-count')).toHaveTextContent('20,265');
    fireEvent.click(within(pending).getByRole('button', { name: /Load more · 6 left/ }));
    expect(loadMore).toHaveBeenCalledWith('pending');
  });

  test('Resolved-only scope titles the terminal column Resolved', () => {
    const scopes = boardColumnScopes({ statusDefs: DEFS, statuses: ['Resolved'], allCount: ALL });
    render(<TicketBoard tickets={[]} ticketingOn statusDefs={DEFS} columnData={{ scopes, columns: { closed: { items: [], total: 0, loading: false } }, loadMore: vi.fn() }} />);
    expect(screen.getByRole('region', { name: 'Resolved column' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Pending column' })).toBeNull();
  });

  test('Closed out of scope keeps its explainer column', () => {
    const scopes = boardColumnScopes({ statusDefs: DEFS, statuses: ['Open'], allCount: ALL });
    render(<TicketBoard tickets={[]} ticketingOn statusDefs={DEFS} closedExcluded onShowClosed={vi.fn()} columnData={{ scopes, columns: { open: { items: [], total: 0, loading: false } }, loadMore: vi.fn() }} />);
    expect(screen.getByRole('region', { name: 'Closed column' })).toBeInTheDocument();
    expect(screen.getByText('Closed hidden by current filters')).toBeInTheDocument();
  });
});
