/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Mega 08-30 Phase ET3/ET4/ET5 (QA 08-27 #1) + Phase MB1/MB6 (QA 08-27 #7):
// the header "Edit" button + modal on BOTH origins (TP-born → one PATCH with
// only the changed fields; FS-born → the FsSyncConfirm flow, then fsUpdate),
// and the Merge button that is always rendered for coordinators — disabled
// WITH its reason instead of silently missing.

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
const FS_BORN = { ...BASE, origin: 'freshservice', freshserviceTicketId: '239470', displayRef: '#239470' };

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
  get: vi.fn(() => Promise.resolve({ data: NATIVE })),
  meta: vi.fn(() => Promise.resolve({ data: META })),
  update: vi.fn(() => Promise.resolve({ data: {} })),
  fsUpdate: vi.fn(() => Promise.resolve({ data: { synced: ['subject'] } })),
  requesterSearch: vi.fn(() => Promise.resolve({ data: { requesters: [{ id: 41, name: 'Nadia New', email: 'nadia@example.com', jobTitle: 'Analyst' }], directory: [] } })),
  requesterPhoto: vi.fn(() => Promise.resolve({ data: { photo: null } })),
  requesterStats: vi.fn(() => Promise.resolve({ data: { total: 3 } })),
};

vi.mock('../services/api', () => ({
  ticketsAPI: new Proxy({}, { get: (_t, prop) => apiOverrides[prop] || pending }),
  assignmentAPI: new Proxy({}, { get: () => pending }),
  agentAPI: new Proxy({}, { get: () => pending }),
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
      </Routes>
    </MemoryRouter>,
  );
}
const ready = () => { renderPage(); return screen.findByRole('region', { name: 'Ticket description' }); };
const openEdit = async () => {
  await ready();
  fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
  return screen.findByRole('dialog', { name: /edit ticket/i });
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  apiOverrides.get = vi.fn(() => Promise.resolve({ data: NATIVE }));
  apiOverrides.meta = vi.fn(() => Promise.resolve({ data: META }));
});
afterEach(() => cleanup());

