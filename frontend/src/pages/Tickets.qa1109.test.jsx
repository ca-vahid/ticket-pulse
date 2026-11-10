/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// QA 11-09 #5: a typed ticket number is looked up in every status (the
// workspace's default status filter stands aside), and a ticket that was
// combined into another says where the conversation went.
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
  searchAPI: { global: vi.fn(() => new Promise(() => {})) },
  uiPreferencesAPI: { get: vi.fn(() => Promise.resolve({ data: { value: null } })), set: vi.fn(() => Promise.resolve({})) },
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

const STATUSES = [
  { name: 'Open', baseStatus: 'Open' }, { name: 'Pending', baseStatus: 'Pending' }, { name: 'Closed', baseStatus: 'Closed' },
];
const lastListParams = () => listSpy.mock.calls.at(-1)[0];

function mount(initialEntry) {
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
  // The workspace opens the list on Open + Pending by default (Settings → Ticket Ops).
  metaSpy.mockResolvedValue({ data: {
    workspaceId: 1, nativeTicketingEnabled: false, technicians: [], groups: [], categoryTree: [], sources: [], tags: [],
    actor: { role: 'admin' }, statuses: STATUSES, defaultStatuses: ['Open', 'Pending'],
  } });
  statsSpy.mockResolvedValue({ data: { all: 3, open: 1, byTechnician: {} } });
  getPrefSpy.mockResolvedValue({ data: { value: null } });
  setPrefSpy.mockResolvedValue({ data: {} });
});

afterEach(cleanup);

describe('a typed ticket number (QA 11-09 #5)', () => {
  test('is looked up in every status: the default status filter stands aside', async () => {
    mount('/tickets?q=TP-11639');
    await waitFor(() => expect(metaSpy).toHaveBeenCalled());
    await waitFor(() => expect(lastListParams().q).toBe('TP-11639'));
    await waitFor(() => expect(listSpy.mock.calls.some(([p]) => p.q === 'TP-11639' && p.status === undefined)).toBe(true));
    expect(lastListParams().status).toBeUndefined();
  });

  test('a text search keeps the default status filter', async () => {
    mount('/tickets?q=printer');
    await waitFor(() => expect(lastListParams().status).toBe('Open,Pending,parked'));
  });

  test('a status the person picked still applies to the number', async () => {
    mount('/tickets?q=TP-11639&status=Closed');
    await waitFor(() => expect(lastListParams().status).toBe('Closed'));
  });

  test('a ticket combined into another reads "Combined into TP-…" on its row', async () => {
    listSpy.mockResolvedValue({ data: { items: [{
      id: 119898, status: 'Closed', subject: 'Second monitor flickers', displayRef: 'TP-11639', priority: 2, origin: 'ticketpulse',
      nativeNumber: 11639, assignedTech: null, assignedTechId: null, requester: { name: 'Riley Example' }, createdAt: '2026-11-06T17:00:00Z', tags: [],
      combinedInto: { id: 119897, displayRef: 'TP-11638', kind: 'combined' },
    }], total: 1 } });
    mount('/tickets?q=TP-11639');
    const marks = await screen.findAllByTestId('combined-into', {}, { timeout: 3000 });
    expect(marks[0]).toHaveTextContent('Combined into TP-11638');
    expect(screen.getAllByRole('link', { name: 'Combined into TP-11638: open TP-11638' })[0]).toHaveAttribute('href', '/tickets/119897');
  });
});
