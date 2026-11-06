/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// 5 Nov 2026 (QA): clicking a column heading to sort "refreshed the entire
// screen" — the table was swapped for the loading card, the page collapsed and
// the scroll position was lost. A refetch now keeps the rows (dimmed, busy),
// and the newest request always wins.
const { listSpy, metaSpy, statsSpy, getPrefSpy } = vi.hoisted(() => ({
  listSpy: vi.fn(),
  metaSpy: vi.fn(),
  statsSpy: vi.fn(),
  getPrefSpy: vi.fn(),
}));

vi.mock('../services/api', () => ({
  ticketsAPI: new Proxy(
    { list: listSpy, meta: metaSpy, stats: statsSpy, getQueuePreference: getPrefSpy, setQueuePreference: vi.fn(() => Promise.resolve({})) },
    { get: (target, key) => target[key] || (() => new Promise(() => {})) },
  ),
  assignmentAPI: { decide: vi.fn(), latestRun: vi.fn(() => new Promise(() => {})) },
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
vi.mock('../components/tickets/TicketFilterRail', () => ({ default: () => null, ActiveFilterBar: () => null }));
vi.mock('../components/tickets/AiAssignModal', () => ({ default: () => null }));
vi.mock('../components/tickets/MobileAssignSheet', () => ({ default: () => null }));
vi.mock('../assets/tickets-hero.png', () => ({ default: 'hero.png' }));

import Tickets from './Tickets';

const row = (id) => ({
  id,
  status: 'Open',
  subject: `Row ${id}`,
  displayRef: `TP-${id}`,
  priority: 2,
  origin: 'freshservice',
  freshserviceTicketId: null,
  assignedTech: null,
  assignedTechId: null,
  requester: { name: 'Alex Rivera' },
  source: 2,
  tags: [],
  ai: null,
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-01T10:00:00Z',
  lastActivityAt: '2026-10-01T10:00:00Z',
});
const page = (...ids) => ({ data: { items: ids.map(row), total: ids.length } });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
// The page's own list fetch asks for the rail's facets; board columns don't.
const listCalls = () => listSpy.mock.calls.filter(([p]) => p?.facets);
// Each row renders its subject link twice (phone card + desktop row).
const rowOrder = () => [...new Set(screen.getAllByRole('link', { name: /^Row \d+$/ }).map((a) => a.textContent))];
const listCard = () => screen.getAllByRole('link', { name: /^Row \d+$/ })[0].closest('.tp-card');

function mount(initialEntry = '/tickets') {
  return render(<Tickets />, {
    wrapper: ({ children }) => <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: true, media: query, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
  metaSpy.mockResolvedValue({ data: { workspaceId: 1, nativeTicketingEnabled: false, technicians: [], groups: [], categoryTree: [], sources: [], tags: [], actor: { role: 'admin' } } });
  statsSpy.mockResolvedValue({ data: { all: 3, open: 3, unassigned: 3, awaiting: 0, awaitingApproval: 0, dueToday: 0, overdue: 0, resolved: 0, deleted: 0, noise: 0, byTechnician: {} } });
  getPrefSpy.mockResolvedValue({ data: { key: 'queue.columns', value: null } });
});
afterEach(cleanup);

// Whole-page renders: generous timeouts so a busy machine doesn't flake them.
describe('Tickets list — a refetch keeps the rows (5 Nov 2026)', { timeout: 20000 }, () => {
  test('first load still shows the spinner card', async () => {
    listSpy.mockReturnValue(new Promise(() => {}));
    mount();
    expect(await screen.findByLabelText('Loading tickets')).toBeInTheDocument();
  });

  test('changing the sort keeps the rows in the DOM while loading, then shows the new order', async () => {
    listSpy.mockResolvedValue(page(1, 2, 3));
    mount();
    await waitFor(() => expect(rowOrder()).toEqual(['Row 1', 'Row 2', 'Row 3']));
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });

    const next = deferred();
    listSpy.mockImplementation((p) => (p?.facets ? next.promise : new Promise(() => {})));
    fireEvent.click(screen.getByRole('button', { name: /^Requester/ }));
    await waitFor(() => expect(listCalls().at(-1)[0].sort).toBe('requester'));

    // Rows stay; no loading card; the card says it is busy.
    expect(screen.queryByLabelText('Loading tickets')).not.toBeInTheDocument();
    expect(rowOrder()).toEqual(['Row 1', 'Row 2', 'Row 3']);
    expect(listCard()).toHaveAttribute('aria-busy', 'true');
    // After a beat the rows dim, the small heading spinner shows and the
    // live region says so.
    expect(screen.queryByTestId('queue-refetch-spinner')).not.toBeInTheDocument();
    expect(await screen.findByTestId('queue-refetch-spinner')).toBeInTheDocument();
    expect(listCard()).toHaveAttribute('data-refetching', 'true');
    expect(screen.getByTestId('queue-refetch-status')).toHaveTextContent('Updating results');
    // Rows stay clickable while dimmed (nothing blocks the pointer).
    expect(screen.getAllByRole('link', { name: /^Row \d+$/ })[0].closest('ul').className).not.toMatch(/pointer-events-none/);

    await act(async () => { next.resolve(page(3, 1, 2)); });
    await waitFor(() => expect(rowOrder()).toEqual(['Row 3', 'Row 1', 'Row 2']));
    expect(listCard()).not.toHaveAttribute('aria-busy');
    expect(screen.queryByTestId('queue-refetch-spinner')).not.toBeInTheDocument();
    expect(screen.getByTestId('queue-refetch-status')).toHaveTextContent('');
  });

  test('two quick sorts end in the last one, even when the first answers last', async () => {
    listSpy.mockResolvedValue(page(1, 2, 3));
    mount();
    await waitFor(() => expect(rowOrder()).toEqual(['Row 1', 'Row 2', 'Row 3']));
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });

    const first = deferred();
    const second = deferred();
    listSpy.mockImplementation((p) => {
      if (!p?.facets) return new Promise(() => {});
      return p.dir === 'asc' ? second.promise : first.promise;
    });
    const requesterHeading = () => screen.getAllByRole('button', { name: /^Requester/ }).find((b) => b.closest('.tp-q-head'));
    fireEvent.click(requesterHeading()); // sort=requester (desc)
    await waitFor(() => expect(listCalls().at(-1)[0].sort).toBe('requester'));
    fireEvent.click(requesterHeading()); // same column again → ascending
    await waitFor(() => expect(listCalls().at(-1)[0].dir).toBe('asc'));

    await act(async () => { second.resolve(page(2, 3, 1)); });
    await waitFor(() => expect(rowOrder()).toEqual(['Row 2', 'Row 3', 'Row 1']));
    // The slow first answer lands last and must not overwrite the newer order.
    await act(async () => { first.resolve(page(9, 8, 7)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(rowOrder()).toEqual(['Row 2', 'Row 3', 'Row 1']);
    expect(listCard()).not.toHaveAttribute('aria-busy');
  });

  test('a refetch after an empty result shows the spinner card (nothing to keep)', async () => {
    listSpy.mockResolvedValue({ data: { items: [], total: 0 } });
    mount();
    expect(await screen.findByText('No tickets match these filters')).toBeInTheDocument();
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    listSpy.mockImplementation(() => new Promise(() => {}));
    // The toolbar's Sort menu: flip the direction.
    const sortButton = screen.getAllByRole('button', { expanded: false }).find((b) => /created/i.test(b.textContent));
    fireEvent.click(sortButton);
    fireEvent.click(await screen.findByRole('menuitem', { name: /Switch to ascending/ }));
    expect(await screen.findByLabelText('Loading tickets')).toBeInTheDocument();
  });
});
