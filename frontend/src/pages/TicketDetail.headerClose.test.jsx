/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

// 2 Oct 2026: a prominent Close in the header action row (not under More).
// TP-born: in-app confirm; FS-born: the FreshService write-back confirm.
// Both return to the list the ticket was opened from, filters kept.

const BASE = {
  id: 501,
  subject: 'Laptop will not boot',
  description: '<p>Screen stays black</p>',
  descriptionText: 'Screen stays black',
  status: 'Open',
  priority: 2,
  ticketType: 'Incident',
  createdAt: '2026-08-28T10:00:00Z',
  updatedAt: '2026-08-28T10:05:00Z',
  lastActivityAt: '2026-08-28T10:05:00Z',
  requesterId: 40,
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
  thread: [],
};
const NATIVE = { ...BASE, origin: 'ticketpulse', freshserviceTicketId: null, nativeNumber: 1042, displayRef: 'TP-1042' };
const FS_BORN = { ...BASE, origin: 'freshservice', freshserviceTicketId: '243555', nativeNumber: null, displayRef: '#243555' };

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
  get: vi.fn(() => Promise.resolve({ data: FS_BORN })),
  fsDelete: vi.fn(() => Promise.resolve({ data: { id: 501, status: 'Deleted', deleted: true } })),
  meta: vi.fn(() => Promise.resolve({ data: META })),
  update: vi.fn(() => Promise.resolve({ data: {} })),
  fsUpdate: vi.fn(() => Promise.resolve({ data: { synced: ['subject'] } })),
  requesterSearch: vi.fn(() => Promise.resolve({ data: { requesters: [{ id: 41, name: 'Nadia New', email: 'nadia@example.com', jobTitle: 'Analyst' }], directory: [] } })),
  requesterPhoto: vi.fn(() => Promise.resolve({ data: { photo: null } })),
  requesterStats: vi.fn(() => Promise.resolve({ data: { total: 3 } })),
  forward: vi.fn(() => Promise.resolve({ data: { sent: true } })),
  note: vi.fn(() => Promise.resolve({ data: {} })),
  setStatus: vi.fn(() => Promise.resolve({ data: {} })),
};

