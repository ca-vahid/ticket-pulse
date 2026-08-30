/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Mega 08-30 Phase MB3/MB4/MB6 (QA 08-27 #6): board drops are loud on
// failure (server message → red toast; a dismissed FS confirm → silence) and
// never vanish on success (a drop into a column the fetch scope excludes
// widens the scope, or offers "Show it" inside a segment).
const { listSpy, metaSpy, statsSpy, setStatusSpy, fsUpdateSpy } = vi.hoisted(() => ({
  listSpy: vi.fn(),
  metaSpy: vi.fn(),
  statsSpy: vi.fn(),
  setStatusSpy: vi.fn(),
  fsUpdateSpy: vi.fn(),
}));

vi.mock('../services/api', () => ({
  ticketsAPI: new Proxy(
    { list: listSpy, meta: metaSpy, stats: statsSpy, setStatus: setStatusSpy, fsUpdate: fsUpdateSpy },
    { get: (target, key) => target[key] || (() => new Promise(() => {})) },
  ),
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
  useWorkspaceRole: () => ({ role: 'admin', canManage: true, canReview: true }),
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
// Board stand-in: one "drop" button per card per target column, wired to the
// page's onStatusDrop exactly like a real dnd-kit drop would be.
vi.mock('../components/tickets/TicketBoard', () => ({
  default: ({ tickets, onStatusDrop }) => (
    <div data-testid="board-stub">
      {tickets.map((t) => (
        <div key={t.id}>
          <span>{t.subject}</span>
          {['Open', 'Pending', 'Closed'].map((s) => (
            <button key={s} onClick={() => onStatusDrop(t, s)}>{`drop ${t.displayRef} to ${s}`}</button>
          ))}
        </div>
      ))}
    </div>
  ),
}));

import Tickets from './Tickets';

const row = (id, status, extra = {}) => ({
  id,
  status,
  subject: `Row ${id}`,
  displayRef: `TP-${id}`,
  priority: 2,
  origin: 'ticketpulse',
  freshserviceTicketId: null,
  assignedTech: null,
  assignedTechId: null,
  requester: { name: 'Rita' },
  tags: [],
  ai: null,
  createdAt: '2026-08-01T10:00:00Z',
  updatedAt: '2026-08-01T10:00:00Z',
  lastActivityAt: '2026-08-01T10:00:00Z',
  ...extra,
});

const lastListParams = () => listSpy.mock.calls.at(-1)[0];

function mount(initialEntry = '/tickets') {
  return render(<Tickets />, {
    wrapper: ({ children }) => <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('tp_ticket_layout', 'board');
  listSpy.mockResolvedValue({ data: { items: [row(1, 'Closed'), row(2, 'Closed', { origin: 'freshservice', displayRef: '#900', freshserviceTicketId: 900 })], total: 2 } });
  metaSpy.mockResolvedValue({
    data: {
      workspaceId: 1,
      nativeTicketingEnabled: true,
      technicians: [],
      groups: [],
      categoryTree: [],
      sources: [],
      tags: [],
      statuses: [],
      actor: { role: 'admin', kind: 'admin' },
    },
  });
  statsSpy.mockResolvedValue({
    data: { all: 40, open: 12, unassigned: 3, awaiting: 2, awaitingApproval: 0, dueToday: 1, overdue: 1, resolved: 20, deleted: 0, noise: 0, byTechnician: {} },
  });
  setStatusSpy.mockResolvedValue({ data: {} });
  fsUpdateSpy.mockResolvedValue({ data: {} });
});

afterEach(cleanup);

describe('board drop — loud failures (Phase MB3)', () => {
  test('a 400 from the status API shows the server message as a red toast (no silent snap-back)', async () => {
    setStatusSpy.mockRejectedValueOnce({ response: { data: { message: 'FreshService did not accept: status (FS kept Closed) — nothing was changed in Ticket Pulse' } } });
    mount('/tickets?status=Closed');
    await screen.findByTestId('board-stub');
    fireEvent.click(screen.getByRole('button', { name: 'drop TP-1 to Pending' }));
    const toast = await screen.findByRole('alert');
    expect(toast).toHaveTextContent('FreshService did not accept: status (FS kept Closed) — nothing was changed in Ticket Pulse');
    expect(toast).toHaveAttribute('data-tone', 'red');
    // The scope was NOT widened by a failed move.
    expect(lastListParams().status).toBe('Closed');
  });

  test('api.js-style enhanced Error (message only) shows its message; a bare failure gets the plain red toast', async () => {
    // api.js re-throws an Error whose .message is the server's message (no .response).
    setStatusSpy.mockRejectedValueOnce(new Error('FreshService did not accept: status'));
    mount('/tickets?status=Closed');
    await screen.findByTestId('board-stub');
    fireEvent.click(screen.getByRole('button', { name: 'drop TP-1 to Open' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('FreshService did not accept: status');
    cleanup();

    setStatusSpy.mockRejectedValueOnce({});
    mount('/tickets?status=Closed');
    await screen.findByTestId('board-stub');
    fireEvent.click(screen.getByRole('button', { name: 'drop TP-1 to Open' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not move TP-1 to Open');
  });

  test('FS-born: the confirm is labeled as a REOPEN; cancelling it is silent (no toast, no write)', async () => {
    mount('/tickets?status=Closed');
    await screen.findByTestId('board-stub');
    fireEvent.click(screen.getByRole('button', { name: 'drop #900 to Pending' }));
    const confirm = await screen.findByRole('dialog', { name: /sync change to freshservice/i });
    expect(within(confirm).getByText('Reopen')).toBeInTheDocument();
    expect(within(confirm).getByText('Pending')).toBeInTheDocument();
    fireEvent.click(within(confirm).getAllByRole('button', { name: /^cancel$/i }).at(-1)); // footer Cancel (the X carries the same label)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /sync change to freshservice/i })).not.toBeInTheDocument());
    expect(fsUpdateSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('board drop — no vanish on success (Phase MB4)', () => {
  test('checkbox scope: Closed → Pending widens the status filter so the reopened card stays visible', async () => {
    mount('/tickets?status=Closed');
    await screen.findByTestId('board-stub');
    fireEvent.click(screen.getByRole('button', { name: 'drop TP-1 to Pending' }));
    await waitFor(() => expect(setStatusSpy).toHaveBeenCalledWith(1, 'Pending'));
    await waitFor(() => expect(lastListParams().status).toBe('Closed,Pending'));
    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent('Reopen TP-1 → Pending · filter widened to show it');
    expect(within(toast).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  test('a drop that stays inside the scope keeps the scope and shows the plain toast', async () => {
    listSpy.mockResolvedValue({ data: { items: [row(1, 'Open')], total: 1 } });
    mount('/tickets'); // default Open+Pending scope
    await screen.findByTestId('board-stub');
    fireEvent.click(screen.getByRole('button', { name: 'drop TP-1 to Pending' }));
    await waitFor(() => expect(setStatusSpy).toHaveBeenCalledWith(1, 'Pending'));
    expect(await screen.findByRole('status')).toHaveTextContent('TP-1 → Pending');
    expect(lastListParams().status).toBe('Open,Pending');
  });

  test('segment scope: a drop outside the segment offers "Show it", which leaves the segment and widens the status list', async () => {
    listSpy.mockResolvedValue({ data: { items: [row(1, 'Open')], total: 1 } });
    mount('/tickets?segment=open');
    await screen.findByTestId('board-stub');
    fireEvent.click(screen.getByRole('button', { name: 'drop TP-1 to Closed' }));
    await waitFor(() => expect(setStatusSpy).toHaveBeenCalledWith(1, 'Closed'));
    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent('TP-1 → Closed — outside the current "open" view');
    fireEvent.click(within(toast).getByRole('button', { name: 'Show it' }));
    await waitFor(() => expect(lastListParams().segment).toBeUndefined());
    expect(lastListParams().status).toBe('Open,Pending,Closed');
  });
});
