/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// QA 10-16 #7 — the date window on the Tickets toolbar:
//  - 90 days by default; the list sends createdWithin and the cards count in it
//  - a pick becomes the person's default (server preference + local mirror)
//  - a typed search, explicit Created dates and ?created=all send no window
//  - windowed cards (All tickets, Resolved…) say which window they counted
const { listSpy, metaSpy, statsSpy, getPrefSpy, setPrefSpy } = vi.hoisted(() => ({
  listSpy: vi.fn(),
  metaSpy: vi.fn(),
  statsSpy: vi.fn(),
  getPrefSpy: vi.fn(),
  setPrefSpy: vi.fn(),
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
  useWorkspaceRole: () => 'viewer',
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

const STATS = {
  all: 40, open: 12, unassigned: 3, awaiting: 2, awaitingApproval: 0, dueToday: 1, overdue: 1,
  resolved: 20, deleted: 0, noise: 5, createdThisWeek: 4, createdThisMonth: 17, createdThisYear: 123,
  byTechnician: {},
};

const lastListParams = () => listSpy.mock.calls.at(-1)[0];
const windowGroup = () => screen.getByTestId('created-window');
const cardRow = () => screen.getByRole('group', { name: 'Quick segments' });

function mount(initialEntry = '/tickets') {
  return render(<Tickets />, {
    wrapper: ({ children }) => <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: true, media: query, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
  listSpy.mockResolvedValue({ data: { items: [], total: 0 } });
  metaSpy.mockResolvedValue({ data: { workspaceId: 1, nativeTicketingEnabled: false, technicians: [], groups: [], categoryTree: [], sources: [], tags: [], actor: { role: 'admin' } } });
  statsSpy.mockImplementation((win) => Promise.resolve({ data: { ...STATS, createdWithin: win || null } }));
  getPrefSpy.mockResolvedValue({ data: { value: null } });
  setPrefSpy.mockResolvedValue({ data: {} });
});

afterEach(cleanup);

describe('Tickets date window (QA 10-16 #7)', () => {
  test('defaults to 90 days: the list and the cards both use it, and the windowed cards say so', async () => {
    mount();
    await waitFor(() => expect(lastListParams().createdWithin).toBe('90d'));
    expect(statsSpy).toHaveBeenLastCalledWith('90d');
    expect(within(windowGroup()).getByRole('button', { name: '90 days' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(within(cardRow()).getByText('All tickets · 90d')).toBeInTheDocument());
    // Open work never follows the window, so its card carries no note.
    expect(within(cardRow()).getByText('Open')).toBeInTheDocument();
  });

  test('a pick becomes the default (server preference + local mirror) and re-counts the cards', async () => {
    mount();
    await waitFor(() => expect(lastListParams().createdWithin).toBe('90d'));
    fireEvent.click(within(windowGroup()).getByRole('button', { name: '30 days' }));
    await waitFor(() => expect(lastListParams().createdWithin).toBe('30d'));
    expect(setPrefSpy).toHaveBeenCalledWith('queue.createdWindow', '30d');
    expect(localStorage.getItem('tp_queue_created_window')).toBe('30d');
    await waitFor(() => expect(statsSpy).toHaveBeenLastCalledWith('30d'));

    fireEvent.click(within(windowGroup()).getByRole('button', { name: 'All time' }));
    await waitFor(() => expect(lastListParams().createdWithin).toBeUndefined());
    await waitFor(() => expect(statsSpy).toHaveBeenLastCalledWith(null));
  });

  test('the server preference wins over the default', async () => {
    getPrefSpy.mockImplementation((key) => Promise.resolve({ data: { value: key === 'queue.createdWindow' ? '7d' : null } }));
    mount();
    await waitFor(() => expect(lastListParams().createdWithin).toBe('7d'));
  });

  test('a search, explicit Created dates and ?created=all look at every date', async () => {
    mount('/tickets?q=printer');
    await waitFor(() => expect(listSpy).toHaveBeenCalled());
    expect(lastListParams().q).toBe('printer');
    expect(lastListParams().createdWithin).toBeUndefined();
    expect(screen.getByTestId('created-window-note')).toHaveTextContent('All dates');
    cleanup();

    mount('/tickets?createdFrom=2026-01-01&createdTo=2026-01-31');
    await waitFor(() => expect(lastListParams().createdFrom).toBe('2026-01-01'));
    expect(lastListParams().createdWithin).toBeUndefined();
    expect(screen.getByTestId('created-window-note')).toHaveTextContent('Custom dates');
    cleanup();

    mount('/tickets?created=all');
    await waitFor(() => expect(listSpy).toHaveBeenCalled());
    expect(lastListParams().createdWithin).toBeUndefined();
  });

  test('an empty windowed list offers "Show all time" for this view only', async () => {
    mount('/tickets?segment=resolved');
    const show = await screen.findByRole('button', { name: 'Show all time' });
    fireEvent.click(show);
    await waitFor(() => expect(lastListParams().createdWithin).toBeUndefined());
    expect(lastListParams().segment).toBe('resolved');
    // A one-off: the person's default is untouched.
    expect(setPrefSpy).not.toHaveBeenCalledWith('queue.createdWindow', 'all');
  });

  test('a card keeps the window (its number was counted in it)', async () => {
    mount('/tickets?created=30d&aiState=suggested');
    await waitFor(() => expect(lastListParams().createdWithin).toBe('30d'));
    fireEvent.click(within(cardRow()).getByText('Resolved · 30d').closest('button'));
    await waitFor(() => expect(lastListParams().segment).toBe('resolved'));
    expect(lastListParams().createdWithin).toBe('30d');
    expect(lastListParams().aiState).toBeUndefined();
  });
});
