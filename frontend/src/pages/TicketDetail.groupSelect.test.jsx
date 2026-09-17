/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// FR 08-07 #2 — the sidebar Group select speaks BOTH group kinds via
// TicketCreate's composite fs:/int: scheme: internal (TP-native) groups no
// longer render as "No group", options come grouped by origin, and onChange
// sends {internalGroupId, groupId:null} / {groupId, internalGroupId:null}.

const TICKET = {
  id: 501,
  origin: 'ticketpulse',
  nativeNumber: 1076,
  displayRef: 'TP-1076',
  subject: 'New AP project intake',
  description: '<p>Set up the books</p>',
  descriptionText: 'Set up the books',
  status: 'Open',
  priority: 2,
  ticketType: 'Incident',
  createdAt: '2026-08-07T10:00:00Z',
  updatedAt: '2026-08-07T10:05:00Z',
  lastActivityAt: '2026-08-07T10:05:00Z',
  requester: { id: 40, name: 'Rita Requester', email: 'rita@example.com' },
  assignedTech: null,
  internalCategory: null,
  internalSubcategory: null,
  groupId: null,
  internalGroupId: 3458,
  internalGroup: { id: 3458, name: 'Project Accounting', origin: 'local' },
  tags: [],
  activities: [],
  approvals: [],
  attachments: [],
  mergedInto: null,
  stateChip: null,
  thread: [],
};

const META = {
  nativeTicketingEnabled: true,
  technicians: [],
  categoryTree: [],
  categoryGroupLinks: [],
  groups: [
    { id: 3458, freshserviceId: null, name: 'Project Accounting', origin: 'local' },
    { id: 3459, freshserviceId: null, name: 'AR Desk', origin: 'local' },
    { id: 7, freshserviceId: '1000210021', name: 'IT Operations', origin: 'freshservice' },
  ],
  tags: [],
  approvalCategories: [],
  statuses: [],
  actor: { kind: 'admin', email: 'ada@example.com', workspaceRole: 'admin', technicianId: null },
};

let currentTicket = TICKET;

const pending = () => new Promise(() => {});
const apiOverrides = {
  get: vi.fn(() => Promise.resolve({ data: currentTicket })),
  meta: vi.fn(() => Promise.resolve({ data: META })),
  update: vi.fn(() => Promise.resolve({ data: {} })),
};

vi.mock('../services/api', () => ({
  ticketsAPI: new Proxy({}, { get: (_t, prop) => apiOverrides[prop] || pending }),
  assignmentAPI: new Proxy({}, { get: () => pending }),
}));
vi.mock('../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ workspaceId: 1, currentWorkspace: { id: 1, name: 'IT' }, availableWorkspaces: [] }),
}));
vi.mock('../components/nav/navDestinations', () => ({
  useWorkspaceRole: () => ({ role: 'admin', canManage: true, canReview: true }),
  NAV_DESTINATIONS: [],
}));
vi.mock('../hooks/useSSE', () => ({ useSSE: vi.fn() }));
vi.mock('../hooks/useTicketPresence', () => ({
  useTicketPresence: () => ({ viewers: [], onPresence: vi.fn() }),
}));
vi.mock('../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ activeTypes: [], types: [], typeByName: () => null }),
}));
vi.mock('../components/AppHeader', () => ({ default: () => <div>AppHeader</div> }));
vi.mock('../components/nav/MobileTabBar', () => ({ default: () => null }));
vi.mock('../components/tickets/ThreadSummaryCard', () => ({ default: () => null }));
vi.mock('../components/tickets/ProposedReplyCard', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketFamilyCard', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketAiTab', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketTasksTab', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketTagEditor', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketOpsCards', () => ({
  CustomFieldsCard: () => null,
  MacroMenu: () => null,
  TicketLinksCard: () => null,
}));
vi.mock('../components/tickets/AssigneePicker', () => ({ default: () => null }));
vi.mock('../components/tickets/DueDateEditor', () => ({ default: () => null }));
vi.mock('../components/tickets/MobileAssignSheet', () => ({ default: () => null }));
vi.mock('../components/tickets/AiAssignModal', () => ({ default: () => null }));
vi.mock('../components/tickets/FsSyncConfirm', () => ({ default: () => null }));
vi.mock('../components/tickets/RequestApprovalModal', () => ({ default: () => null }));
vi.mock('../components/tickets/MergeTicketsModal', () => ({ default: () => null }));
vi.mock('../components/tickets/AttachmentPreviewModal', () => ({ default: () => null }));
vi.mock('../components/tickets/ImageMarkupModal', () => ({ default: () => null }));
vi.mock('../components/tickets/ApprovalTimeline', () => ({ default: () => null }));
vi.mock('../components/tickets/StagedFileChip', () => ({ default: () => null }));
vi.mock('../components/tickets/RichTextEditor', async () => {
  const { forwardRef } = await import('react');
  return {
    default: forwardRef((_props, _ref) => <textarea aria-label="editor" />),
    isRichContent: () => false,
  };
});

