/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// QA 10-09 item 6 — "Allow regular users to delete their own notes": the
// Delete control on a thread note shows for its author or an admin, on Ticket
// Pulse tickets only, and never on replies or system notes — the same rule
// the server enforces.

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

const TP_TICKET = { ...TICKET, origin: 'ticketpulse', freshserviceTicketId: null, nativeNumber: 1042, displayRef: 'TP-1042' };
let currentTicket = TP_TICKET;

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
  get: vi.fn(() => Promise.resolve({ data: currentTicket })),
  meta: vi.fn(() => Promise.resolve({ data: currentMeta })),
  updateNote: vi.fn(() => Promise.resolve({ data: { entry: {} } })),
  deleteNote: vi.fn(() => Promise.resolve({ data: { deleted: true } })),
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

const member = (email, extra = {}) => metaFor({ kind: 'member', email, workspaceRole: 'member', technicianId: 7, ...extra });

describe('TicketDetail note deletion', () => {
  beforeEach(() => {
    localStorage.clear();
    apiOverrides.get.mockClear();
    apiOverrides.deleteNote.mockClear();
    currentTicket = TP_TICKET;
    currentMeta = member('terry@example.com');
  });
  afterEach(() => cleanup());

  test('a regular member sees Delete on their own note only', async () => {
    renderPage();

    const ownNote = await entryLi('my own note');
    expect(within(ownNote).getByRole('button', { name: 'Delete note' })).toBeInTheDocument();

    const foreignNote = await entryLi('someone elses note');
    expect(within(foreignNote).queryByRole('button', { name: 'Delete note' })).not.toBeInTheDocument();

    const reply = await entryLi('Please fix the printer');
    expect(within(reply).queryByRole('button', { name: 'Delete note' })).not.toBeInTheDocument();

    const systemNote = await entryLi('system audit note');
    expect(within(systemNote).queryByRole('button', { name: 'Delete note' })).not.toBeInTheDocument();
  });

  test('the author deletes their own note after confirming', async () => {
    renderPage();
    const ownNote = await entryLi('my own note');
    fireEvent.click(within(ownNote).getByRole('button', { name: 'Delete note' }));
    expect(apiOverrides.deleteNote).not.toHaveBeenCalled();
    fireEvent.click(within(ownNote).getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(apiOverrides.deleteNote).toHaveBeenCalledWith(501, 9002));
  });

  test('an admin sees Delete on every note that is not a system note', async () => {
    currentMeta = metaFor({ kind: 'admin', email: 'ada@example.com', workspaceRole: 'admin', technicianId: null });
    renderPage();

    expect(within(await entryLi('my own note')).getByRole('button', { name: 'Delete note' })).toBeInTheDocument();
    expect(within(await entryLi('someone elses note')).getByRole('button', { name: 'Delete note' })).toBeInTheDocument();
    expect(within(await entryLi('system audit note')).queryByRole('button', { name: 'Delete note' })).not.toBeInTheDocument();
  });

  test('the read-only role sees no Delete, even on a note carrying its e-mail', async () => {
    currentMeta = member('terry@example.com', { workspaceRole: 'readonly' });
    renderPage();
    const ownNote = await entryLi('my own note');
    expect(within(ownNote).queryByRole('button', { name: 'Delete note' })).not.toBeInTheDocument();
  });

  test('FreshService tickets show no Delete to anyone', async () => {
    currentTicket = TICKET;
    renderPage();
    expect(within(await entryLi('my own note')).queryByRole('button', { name: 'Delete note' })).not.toBeInTheDocument();
    cleanup();

    currentMeta = metaFor({ kind: 'admin', email: 'ada@example.com', workspaceRole: 'admin', technicianId: null });
    renderPage();
    expect(within(await entryLi('my own note')).queryByRole('button', { name: 'Delete note' })).not.toBeInTheDocument();
  });
});
