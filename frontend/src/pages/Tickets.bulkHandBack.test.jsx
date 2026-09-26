/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// QA 09-25 item 3 (bulk lane): releasing selected tickets asks ONE hand-back
// reason for all, and every per-ticket unassign carries it.
const { listSpy, metaSpy, statsSpy, assignSpy, recordOverrideReasonSpy } = vi.hoisted(() => ({
  listSpy: vi.fn(),
  metaSpy: vi.fn(),
  statsSpy: vi.fn(),
  assignSpy: vi.fn(),
  recordOverrideReasonSpy: vi.fn(),
}));

vi.mock('../services/api', () => ({
  ticketsAPI: new Proxy(
    { list: listSpy, meta: metaSpy, stats: statsSpy, assign: assignSpy },
    { get: (target, key) => target[key] || (() => new Promise(() => {})) },
  ),
  assignmentAPI: { recordOverrideReason: recordOverrideReasonSpy },
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

const tpRow = (id) => ({
  id,
  status: 'Open',
  subject: `Row ${id}`,
  displayRef: `TP-${id}`,
  priority: 2,
  origin: 'ticketpulse',
  nativeNumber: id,
  freshserviceTicketId: null,
  assignedTech: { id: 7, name: 'Terry Tech' },
  assignedTechId: 7,
  requester: { name: 'Rita' },
  tags: [],
  ai: null,
  createdAt: '2026-08-01T10:00:00Z',
  updatedAt: '2026-08-01T10:00:00Z',
  lastActivityAt: '2026-08-01T10:00:00Z',
});

function mount() {
  return render(<Tickets />, {
    wrapper: ({ children }) => <MemoryRouter initialEntries={['/tickets']}>{children}</MemoryRouter>,
  });
}


beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  listSpy.mockResolvedValue({ data: { items: [tpRow(11), tpRow(12)], total: 2 } });
  metaSpy.mockResolvedValue({
    data: {
      workspaceId: 1,
      nativeTicketingEnabled: true,
      technicians: [
        { id: 7, name: 'Terry Tech', origin: 'freshservice', isActive: true },
        { id: 40, name: 'Juan Gonzalez', origin: 'freshservice', assignableOnly: true },
      ],
      groups: [],
      categoryTree: [],
      sources: [],
      tags: [],
      actor: { role: 'admin', technicianId: 2 },
    },
  });
  statsSpy.mockResolvedValue({
    data: { all: 2, open: 2, unassigned: 0, awaiting: 0, awaitingApproval: 0, dueToday: 0, overdue: 0, resolved: 0, deleted: 0, noise: 0, byTechnician: {} },
  });
  assignSpy.mockResolvedValue({ success: true, data: {} });
});

afterEach(cleanup);

const startRelease = async () => {
  mount();
  await waitFor(() => expect(listSpy).toHaveBeenCalled());
  await screen.findAllByText('Row 11');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select all tickets on this page' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Bulk assign' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: /Unassigned/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Confirm/ }));
  return screen.findByTestId('hand-back-dialog');
};

describe('Tickets bulk release — one hand-back reason (QA 09-25 item 3)', () => {
  test('Confirm asks why first, then every unassign carries the reason', async () => {
    await startRelease();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /release 2 tickets/i })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Location issue/));
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'Needs on-site' } });
    fireEvent.click(screen.getByRole('button', { name: 'Release' }));
    await waitFor(() => expect(assignSpy).toHaveBeenCalledTimes(2));
    expect(assignSpy).toHaveBeenCalledWith(11, null, { handBack: { code: 'location', note: 'Needs on-site' } });
    expect(assignSpy).toHaveBeenCalledWith(12, null, { handBack: { code: 'location', note: 'Needs on-site' } });
  });

  test('a coordinator may skip the reason', async () => {
    await startRelease();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(assignSpy).toHaveBeenCalledTimes(2));
    expect(assignSpy).toHaveBeenCalledWith(11, null, { handBack: { code: 'skipped', note: null } });
  });

  test('assignable-only people are offered under "Other teams" in the bulk picker', async () => {
    mount();
    await screen.findAllByText('Row 11');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all tickets on this page' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Bulk assign' }));
    expect(await screen.findByText('Other teams')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Juan Gonzalez' })).toBeInTheDocument();
  });
});