import TicketDetail from './TicketDetail';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/tickets/501']}>
      <Routes>
        <Route path="/tickets/:id" element={<TicketDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TicketDetail group select (fs:/int: composite)', () => {
  beforeEach(() => {
    localStorage.clear();
    currentTicket = TICKET;
    apiOverrides.get.mockClear();
    apiOverrides.update.mockClear();
  });
  afterEach(() => cleanup());

  // 16 Sep 2026: the field is a FancySelect (animated menu) — the trigger is a
  // combobox carrying data-value; options live in a portal listbox once open.
  const openMenu = (select) => { fireEvent.click(select); return screen.getByRole('listbox', { name: 'Group' }); };

  test('a ticket in an internal group shows it selected (was "No group")', async () => {
    renderPage();
    const select = await screen.findByRole('combobox', { name: 'Group' });
    expect(select).toHaveAttribute('data-value', 'int:3458');
    expect(select).toHaveTextContent('Project Accounting');
    const list = openMenu(select);
    expect(within(list).getByRole('option', { name: 'Project Accounting' })).toHaveAttribute('aria-selected', 'true');
  });

  test('options come grouped by origin: Internal groups + FreshService groups', async () => {
    renderPage();
    const select = await screen.findByRole('combobox', { name: 'Group' });
    const list = openMenu(select);
    const headings = Array.from(list.querySelectorAll('[role="presentation"]')).map((h) => h.textContent);
    expect(headings).toEqual(['Internal groups', 'FreshService groups']);
    expect(within(list).getByRole('option', { name: 'IT Operations' })).toBeInTheDocument();
    expect(within(list).getByRole('option', { name: 'AR Desk' })).toBeInTheDocument();
  });

  test('choosing an FS group sends {groupId, internalGroupId: null}', async () => {
    renderPage();
    const select = await screen.findByRole('combobox', { name: 'Group' });
    fireEvent.click(within(openMenu(select)).getByRole('option', { name: 'IT Operations' }));
    await waitFor(() => expect(apiOverrides.update).toHaveBeenCalledWith(501, {
      groupId: 1000210021,
      internalGroupId: null,
    }));
  });

  test('choosing an internal group sends {internalGroupId, groupId: null}', async () => {
    currentTicket = { ...TICKET, internalGroupId: null, internalGroup: null, groupId: '1000210021' };
    renderPage();
    const select = await screen.findByRole('combobox', { name: 'Group' });
    expect(select).toHaveAttribute('data-value', 'fs:1000210021');
    fireEvent.click(within(openMenu(select)).getByRole('option', { name: 'AR Desk' }));
    await waitFor(() => expect(apiOverrides.update).toHaveBeenCalledWith(501, {
      internalGroupId: 3459,
      groupId: null,
    }));
  });

  test('"No group" clears both fields', async () => {
    renderPage();
    const select = await screen.findByRole('combobox', { name: 'Group' });
    fireEvent.click(within(openMenu(select)).getByRole('option', { name: 'No group' }));
    await waitFor(() => expect(apiOverrides.update).toHaveBeenCalledWith(501, {
      groupId: null,
      internalGroupId: null,
    }));
  });

  test('FS-born tickets: the group field is read-only and shows the FreshService group (origin rule keeps internal groups out of the list)', async () => {
    currentTicket = {
      ...TICKET,
      origin: 'freshservice',
      freshserviceTicketId: '231900',
      displayRef: '#231900',
      internalGroupId: null,
      internalGroup: null,
      groupId: '1000210021',
    };
    renderPage();
    const select = await screen.findByRole('combobox', { name: 'Group' });
    expect(select).toBeDisabled();
    expect(select).toHaveAttribute('data-value', 'fs:1000210021');
    expect(select).toHaveTextContent('IT Operations');
    // Disabled → the menu never opens (no way to reach internal groups).
    fireEvent.click(select);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
