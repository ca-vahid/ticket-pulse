/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Mega 08-23 Phase FC — admin-configurable quick filter cards:
//  - meta.queueCards drives WHICH six cards render (registry-resolved)
//  - absent/invalid config falls back to today's exact classic six
//  - clicking a created-period card writes ?segment=created_month (single-
//    select segment keys, so counts + active-highlight keep working)
//  - the hover gear deep-links admins (and only admins) to /settings#ticket-ops
const { listSpy, metaSpy, statsSpy, getPrefSpy, setPrefSpy, roleRef } = vi.hoisted(() => ({
  listSpy: vi.fn(),
  metaSpy: vi.fn(),
  statsSpy: vi.fn(),
  getPrefSpy: vi.fn(),
  setPrefSpy: vi.fn(),
  roleRef: { value: 'viewer' },
}));

vi.mock('../services/api', () => ({
  ticketsAPI: new Proxy(
    { list: listSpy, meta: metaSpy, stats: statsSpy, getQueuePreference: getPrefSpy, setQueuePreference: setPrefSpy },
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
  useWorkspaceRole: () => roleRef.value,
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
import { DEFAULT_QUEUE_CARDS, QUEUE_CARD_REGISTRY } from '../components/tickets/queueCards';

const STATS = {
  all: 40, open: 12, unassigned: 3, awaiting: 2, awaitingApproval: 0, dueToday: 1, overdue: 1,
  resolved: 20, deleted: 0, noise: 5, createdThisWeek: 4, createdThisMonth: 17, createdThisYear: 123,
  byTechnician: {},
};

function baseMeta(extra = {}) {
  return {
    data: {
      workspaceId: 1,
      nativeTicketingEnabled: false,
      technicians: [],
      groups: [],
      categoryTree: [],
      sources: [],
      tags: [],
      actor: { role: 'admin' },
      ...extra,
    },
  };
}

const lastListParams = () => listSpy.mock.calls.at(-1)[0];
const cardRow = () => screen.getByRole('group', { name: 'Quick segments' });

function mount(initialEntry = '/tickets') {
  return render(<Tickets />, {
    wrapper: ({ children }) => <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  roleRef.value = 'viewer';
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: true,
    media: query,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  listSpy.mockResolvedValue({ data: { items: [], total: 0 } });
  metaSpy.mockResolvedValue(baseMeta());
  statsSpy.mockResolvedValue({ data: STATS });
  getPrefSpy.mockResolvedValue({ data: { key: 'queue.columns', value: null } });
  setPrefSpy.mockResolvedValue({ data: { key: 'queue.columns', value: [] } });
});

afterEach(cleanup);

describe('Quick filter cards (Phase FC)', () => {
  test('no meta.queueCards → today\'s exact classic six render, in order', async () => {
    mount();
    await waitFor(() => expect(screen.getByText('All tickets')).toBeInTheDocument());
    const labels = [...cardRow().querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toEqual(DEFAULT_QUEUE_CARDS.map((k) => `${STATS[QUEUE_CARD_REGISTRY[k].countKey].toLocaleString()}${QUEUE_CARD_REGISTRY[k].label}`));
  });

  test('an invalid stored config (dupes) falls back to the defaults', async () => {
    metaSpy.mockResolvedValue(baseMeta({ queueCards: ['all', 'all', 'open', 'awaiting', 'overdue', 'resolved'] }));
    mount();
    await waitFor(() => expect(screen.getByText('All tickets')).toBeInTheDocument());
    expect(screen.getByText('Due today')).toBeInTheDocument();
    expect(cardRow().querySelectorAll('button')).toHaveLength(6);
  });

  test('a configured set renders the created-period card with its real count', async () => {
    metaSpy.mockResolvedValue(baseMeta({ queueCards: ['all', 'open', 'awaiting', 'created_month', 'overdue', 'resolved'] }));
    mount();
    await waitFor(() => expect(screen.getByText('Tickets this month')).toBeInTheDocument());
    // Slot 4 swapped: Due today is gone, the month card shows createdThisMonth.
    expect(screen.queryByText('Due today')).not.toBeInTheDocument();
    const monthCard = screen.getByText('Tickets this month').closest('button');
    expect(monthCard).toHaveTextContent('17');
  });

  test('clicking "Tickets this month" writes ?segment=created_month (single-select segment key)', async () => {
    metaSpy.mockResolvedValue(baseMeta({ queueCards: ['all', 'open', 'awaiting', 'created_month', 'overdue', 'resolved'] }));
    mount();
    await waitFor(() => expect(screen.getByText('Tickets this month')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Tickets this month').closest('button'));
    await waitFor(() => expect(lastListParams().segment).toBe('created_month'));
    // Segment scope replaces the status checkboxes — no status param rides along.
    expect(lastListParams().status).toBeUndefined();
    expect(screen.getByText('Tickets this month').closest('button')).toHaveAttribute('aria-pressed', 'true');
  });

  test('the configurator gear renders for admins only and deep-links Settings → Ticket Ops', async () => {
    roleRef.value = 'admin';
    mount();
    await waitFor(() => expect(screen.getByText('All tickets')).toBeInTheDocument());
    const gear = screen.getByRole('link', { name: 'Customize quick filter cards' });
    expect(gear).toHaveAttribute('href', '/settings#ticket-ops');

    cleanup();
    roleRef.value = 'viewer';
    mount();
    await waitFor(() => expect(screen.getByText('All tickets')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Customize quick filter cards' })).not.toBeInTheDocument();
  });
});
