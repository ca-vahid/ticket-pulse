/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// FR 08-07 #8 — inline internal-note editing: the pencil shows for the note's
// author or an admin (never on replies or system notes), swaps the body for
// the small rich-text editor, PATCHes on Save, and an "edited" chip renders
// beside the timestamp once a note carries editedAt/editedBy.

const TICKET = {
  id: 501,
  origin: 'freshservice',
  freshserviceTicketId: '231900',
  displayRef: '#231900',
  subject: 'Printer on 3rd floor jammed',
  description: '<p>It is jammed again</p>',
  descriptionText: 'It is jammed again',
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
  tags: [],
  activities: [],
  approvals: [],
  attachments: [],
  mergedInto: null,
  stateChip: null,
  thread: [
    {
      id: 9001,
      eventType: 'reply',
      authorType: 'requester',
      incoming: true,
      isPrivate: false,
      visibility: 'public',
      actorName: 'Rita Requester',
      actorEmail: 'rita@example.com',
      bodyText: 'Please fix the printer',
      content: 'Please fix the printer',
      occurredAt: '2026-08-05T10:01:00Z',
    },
    {
      id: 9002,
      eventType: 'note',
      authorType: 'agent',
      incoming: false,
      isPrivate: true,
      visibility: 'private',
      actorName: 'Terry Tech',
      actorEmail: 'terry@example.com',
      bodyText: 'my own note',
      content: 'my own note',
      occurredAt: '2026-08-05T10:02:00Z',
    },
    {
      id: 9003,
      eventType: 'note',
      authorType: 'agent',
      incoming: false,
      isPrivate: true,
      visibility: 'private',
      actorName: 'Olga Other',
      actorEmail: 'olga@example.com',
      bodyText: 'someone elses note',
      content: 'someone elses note',
      occurredAt: '2026-08-05T10:03:00Z',
      editedAt: '2026-08-05T12:00:00Z',
      editedBy: 'olga@example.com',
    },
    {
      id: 9004,
      eventType: 'note',
      authorType: 'system',
      incoming: false,
      isPrivate: true,
      visibility: 'private',
      actorName: 'Ticket Pulse',
      actorEmail: null,
      bodyText: 'system audit note',
      content: 'system audit note',
      occurredAt: '2026-08-05T10:04:00Z',
    },
  ],
};

const metaFor = (actor) => ({
  nativeTicketingEnabled: true,
  technicians: [],
  categoryTree: [],
  categoryGroupLinks: [],
  groups: [],
  tags: [],
  approvalCategories: [],
  statuses: [],
  actor,
});
let currentMeta = metaFor({ kind: 'member', email: 'terry@example.com', workspaceRole: 'member', technicianId: 7 });

const pending = () => new Promise(() => {});
const apiOverrides = {
  get: vi.fn(() => Promise.resolve({ data: TICKET })),
  meta: vi.fn(() => Promise.resolve({ data: currentMeta })),
  updateNote: vi.fn(() => Promise.resolve({ data: { entry: {} } })),
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
    default: forwardRef(({ ariaLabel, value, onChange }, _ref) => (
      <textarea
        aria-label={ariaLabel || 'editor'}
        defaultValue={value}
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

const entryLi = async (text) => (await screen.findByText(text)).closest('li.flex');

describe('TicketDetail note editing', () => {
  beforeEach(() => {
    localStorage.clear();
    apiOverrides.get.mockClear();
    apiOverrides.updateNote.mockClear();
    currentMeta = metaFor({ kind: 'member', email: 'terry@example.com', workspaceRole: 'member', technicianId: 7 });
  });
  afterEach(() => cleanup());

  test('pencil shows only on the actor\'s own notes for non-admins; never on replies or system notes', async () => {
    renderPage();

    const ownNote = await entryLi('my own note');
    expect(within(ownNote).getByRole('button', { name: 'Edit note' })).toBeInTheDocument();

    const foreignNote = await entryLi('someone elses note');
    expect(within(foreignNote).queryByRole('button', { name: 'Edit note' })).not.toBeInTheDocument();

    const reply = await entryLi('Please fix the printer');
    expect(within(reply).queryByRole('button', { name: 'Edit note' })).not.toBeInTheDocument();

    const systemNote = await entryLi('system audit note');
    expect(within(systemNote).queryByRole('button', { name: 'Edit note' })).not.toBeInTheDocument();
  });

  test('admins can edit any non-system note', async () => {
    currentMeta = metaFor({ kind: 'admin', email: 'ada@example.com', workspaceRole: 'admin', technicianId: null });
    renderPage();

    const foreignNote = await entryLi('someone elses note');
    expect(within(foreignNote).getByRole('button', { name: 'Edit note' })).toBeInTheDocument();

    const systemNote = await entryLi('system audit note');
    expect(within(systemNote).queryByRole('button', { name: 'Edit note' })).not.toBeInTheDocument();
  });

  test('edit flow: pencil opens the inline editor, Save PATCHes and applies the change optimistically', async () => {
    // After the PATCH the (silent) refetch returns the server truth — serve
    // the edited thread once updateNote has been called, like the real API.
    const editedTicket = {
      ...TICKET,
      thread: TICKET.thread.map((e) => (e.id === 9002
        ? { ...e, bodyHtml: '<p>my improved note</p>', bodyText: 'my improved note', content: 'my improved note', editedAt: '2026-08-08T09:00:00Z', editedBy: 'terry@example.com' }
        : e)),
    };
    apiOverrides.get.mockImplementation(() => Promise.resolve({
      data: apiOverrides.updateNote.mock.calls.length ? editedTicket : TICKET,
    }));
    renderPage();

    const ownNote = await entryLi('my own note');
    fireEvent.click(within(ownNote).getByRole('button', { name: 'Edit note' }));

    const editor = within(ownNote).getByRole('textbox', { name: 'Edit note body' });
    fireEvent.change(editor, { target: { value: 'my improved note' } });
    fireEvent.click(within(ownNote).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(apiOverrides.updateNote).toHaveBeenCalledWith(501, 9002, {
      bodyHtml: '<p>my improved note</p>',
      bodyText: 'my improved note',
    }));
    // Optimistic swap: new body renders + the edited chip appears without a refetch roundtrip.
    expect(await screen.findByText('my improved note')).toBeInTheDocument();
    const updated = await entryLi('my improved note');
    expect(within(updated).getByText(/^edited/)).toBeInTheDocument();
  });

  test('Cancel closes the editor without saving', async () => {
    renderPage();

    const ownNote = await entryLi('my own note');
    fireEvent.click(within(ownNote).getByRole('button', { name: 'Edit note' }));
    fireEvent.click(within(ownNote).getByRole('button', { name: 'Cancel' }));

    expect(within(ownNote).queryByRole('textbox', { name: 'Edit note body' })).not.toBeInTheDocument();
    expect(apiOverrides.updateNote).not.toHaveBeenCalled();
    expect(within(ownNote).getByText('my own note')).toBeInTheDocument();
  });

  test('an already-edited note renders the "edited" chip with the editor + full time in the title', async () => {
    renderPage();

    const editedNote = await entryLi('someone elses note');
    const chip = within(editedNote).getByText(/^edited/);
    expect(chip).toBeInTheDocument();
    expect(chip.title).toContain('olga@example.com');
    expect(chip.title).toContain(new Date('2026-08-05T12:00:00Z').toLocaleString());
  });
});
