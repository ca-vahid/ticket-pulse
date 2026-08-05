/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Queue-truth contract tests (QA 08-04 Phase 1): the STATUS SCOPE the page
// actually fetches with must match what the UI claims — stat cards, board
// mode and the sort headers all wire real request params, no silent widening.
const { listSpy, metaSpy, statsSpy } = vi.hoisted(() => ({
  listSpy: vi.fn(),
  metaSpy: vi.fn(),
  statsSpy: vi.fn(),
}));

vi.mock('../services/api', () => ({
  ticketsAPI: new Proxy(
    { list: listSpy, meta: metaSpy, stats: statsSpy },
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

import Tickets from './Tickets';

const row = (id, status) => ({
  id,
  status,
  subject: `Row ${id}`,
  displayRef: `TP-${id}`,
  priority: 2,
  origin: 'freshservice',
  freshserviceTicketId: null,
  assignedTech: null,
  assignedTechId: null,
  requester: { name: 'Rita' },
  tags: [],
  ai: null,
  createdAt: '2026-08-01T10:00:00Z',
  updatedAt: '2026-08-01T10:00:00Z',
  lastActivityAt: '2026-08-01T10:00:00Z',
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
  listSpy.mockResolvedValue({ data: { items: [row(1, 'Open'), row(2, 'Pending')], total: 2 } });
  metaSpy.mockResolvedValue({
    data: {
      workspaceId: 1,
      nativeTicketingEnabled: false,
      technicians: [],
      groups: [],
      categoryTree: [],
      sources: [],
      tags: [],
      actor: { role: 'admin' },
    },
  });
  statsSpy.mockResolvedValue({
    data: { all: 40, open: 12, unassigned: 3, awaiting: 2, awaitingApproval: 0, dueToday: 1, overdue: 1, resolved: 20, deleted: 0, noise: 0, byTechnician: {} },
  });
});

afterEach(cleanup);

describe('Tickets queue scope (QA 08-04 Phase 1)', () => {
  test('default fetch scope is Open+Pending — in list AND board mode (board no longer widens silently)', async () => {
    mount();
    await waitFor(() => expect(listSpy).toHaveBeenCalled());
    expect(lastListParams().status).toBe('Open,Pending');
    expect(lastListParams().segment).toBeUndefined();
    cleanup();

    localStorage.setItem('tp_ticket_layout', 'board');
    listSpy.mockClear();
    mount();
    await waitFor(() => expect(listSpy).toHaveBeenCalled());
    // Board sends the SAME scope as the list — rail checkboxes stay honest.
    expect(lastListParams().status).toBe('Open,Pending');
  });

  test('board with the default scope shows the Closed-hidden empty state', async () => {
    localStorage.setItem('tp_ticket_layout', 'board');
    mount();
    await waitFor(() => expect(screen.getByText('Closed hidden by current filters')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Show closed' })).toBeInTheDocument();
  });

  test('All-tickets card applies status=any — card scope now matches its count (parity with the rail view)', async () => {
    mount();
    await waitFor(() => expect(listSpy).toHaveBeenCalled());

    screen.getByRole('button', { name: /All tickets/ }).click();
    await waitFor(() => expect(lastListParams().status).toBeUndefined());
    expect(lastListParams().segment).toBeUndefined(); // truly unscoped, like status=any
  });

  test('Open card keeps its segment scope (status cleared, segment=open)', async () => {
    mount('/tickets?status=any');
    await waitFor(() => expect(listSpy).toHaveBeenCalled());

    screen.getByRole('button', { name: /Open$/ }).click();
    await waitFor(() => expect(lastListParams().segment).toBe('open'));
    expect(lastListParams().status).toBeUndefined();
  });

  test('Status header sorts Open-first (asc) then flips; Due header sorts soonest-first', async () => {
    mount();
    await waitFor(() => expect(listSpy).toHaveBeenCalled());

    // Query by title — the toolbar's sort-menu button adopts the "Status"
    // label once that sort is active, so plain name queries go ambiguous.
    (await screen.findByTitle('Sort by status (Open first)')).click();
    await waitFor(() => expect(lastListParams().sort).toBe('status'));
    expect(lastListParams().dir).toBe('asc');

    (await screen.findByTitle('Sort by status (Open first)')).click();
    await waitFor(() => expect(lastListParams().dir).toBe('desc'));
    expect(lastListParams().sort).toBe('status');

    (await screen.findByTitle('Sort by due date (soonest first)')).click();
    await waitFor(() => expect(lastListParams().sort).toBe('dueBy'));
    expect(lastListParams().dir).toBe('asc');
  });
});
