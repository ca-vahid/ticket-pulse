/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// QA 08-04 #9 (bulk lane): a page-scoped bulk assign that overrides completed
// AI decisions must raise ONE aggregated "why the override?" prompt and record
// the chosen reason for every overridden ticket.
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
  assignedTech: null,
  assignedTechId: null,
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

const runBulkAssign = async () => {
  mount();
  await waitFor(() => expect(listSpy).toHaveBeenCalled());
  await screen.findAllByText('Row 11'); // desktop row + mobile card both render

  fireEvent.click(screen.getByRole('checkbox', { name: 'Select all tickets on this page' }));
  fireEvent.change(await screen.findByRole('combobox', { name: 'Bulk assign' }), { target: { value: '7' } });
  fireEvent.click(await screen.findByRole('button', { name: /Confirm/ }));
  await waitFor(() => expect(assignSpy).toHaveBeenCalledTimes(2));
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  listSpy.mockResolvedValue({ data: { items: [tpRow(11), tpRow(12)], total: 2 } });
  metaSpy.mockResolvedValue({
    data: {
      workspaceId: 1,
      nativeTicketingEnabled: true,
      technicians: [{ id: 7, name: 'Terry Tech', origin: 'freshservice', isActive: true }],
      groups: [],
      categoryTree: [],
      sources: [],
      tags: [],
      actor: { role: 'admin' },
    },
  });
  statsSpy.mockResolvedValue({
    data: { all: 2, open: 2, unassigned: 2, awaiting: 0, awaitingApproval: 0, dueToday: 0, overdue: 0, resolved: 0, deleted: 0, noise: 0, byTechnician: {} },
  });
  recordOverrideReasonSpy.mockResolvedValue({});
});

afterEach(cleanup);

describe('Tickets bulk assign — aggregated override prompt (QA 08-04 #9)', () => {
  test('one aggregated prompt fires and records the reason for every overridden ticket', async () => {
    assignSpy.mockResolvedValue({ success: true, data: { aiOverride: true } });
    await runBulkAssign();

    expect(await screen.findByText('2 of these were AI-routed — why the override?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Availability' }));
    await waitFor(() => expect(recordOverrideReasonSpy).toHaveBeenCalledTimes(2));
    expect(recordOverrideReasonSpy).toHaveBeenCalledWith(11, { toTechnicianId: 7, reasonCode: 'availability' });
    expect(recordOverrideReasonSpy).toHaveBeenCalledWith(12, { toTechnicianId: 7, reasonCode: 'availability' });
  });

  test('a single overridden ticket gets the singular wording', async () => {
    assignSpy
      .mockResolvedValueOnce({ success: true, data: { aiOverride: true } })
      .mockResolvedValueOnce({ success: true, data: { aiOverride: false } });
    await runBulkAssign();

    expect(await screen.findByText('Why the override?')).toBeInTheDocument();
  });

  test('no prompt when nothing was AI-routed', async () => {
    assignSpy.mockResolvedValue({ success: true, data: { aiOverride: false } });
    await runBulkAssign();

    await waitFor(() => expect(screen.getByText(/updated \(/)).toBeInTheDocument());
    expect(screen.queryByText(/why the override\?/i)).not.toBeInTheDocument();
  });
});
