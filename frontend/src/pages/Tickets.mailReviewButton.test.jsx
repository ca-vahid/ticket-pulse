/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// 11 Nov 2026: the held-mail button opens the Mail review page. It shows when
// e-mail is waiting OR Mail triage is not Off (meta.triageMode on the existing
// held-count call), so Done, Undo and the Log stay reachable at zero.
const { listSpy, metaSpy, statsSpy, getPrefSpy, heldSpy } = vi.hoisted(() => ({
  listSpy: vi.fn(), metaSpy: vi.fn(), statsSpy: vi.fn(), getPrefSpy: vi.fn(), heldSpy: vi.fn(),
}));

vi.mock('../services/api', () => ({
  ticketsAPI: new Proxy(
    { list: listSpy, meta: metaSpy, stats: statsSpy, getQueuePreference: getPrefSpy, setQueuePreference: vi.fn(() => Promise.resolve({})), listHeldMessages: heldSpy },
    { get: (target, key) => target[key] || (() => new Promise(() => {})) },
  ),
  assignmentAPI: { decide: vi.fn(), latestRun: vi.fn(() => new Promise(() => {})) },
  getGlobalExcludeNoise: vi.fn(() => false),
  setGlobalExcludeNoise: vi.fn(),
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { email: 'qa@example.com', role: 'admin' }, logout: vi.fn() }) }));
vi.mock('../contexts/WorkspaceContext', () => ({ useWorkspace: () => ({ currentWorkspace: { id: 1, name: 'IT', slug: 'it' }, availableWorkspaces: [] }) }));
vi.mock('../components/nav/navDestinations', () => ({ useWorkspaceRole: () => ({ role: 'admin', canManage: true, canReview: true }), NAV_DESTINATIONS: [] }));
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
  id, status: 'Open', subject: `Row ${id}`, displayRef: `TP-${id}`, priority: 2, origin: 'freshservice', freshserviceTicketId: null,
  assignedTech: null, assignedTechId: null, requester: { name: 'Alex Rivera' }, source: 2, tags: [], ai: null,
  createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z', lastActivityAt: '2026-10-01T10:00:00Z',
});
const mount = () => render(<Tickets />, { wrapper: ({ children }) => <MemoryRouter initialEntries={['/tickets']}>{children}</MemoryRouter> });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: true, media: query, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
  metaSpy.mockResolvedValue({ data: { workspaceId: 1, nativeTicketingEnabled: false, technicians: [], groups: [], categoryTree: [], sources: [], tags: [], actor: { role: 'admin' } } });
  statsSpy.mockResolvedValue({ data: { all: 1, open: 1, unassigned: 1, awaiting: 0, awaitingApproval: 0, dueToday: 0, overdue: 0, resolved: 0, deleted: 0, noise: 0, byTechnician: {} } });
  getPrefSpy.mockResolvedValue({ data: { key: 'queue.columns', value: null } });
  listSpy.mockResolvedValue({ data: { items: [row(1)], total: 1 } });
});
afterEach(cleanup);

const loaded = () => waitFor(() => expect(screen.getAllByRole('link', { name: 'Row 1' }).length).toBeGreaterThan(0));

describe('Tickets: the Mail review button', { timeout: 20000 }, () => {
  test('held e-mail waiting: "Mail review · N"', async () => {
    heldSpy.mockResolvedValue({ data: [], meta: { heldCount: 5, triageMode: 'off' } });
    mount();
    await loaded();
    const button = await screen.findByTestId('held-replies-pill');
    expect(button).toHaveTextContent('Mail review· 5');
    expect(button).not.toHaveAttribute('aria-haspopup');
  });

  test('nothing waiting but Mail triage is in Shadow: the button still shows, without a number', async () => {
    heldSpy.mockResolvedValue({ data: [], meta: { heldCount: 0, triageMode: 'shadow' } });
    mount();
    await loaded();
    const button = await screen.findByTestId('held-replies-pill');
    expect(button.textContent.trim()).toBe('Mail review');
  });

  test('nothing waiting and Mail triage off (or an older server): no button', async () => {
    heldSpy.mockResolvedValue({ data: [], meta: { heldCount: 0, triageMode: 'off' } });
    mount();
    await loaded();
    await waitFor(() => expect(heldSpy).toHaveBeenCalled());
    expect(screen.queryByTestId('held-replies-pill')).not.toBeInTheDocument();
    cleanup();
    heldSpy.mockResolvedValue({ data: [], meta: { heldCount: 0 } });
    mount();
    await loaded();
    expect(screen.queryByTestId('held-replies-pill')).not.toBeInTheDocument();
  });
});
