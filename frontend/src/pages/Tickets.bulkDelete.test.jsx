/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// 2 Oct 2026: bulk delete from the bulk bar — mixed TP/FS selection, one
// ticket per request (sequential), continue-on-failure, report vs toast.
const { listSpy, metaSpy, statsSpy, bulkDeleteSpy } = vi.hoisted(() => ({
  listSpy: vi.fn(),
  metaSpy: vi.fn(),
  statsSpy: vi.fn(),
  bulkDeleteSpy: vi.fn(),
}));

vi.mock('../services/api', () => ({
  ticketsAPI: new Proxy(
    { list: listSpy, meta: metaSpy, stats: statsSpy, bulkDelete: bulkDeleteSpy },
    { get: (target, key) => target[key] || (() => new Promise(() => {})) },
  ),
  assignmentAPI: { recordOverrideReason: vi.fn() },
  getGlobalExcludeNoise: vi.fn(() => false),
  setGlobalExcludeNoise: vi.fn(),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { email: 'qa@example.com', role: 'admin' }, logout: vi.fn() }),
}));
vi.mock('../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspace: { id: 1, name: 'IT', slug: 'it' }, availableWorkspaces: [] }),
}));
vi.mock('../components/nav/navDestinations', () => ({
  useWorkspaceRole: () => 'admin',
  NAV_DESTINATIONS: [],
}));
vi.mock('../hooks/useSSE', () => ({ useSSE: vi.fn() }));
vi.mock('../components/AppHeader', () => ({ default: () => <div>AppHeader</div> }));
vi.mock('../components/nav/MobileTabBar', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketPreview', () => ({ default: () => null }));
vi.mock('../components/tickets/ScheduledTicketsPanel', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketFilterRail', () => ({
  default: () => null,
  ActiveFilterBar: () => null,
}));
vi.mock('../components/tickets/AiAssignModal', () => ({ default: () => null }));
vi.mock('../components/tickets/MobileAssignSheet', () => ({ default: () => null }));
vi.mock('../assets/tickets-hero.png', () => ({ default: 'hero.png' }));

import Tickets from './Tickets';

const row = (id, origin) => ({
  id,
  status: 'Open',
  subject: `Row ${id}`,
  displayRef: origin === 'ticketpulse' ? `TP-${id}` : `#${240000 + id}`,
  priority: 2,
  origin,
  nativeNumber: origin === 'ticketpulse' ? id : null,
  freshserviceTicketId: origin === 'ticketpulse' ? null : String(240000 + id),
  assignedTech: null,
  assignedTechId: null,
  requester: { name: 'Rita' },
  tags: [],
  ai: null,
  createdAt: '2026-08-01T10:00:00Z',
  updatedAt: '2026-08-01T10:00:00Z',
  lastActivityAt: '2026-08-01T10:00:00Z',
});

const ADMIN = { kind: 'admin', role: 'admin', workspaceRole: 'admin', technicianId: 2 };
// The server's view: a deleted ticket no longer comes back from list().
let serverRows = [];
function setup(rows, actor = ADMIN) {
  serverRows = [...rows];
  listSpy.mockImplementation(async () => ({ data: { items: serverRows, total: serverRows.length } }));
  metaSpy.mockResolvedValue({
    data: { workspaceId: 1, nativeTicketingEnabled: true, technicians: [], groups: [], categoryTree: [], sources: [], tags: [], actor },
  });
}
function mount() {
  return render(<Tickets />, {
    wrapper: ({ children }) => <MemoryRouter initialEntries={['/tickets']}>{children}</MemoryRouter>,
  });
}
const selectAll = async () => {
  mount();
  await screen.findAllByText('Row 1');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select all tickets on this page' }));
  return screen.findByTestId('bulk-action-bar');
};
const okResult = (id) => {
  serverRows = serverRows.filter((r) => r.id !== id);
  return { data: { deleted: 1, failed: 0, results: [{ id, ok: true }] } };
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  statsSpy.mockResolvedValue({
    data: { all: 2, open: 2, unassigned: 0, awaiting: 0, awaitingApproval: 0, dueToday: 0, overdue: 0, resolved: 0, deleted: 0, noise: 0, byTechnician: {} },
  });
  bulkDeleteSpy.mockImplementation(async ([id]) => okResult(id));
});
afterEach(cleanup);

