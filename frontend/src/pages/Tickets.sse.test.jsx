/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

// Live queue contract (FR 08-07 #13 — instant status sync): a 'ticket-change'
// SSE event in the shape the backend's shared upsert now broadcasts
// ({ action:'sync', ticketId, status, assignedTechId, updatedAt }) must
// live-refresh a VISIBLE row (silent refetch) and route changes to off-page
// tickets into the pending-updates pill instead.
const { listSpy, metaSpy, statsSpy, useSSESpy } = vi.hoisted(() => ({
  listSpy: vi.fn(),
  metaSpy: vi.fn(),
  statsSpy: vi.fn(),
  useSSESpy: vi.fn(),
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
vi.mock('../hooks/useSSE', () => ({ useSSE: useSSESpy }));
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

const row = (id, status, assignedTechId = null) => ({
  id,
  status,
  subject: `Row ${id}`,
  displayRef: `TP-${id}`,
  priority: 2,
  origin: 'freshservice',
  freshserviceTicketId: null,
  assignedTech: null,
  assignedTechId,
  requester: { name: 'Rita' },
  tags: [],
  ai: null,
  createdAt: '2026-08-01T10:00:00Z',
  updatedAt: '2026-08-01T10:00:00Z',
  lastActivityAt: '2026-08-01T10:00:00Z',
});

// The event shape syncService._broadcastTicketChange emits.
const syncEvent = (ticketId, overrides = {}) => ({
  action: 'sync',
  workspaceId: 1,
  ticketId,
  origin: 'freshservice',
  status: 'Resolved',
  assignedTechId: null,
  updatedAt: '2026-08-08T12:00:00Z',
  ...overrides,
});

const lastSSEOptions = () => useSSESpy.mock.calls.at(-1)[0];

// Let the mount-time fetch churn finish (meta resolving changes queryParams,
// which refetches) so post-clear call counts are attributable to the event.
async function settle() {
  await waitFor(() => expect(screen.getAllByText('Row 1').length).toBeGreaterThan(0));
  await act(() => new Promise((resolve) => setTimeout(resolve, 600)));
}

function mount() {
  return render(<Tickets />, {
    wrapper: ({ children }) => <MemoryRouter initialEntries={['/tickets']}>{children}</MemoryRouter>,
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

describe('Tickets queue — live ticket-change wiring (FR 08-07 #13)', () => {
  test('subscribes with an onTicketChange handler over SSE', async () => {
    mount();
    await waitFor(() => expect(listSpy).toHaveBeenCalled());
    expect(useSSESpy).toHaveBeenCalled();
    expect(typeof lastSSEOptions().onTicketChange).toBe('function');
    expect(lastSSEOptions().enabled).toBe(true);
  });

  test('a sync event for a VISIBLE row triggers the silent live refetch (row updates in place)', async () => {
    mount();
    await settle();
    const { onTicketChange } = lastSSEOptions();
    listSpy.mockClear();
    // The refetch delivers the changed row — the queue shows Resolved.
    listSpy.mockResolvedValue({ data: { items: [row(1, 'Resolved', 7), row(2, 'Pending')], total: 2 } });

    act(() => onTicketChange(syncEvent(1, { assignedTechId: 7 })));

    // scheduleLiveRefetch debounces 450ms, then silently refetches.
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(1), { timeout: 2000 });
    // The queue now shows the pushed change without any manual refresh.
    await waitFor(() => expect(screen.getAllByText('Resolved').length).toBeGreaterThan(0));
  });

  test('a sync event for an OFF-PAGE ticket does NOT refetch — it arms the update pill', async () => {
    mount();
    await settle();
    const { onTicketChange } = lastSSEOptions();
    listSpy.mockClear();

    act(() => onTicketChange(syncEvent(999)));

    // Give the (would-be) 450ms live-refetch debounce time to fire.
    await act(() => new Promise((resolve) => setTimeout(resolve, 700)));
    expect(listSpy).not.toHaveBeenCalled();
  });

  test('stat cards refresh silently on any ticket-change (debounced)', async () => {
    mount();
    await settle();
    const { onTicketChange } = lastSSEOptions();
    statsSpy.mockClear();

    act(() => onTicketChange(syncEvent(999)));

    await waitFor(() => expect(statsSpy).toHaveBeenCalled(), { timeout: 2000 });
  });
});