vi.mock('../services/api', () => ({
  ticketsAPI: new Proxy({}, { get: (_t, prop) => apiOverrides[prop] || pending }),
  assignmentAPI: new Proxy({}, { get: () => pending }),
  agentAPI: new Proxy({}, { get: () => pending }),
}));
vi.mock('../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ workspaceId: 1, currentWorkspace: { id: 1, name: 'IT' }, availableWorkspaces: [] }),
}));
const roleRef = { value: 'admin' };
vi.mock('../components/nav/navDestinations', () => ({
  useWorkspaceRole: () => roleRef.value,
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
vi.mock('../components/tickets/RequestApprovalModal', () => ({ default: () => null }));
vi.mock('../components/tickets/MergeTicketsModal', () => ({ default: () => <div data-testid="merge-modal" /> }));
vi.mock('../components/tickets/AttachmentPreviewModal', () => ({ default: () => null }));
vi.mock('../components/tickets/ImageMarkupModal', () => ({ default: () => null }));
vi.mock('../components/tickets/ApprovalTimeline', () => ({ default: () => null }));
vi.mock('../components/tickets/StagedFileChip', () => ({ default: () => null }));
vi.mock('../components/tickets/ComposerSignatureStrip', () => ({ default: () => null }));
vi.mock('../components/tickets/CcChips', () => ({ default: () => <div data-testid="cc-chips" /> }));
// Editable stand-in for the rich editor: typing updates both html + text.
vi.mock('../components/tickets/RichTextEditor', async () => {
  const { forwardRef } = await import('react');
  return {
    default: forwardRef(({ ariaLabel, onChange }, _ref) => (
      <textarea
        aria-label={ariaLabel || 'editor'}
        onChange={(e) => onChange?.({ html: `<p>${e.target.value}</p>`, text: e.target.value })}
      />
    )),
    isRichContent: () => false,
  };
});

import TicketDetail from './TicketDetail';

function renderPage(entry = '/tickets/501') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/tickets/:id" element={<TicketDetail />} />
        <Route path="/tickets" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="tickets-list" data-search={loc.search}>{loc.state?.toast?.message || ''}</div>;
}
const FROM = { pathname: '/tickets/501', state: { from: '/tickets?assignee=59&status=Pending' } };
const ready = async (entry = FROM) => {
  renderPage(entry);
  await screen.findByRole('region', { name: 'Ticket description' });
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  roleRef.value = 'admin';
  apiOverrides.get = vi.fn(() => Promise.resolve({ data: FS_BORN }));
  apiOverrides.meta = vi.fn(() => Promise.resolve({ data: META }));
  apiOverrides.setStatus = vi.fn(() => Promise.resolve({ data: {} }));
  apiOverrides.fsUpdate = vi.fn(() => Promise.resolve({ data: { synced: ['status'] } }));
});
afterEach(() => cleanup());

describe('Header Close (2 Oct 2026)', () => {
  test('sits in the action row, not behind More', async () => {
    await ready();
    const row = screen.getByTestId('ticket-actions');
    expect(within(row).getByTestId('header-close')).toHaveTextContent('Close');
  });

  test('TP-born: confirm in-app, close, back to the filtered list', async () => {
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: NATIVE }));
    await ready();
    fireEvent.click(screen.getByTestId('header-close'));
    const dialog = await screen.findByRole('dialog', { name: 'Close TP-1042?' });
    expect(apiOverrides.setStatus).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close ticket' }));
    await waitFor(() => expect(apiOverrides.setStatus).toHaveBeenCalledWith(501, 'Closed'));
    const list = await screen.findByTestId('tickets-list');
    expect(list.getAttribute('data-search')).toBe('?assignee=59&status=Pending');
    expect(list).toHaveTextContent('TP-1042 closed');
  });

  test('TP-born: Cancel leaves the ticket alone', async () => {
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: NATIVE }));
    await ready();
    fireEvent.click(screen.getByTestId('header-close'));
    const dialog = await screen.findByRole('dialog', { name: 'Close TP-1042?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Close TP-1042?' })).not.toBeInTheDocument());
    expect(apiOverrides.setStatus).not.toHaveBeenCalled();
    expect(screen.queryByTestId('tickets-list')).not.toBeInTheDocument();
  });

  test('TP-born: a refused close stays on the ticket', async () => {
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: NATIVE }));
    apiOverrides.setStatus = vi.fn(() => Promise.reject({ response: { status: 409, data: { message: 'Close the open child tickets first' } } }));
    await ready();
    fireEvent.click(screen.getByTestId('header-close'));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Close TP-1042?' })).getByRole('button', { name: 'Close ticket' }));
    await waitFor(() => expect(apiOverrides.setStatus).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('tickets-list')).not.toBeInTheDocument();
  });

  test('FS-born: FreshService write-back confirm, then back to the filtered list', async () => {
    await ready();
    fireEvent.click(screen.getByTestId('header-close'));
    const dialog = await screen.findByRole('dialog', { name: 'Sync change to FreshService' });
    expect(dialog).toHaveTextContent('Closed');
    expect(apiOverrides.fsUpdate).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Write to FreshService' }));
    await waitFor(() => expect(apiOverrides.fsUpdate).toHaveBeenCalledWith(501, { status: 'Closed' }));
    const list = await screen.findByTestId('tickets-list');
    expect(list.getAttribute('data-search')).toBe('?assignee=59&status=Pending');
    expect(list).toHaveTextContent('#243555 closed');
  });

  test('FS-born: a FreshService refusal stays on the ticket', async () => {
    apiOverrides.fsUpdate = vi.fn(() => Promise.reject({ response: { data: { message: 'FreshService refused' } } }));
    await ready();
    fireEvent.click(screen.getByTestId('header-close'));
    const dialog = await screen.findByRole('dialog', { name: 'Sync change to FreshService' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Write to FreshService' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('FreshService refused');
    expect(screen.queryByTestId('tickets-list')).not.toBeInTheDocument();
  });

  test('shown for Pending and Resolved, hidden once Closed or Deleted', async () => {
    for (const [status, shown] of [['Pending', true], ['Resolved', true], ['Closed', false], ['Deleted', false]]) {
      apiOverrides.get = vi.fn(() => Promise.resolve({ data: { ...FS_BORN, status } }));
      await ready();
      if (shown) expect(screen.getByTestId('header-close')).toBeInTheDocument();
      else expect(screen.queryByTestId('header-close')).not.toBeInTheDocument();
      cleanup();
    }
  });

  test('hidden for readonly', async () => {
    apiOverrides.meta = vi.fn(() => Promise.resolve({ data: { ...META, actor: { ...META.actor, workspaceRole: 'readonly' } } }));
    await ready();
    expect(screen.queryByTestId('header-close')).not.toBeInTheDocument();
  });
});
