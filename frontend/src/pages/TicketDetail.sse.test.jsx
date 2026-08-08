/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Live detail contract (FR 08-07 #13 — instant status sync): TicketDetail
// subscribes to ticket-change over SSE and refetches the OPEN ticket when an
// event for its id arrives (coalesced, silent, reconcile:false); events for
// other tickets are ignored.
const { useSSESpy } = vi.hoisted(() => ({ useSSESpy: vi.fn() }));

const TICKET = {
  id: 501,
  origin: 'freshservice',
  freshserviceTicketId: 224183,
  displayRef: 'INC-224183',
  subject: 'Printer on fire',
  description: '<p>It burns</p>',
  descriptionText: 'It burns',
  status: 'Open',
  priority: 2,
  ticketType: 'Incident',
  createdAt: '2026-08-05T10:00:00Z',
  updatedAt: '2026-08-05T10:05:00Z',
  lastActivityAt: '2026-08-05T10:05:00Z',
  requester: { id: 40, name: 'Rita Requester', email: 'rita@example.com' },
  assignedTech: null,
  internalCategory: null,
  internalSubcategory: null,
  toEmails: [],
  ccEmails: [],
  replyCcEmails: [],
  fwdEmails: [],
  tags: [],
  activities: [],
  approvals: [],
  attachments: [],
  mergedInto: null,
  stateChip: null,
  customFields: {},
  pinnedCards: [],
  thread: [],
};

const META = {
  nativeTicketingEnabled: true,
  technicians: [],
  categoryTree: [],
  categoryGroupLinks: [],
  groups: [],
  tags: [],
  approvalCategories: [],
  statuses: [],
  actor: { kind: 'admin', email: 'qa@example.com', workspaceRole: 'admin', technicianId: null },
};

const pending = () => new Promise(() => {});
const apiOverrides = {
  get: vi.fn(() => Promise.resolve({ data: TICKET })),
  meta: vi.fn(() => Promise.resolve({ data: META })),
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
vi.mock('../hooks/useSSE', () => ({ useSSE: useSSESpy }));
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
    default: forwardRef(({ ariaLabel }, _ref) => <textarea aria-label={ariaLabel || 'editor'} />),
    isRichContent: () => false,
  };
});

import TicketDetail from './TicketDetail';

const lastSSEOptions = () => useSSESpy.mock.calls.at(-1)[0];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/tickets/501']}>
      <Routes>
        <Route path="/tickets/:id" element={<TicketDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  apiOverrides.get.mockImplementation(() => Promise.resolve({ data: TICKET }));
  apiOverrides.meta.mockImplementation(() => Promise.resolve({ data: META }));
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(() => Promise.resolve()) }, configurable: true });
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

describe('TicketDetail — live refresh on matching ticket-change (FR 08-07 #13)', () => {
  test('refetches the open ticket (silent, no reconcile) when a sync event for its id arrives', async () => {
    renderPage();
    await screen.findAllByText(/Printer on fire/);
    await waitFor(() => expect(apiOverrides.get).toHaveBeenCalledWith(501, { reconcile: true }));
    const { onTicketChange } = lastSSEOptions();
    expect(typeof onTicketChange).toBe('function');
    apiOverrides.get.mockClear();
    apiOverrides.get.mockImplementation(() => Promise.resolve({ data: { ...TICKET, status: 'Resolved' } }));

    act(() => onTicketChange({
      action: 'sync',
      workspaceId: 1,
      ticketId: 501,
      origin: 'freshservice',
      status: 'Resolved',
      assignedTechId: null,
      updatedAt: '2026-08-08T12:00:00Z',
    }));

    // Coalesced 600ms debounce, then a silent refetch with reconcile skipped.
    await waitFor(() => expect(apiOverrides.get).toHaveBeenCalledWith(501, { reconcile: false }), { timeout: 2000 });
  });

  test('ignores sync events for other tickets', async () => {
    renderPage();
    await screen.findAllByText(/Printer on fire/);
    const { onTicketChange } = lastSSEOptions();
    apiOverrides.get.mockClear();

    act(() => onTicketChange({ action: 'sync', workspaceId: 1, ticketId: 999, status: 'Resolved' }));

    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(apiOverrides.get).not.toHaveBeenCalled();
  });
});
