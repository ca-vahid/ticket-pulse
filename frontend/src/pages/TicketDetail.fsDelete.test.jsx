/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

// 2 Oct 2026: "Delete in FreshService…" in the More menu — FS-born tickets
// only, reviewer/admin only; an in-app confirm, then back to the list.

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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/tickets/501']}>
      <Routes>
        <Route path="/tickets/:id" element={<TicketDetail />} />
        <Route path="/tickets" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="tickets-list">{loc.state?.toast?.message || ''}</div>;
}
const openMore = async () => {
  renderPage();
  await screen.findByRole('region', { name: 'Ticket description' });
  fireEvent.click(screen.getByTestId('more-actions'));
  return screen.findByTestId('more-actions-menu');
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  roleRef.value = 'admin';
  apiOverrides.get = vi.fn(() => Promise.resolve({ data: FS_BORN }));
  apiOverrides.meta = vi.fn(() => Promise.resolve({ data: META }));
  apiOverrides.fsDelete = vi.fn(() => Promise.resolve({ data: { id: 501, status: 'Deleted', deleted: true } }));
});
afterEach(() => cleanup());

describe('Delete in FreshService (2 Oct 2026)', () => {
  test('FS-born + admin: the More menu offers it; confirming deletes and returns to the list with a toast', async () => {
    const menu = await openMore();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Delete in FreshService/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete in FreshService?' });
    expect(dialog).toHaveTextContent('#243555');
    expect(dialog).toHaveTextContent(/FreshService.s trash/);
    expect(apiOverrides.fsDelete).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete in FreshService' }));
    await waitFor(() => expect(apiOverrides.fsDelete).toHaveBeenCalledWith(501));
    expect(await screen.findByTestId('tickets-list')).toHaveTextContent('FreshService #243555 deleted in FreshService');
  });

  test('Cancel closes the dialog without calling the API', async () => {
    const menu = await openMore();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Delete in FreshService/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete in FreshService?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete in FreshService?' })).not.toBeInTheDocument());
    expect(apiOverrides.fsDelete).not.toHaveBeenCalled();
  });

  test('a FreshService refusal keeps the dialog open with the reason and stays on the ticket', async () => {
    apiOverrides.fsDelete = vi.fn(() => Promise.reject({ response: { data: { message: 'FreshService refused the delete — forbidden. Nothing was changed in Ticket Pulse.' } } }));
    const menu = await openMore();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Delete in FreshService/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete in FreshService?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete in FreshService' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/FreshService refused the delete/);
    expect(screen.queryByTestId('tickets-list')).not.toBeInTheDocument();
  });

  test('a reviewer sees it too', async () => {
    roleRef.value = 'reviewer';
    const menu = await openMore();
    expect(within(menu).getByTestId('fs-delete-item')).toBeInTheDocument();
  });

  test('hidden for a member without reviewer/admin access', async () => {
    roleRef.value = 'viewer';
    apiOverrides.meta = vi.fn(() => Promise.resolve({ data: { ...META, actor: { ...META.actor, kind: 'member', workspaceRole: 'viewer' } } }));
    const menu = await openMore();
    expect(within(menu).queryByTestId('fs-delete-item')).not.toBeInTheDocument();
  });

  test('hidden for readonly', async () => {
    roleRef.value = 'readonly';
    const menu = await openMore();
    expect(within(menu).queryByTestId('fs-delete-item')).not.toBeInTheDocument();
  });

  test('hidden on TP-born tickets (they keep their own Delete)', async () => {
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: NATIVE }));
    const menu = await openMore();
    expect(within(menu).queryByTestId('fs-delete-item')).not.toBeInTheDocument();
  });

  test('hidden once the ticket is already Deleted', async () => {
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: { ...FS_BORN, status: 'Deleted' } }));
    const menu = await openMore();
    expect(within(menu).queryByTestId('fs-delete-item')).not.toBeInTheDocument();
  });
});