describe('Tickets bulk delete (2 Oct 2026)', () => {
  test('confirm states the TP / FreshService split; deletes go one ticket per request, in order, never overlapping', async () => {
    setup([row(1, 'ticketpulse'), row(2, 'freshservice'), row(3, 'freshservice')]);
    let inFlight = 0;
    let maxInFlight = 0;
    bulkDeleteSpy.mockImplementation(async ([id]) => {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return okResult(id);
    });
    const bar = await selectAll();
    fireEvent.click(within(bar).getByTestId('bulk-delete'));
    const dialog = await screen.findByTestId('bulk-delete-dialog');
    expect(dialog).toHaveTextContent('1 Ticket Pulse ticket');
    expect(dialog).toHaveTextContent('2 FreshService tickets');
    expect(bulkDeleteSpy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByTestId('bulk-delete-confirm'));
    await waitFor(() => expect(bulkDeleteSpy).toHaveBeenCalledTimes(3));
    expect(bulkDeleteSpy.mock.calls.map((c) => c[0])).toEqual([[1], [2], [3]]);
    expect(maxInFlight).toBe(1);
    // ≤5: a toast, no report; deleted rows leave the list.
    expect(await screen.findByText('3 deleted')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('bulk-delete-dialog')).not.toBeInTheDocument());
    expect(screen.queryByText('Row 2')).not.toBeInTheDocument();
  });

  test('shows progress while running', async () => {
    setup([row(1, 'freshservice'), row(2, 'freshservice')]);
    let release;
    bulkDeleteSpy.mockImplementation(([id]) => new Promise((r) => { release = () => r(okResult(id)); }));
    const bar = await selectAll();
    fireEvent.click(within(bar).getByTestId('bulk-delete'));
    fireEvent.click(within(await screen.findByTestId('bulk-delete-dialog')).getByTestId('bulk-delete-confirm'));
    expect(await screen.findByTestId('bulk-delete-progress')).toHaveTextContent('Deleting 1 of 2…');
    release();
    await waitFor(() => expect(screen.getByTestId('bulk-delete-progress')).toHaveTextContent('Deleting 2 of 2…'));
    release();
    await waitFor(() => expect(screen.queryByTestId('bulk-delete-dialog')).not.toBeInTheDocument());
  });

  test('≤5 with a failure: the rest still run, toast names the failure, the failed row stays selected', async () => {
    setup([row(1, 'freshservice'), row(2, 'freshservice'), row(3, 'ticketpulse')]);
    bulkDeleteSpy.mockImplementation(async ([id]) => (id === 2
      ? { data: { deleted: 0, failed: 1, results: [{ id, ok: false, error: 'FreshService refused the delete — locked.' }] } }
      : okResult(id)));
    const bar = await selectAll();
    fireEvent.click(within(bar).getByTestId('bulk-delete'));
    fireEvent.click(within(await screen.findByTestId('bulk-delete-dialog')).getByTestId('bulk-delete-confirm'));
    await waitFor(() => expect(bulkDeleteSpy).toHaveBeenCalledTimes(3));
    expect(await screen.findByText('2 deleted, 1 failed — #240002: FreshService refused the delete — locked.')).toBeInTheDocument();
    expect(screen.getAllByText('Row 2').length).toBeGreaterThan(0);
    expect(screen.queryByText('Row 1')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select #240002' })).toBeChecked();
    expect(screen.getByTestId('bulk-action-bar')).toHaveTextContent('1 selected');
  });

  test('a request error on one ticket is recorded and the next still goes', async () => {
    setup([row(1, 'freshservice'), row(2, 'freshservice')]);
    bulkDeleteSpy.mockImplementation(async ([id]) => {
      if (id === 1) throw Object.assign(new Error('x'), { response: { data: { message: 'FreshService is busy' } } });
      return okResult(id);
    });
    const bar = await selectAll();
    fireEvent.click(within(bar).getByTestId('bulk-delete'));
    fireEvent.click(within(await screen.findByTestId('bulk-delete-dialog')).getByTestId('bulk-delete-confirm'));
    await waitFor(() => expect(bulkDeleteSpy).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('1 deleted, 1 failed — #240001: FreshService is busy')).toBeInTheDocument();
  });

  test('more than 5: a report dialog lists each ticket with its outcome; failed rows stay selected', async () => {
    const rows = [1, 2, 3, 4, 5, 6, 7].map((id) => row(id, id % 2 ? 'freshservice' : 'ticketpulse'));
    setup(rows);
    bulkDeleteSpy.mockImplementation(async ([id]) => (id === 3 || id === 6
      ? { data: { deleted: 0, failed: 1, results: [{ id, ok: false, error: `nope ${id}` }] } }
      : okResult(id)));
    const bar = await selectAll();
    fireEvent.click(within(bar).getByTestId('bulk-delete'));
    fireEvent.click(within(await screen.findByTestId('bulk-delete-dialog')).getByTestId('bulk-delete-confirm'));
    const summary = await screen.findByTestId('bulk-delete-summary');
    expect(summary).toHaveTextContent('5 deleted, 2 failed');
    const list = screen.getByTestId('bulk-delete-results');
    expect(within(list).getAllByRole('listitem')).toHaveLength(7);
    expect(within(list).getAllByLabelText('Failed')).toHaveLength(2);
    expect(within(list).getAllByLabelText('Deleted')).toHaveLength(5);
    expect(list).toHaveTextContent('nope 3');
    expect(list).toHaveTextContent('nope 6');
    expect(screen.queryByText(/failed — #/)).not.toBeInTheDocument(); // no toast on top of the report
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByTestId('bulk-delete-dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('bulk-action-bar')).toHaveTextContent('2 selected');
    expect(screen.getByRole('checkbox', { name: 'Select #240003' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select TP-6' })).toBeChecked();
  });

  test('Delete… is hidden for members without reviewer/admin access', async () => {
    setup([row(1, 'freshservice')], { kind: 'member', role: 'viewer', workspaceRole: 'viewer', technicianId: 2 });
    const bar = await selectAll();
    expect(within(bar).queryByTestId('bulk-delete')).not.toBeInTheDocument();
  });

  test('a reviewer gets it', async () => {
    setup([row(1, 'freshservice')], { kind: 'member', role: 'viewer', workspaceRole: 'reviewer', technicianId: 2 });
    const bar = await selectAll();
    expect(within(bar).getByTestId('bulk-delete')).toBeInTheDocument();
  });
});

describe('Arrival toast from the ticket page', () => {
  test('a toast handed over in navigation state is shown once', async () => {
    setup([row(1, 'freshservice')]);
    render(<Tickets />, {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={[{ pathname: '/tickets', state: { toast: { tone: 'emerald', message: 'FreshService #240001 deleted in FreshService' } } }]}>
          {children}
        </MemoryRouter>
      ),
    });
    expect(await screen.findByText('FreshService #240001 deleted in FreshService')).toBeInTheDocument();
  });
});