describe('Edit ticket — header button + modal (Phase ET3/ET4)', () => {
  test('TP-born: Edit sits in the quick-actions bar; the modal shows requester chip, subject, description', async () => {
    const dialog = await openEdit();
    expect(within(dialog).getByTestId('requester-chip')).toHaveTextContent('Rita Requester');
    expect(within(dialog).getByLabelText('Subject')).toHaveValue('Laptop will not boot');
    expect(within(dialog).getByRole('textbox', { name: 'Description' })).toBeInTheDocument();
    expect(within(dialog).queryByTestId('edit-fs-owned-note')).not.toBeInTheDocument();
    // Nothing changed yet → Save disabled.
    expect(within(dialog).getByRole('button', { name: /save changes/i })).toBeDisabled();
  });

  test('TP-born: change requester (typeahead pick) + subject + description → ONE update with exactly those fields', async () => {
    const dialog = await openEdit();
    // Requester: clear the chip, search, pick Nadia.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear requester' }));
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Requester' }), { target: { value: 'nad' } });
    fireEvent.click(await within(dialog).findByRole('option', { name: /nadia new/i }));
    expect(within(dialog).getByTestId('requester-chip')).toHaveTextContent('Nadia New');
    fireEvent.change(within(dialog).getByLabelText('Subject'), { target: { value: '  Laptop boots to a black screen ' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Description' }), { target: { value: 'Now with detail' } });
    expect(within(dialog).getByTestId('edit-ticket-summary')).toHaveTextContent('3 changes: requester, subject, description');

    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(apiOverrides.update).toHaveBeenCalledTimes(1));
    expect(apiOverrides.update).toHaveBeenCalledWith(501, {
      requesterId: 41,
      subject: 'Laptop boots to a black screen',
      description: '<p>Now with detail</p>',
    });
    expect(apiOverrides.fsUpdate).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /edit ticket/i })).not.toBeInTheDocument());
    expect(screen.getByText('Ticket updated')).toBeInTheDocument();
  });

  test('TP-born: subject-only edit sends ONLY the subject; a server error renders inline and keeps the modal open', async () => {
    apiOverrides.update = vi.fn(() => Promise.reject({ response: { data: { message: 'Subject must be at most 500 characters' } } }));
    const dialog = await openEdit();
    fireEvent.change(within(dialog).getByLabelText('Subject'), { target: { value: 'Changed subject' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(apiOverrides.update).toHaveBeenCalledWith(501, { subject: 'Changed subject' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Subject must be at most 500 characters');
    expect(screen.getByRole('dialog', { name: /edit ticket/i })).toBeInTheDocument();
  });

  test('FS-born: Edit is offered too; Save opens the FreshService confirm listing the changes, Confirm → fsUpdate (never update)', async () => {
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: FS_BORN }));
    const dialog = await openEdit();
    expect(within(dialog).getByTestId('edit-fs-owned-note')).toHaveTextContent('FreshService owns #239470');
    fireEvent.change(within(dialog).getByLabelText('Subject'), { target: { value: 'Payment receipt — June' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Description' }), { target: { value: 'Body v2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /write to freshservice…/i }));

    const confirm = await screen.findByRole('dialog', { name: /sync change to freshservice/i });
    expect(within(confirm).getByText('Subject')).toBeInTheDocument();
    expect(within(confirm).getByText('Payment receipt — June')).toBeInTheDocument();
    expect(within(confirm).getByText('Description')).toBeInTheDocument();
    expect(within(confirm).getByText('Body v2')).toBeInTheDocument();
    // Nothing written yet.
    expect(apiOverrides.fsUpdate).not.toHaveBeenCalled();
    expect(apiOverrides.update).not.toHaveBeenCalled();

    fireEvent.click(within(confirm).getByRole('button', { name: /^write to freshservice$/i }));
    await waitFor(() => expect(apiOverrides.fsUpdate).toHaveBeenCalledWith(501, { subject: 'Payment receipt — June', description: '<p>Body v2</p>' }));
    expect(apiOverrides.update).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /edit ticket/i })).not.toBeInTheDocument());
  });

  test('FS-born: cancelling the confirm writes nothing and leaves the edit modal open (silent)', async () => {
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: FS_BORN }));
    const dialog = await openEdit();
    fireEvent.change(within(dialog).getByLabelText('Subject'), { target: { value: 'Payment receipt — June' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /write to freshservice…/i }));
    const confirm = await screen.findByRole('dialog', { name: /sync change to freshservice/i });
    fireEvent.click(within(confirm).getAllByRole('button', { name: /^cancel$/i }).at(-1)); // footer Cancel (the X carries the same label)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /sync change to freshservice/i })).not.toBeInTheDocument());
    expect(apiOverrides.fsUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /edit ticket/i })).toBeInTheDocument();
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  test('FS-born: the new-email escape hatch is off (requester must exist in FreshService)', async () => {
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: FS_BORN }));
    apiOverrides.requesterSearch = vi.fn(() => Promise.resolve({ data: { requesters: [], directory: [] } }));
    const dialog = await openEdit();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear requester' }));
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Requester' }), { target: { value: 'someone@example.com' } });
    await waitFor(() => expect(apiOverrides.requesterSearch).toHaveBeenCalled());
    expect(within(dialog).queryByText(/as a new requester/i)).not.toBeInTheDocument();
  });

  test('inline pencils are offered on FS-born tickets too (subject + description)', async () => {
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: FS_BORN }));
    await ready();
    expect(screen.getByRole('button', { name: 'Edit subject' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit description' })).toBeInTheDocument();
    // The description pencil opens the RICH editor (not a flattening textarea).
    fireEvent.click(screen.getByRole('button', { name: 'Edit description' }));
    const section = await screen.findByRole('region', { name: 'Edit description' });
    expect(within(section).getByRole('textbox', { name: 'Description' })).toBeInTheDocument();
    expect(within(section).getByText(/FreshService owns this ticket — saving writes the description there first/)).toBeInTheDocument();
  });

  test('no Edit when the workspace has native ticketing off and the ticket has no FS handle', async () => {
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: { ...FS_BORN, freshserviceTicketId: null } }));
    apiOverrides.meta = vi.fn(() => Promise.resolve({ data: { ...META, nativeTicketingEnabled: false } }));
    await ready();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
  });
});

describe('Merge button honesty (Phase MB1)', () => {
  test('TP-born Open: enabled, opens the merge dialog', async () => {
    await ready();
    const btn = screen.getByTestId('merge-button');
    expect(btn).toBeEnabled();
    expect(btn).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(btn);
    expect(await screen.findByTestId('merge-modal')).toBeInTheDocument();
  });

  test('FS-born: rendered but disabled with the "FreshService owns this conversation" reason', async () => {
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: FS_BORN }));
    await ready();
    const btn = screen.getByTestId('merge-button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAttribute('title', expect.stringMatching(/FreshService owns this ticket’s conversation — merge it in FreshService \(it can still be folded INTO a Ticket Pulse ticket/));
    fireEvent.click(btn);
    expect(screen.queryByTestId('merge-modal')).not.toBeInTheDocument();
  });

  test('TP-born Closed: disabled with the "reopen first" reason', async () => {
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: { ...NATIVE, status: 'Closed', resolvedAt: '2026-08-29T10:00:00Z', closedAt: '2026-08-29T10:00:00Z' } }));
    await ready();
    const btn = screen.getByTestId('merge-button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Only Open or Pending tickets can receive a merge — reopen this ticket first');
  });

  test('agents never see Merge at all', async () => {
    apiOverrides.meta = vi.fn(() => Promise.resolve({ data: { ...META, actor: { ...META.actor, kind: 'agent', technicianId: 7 } } }));
    await ready();
    expect(screen.queryByTestId('merge-button')).not.toBeInTheDocument();
  });
});
