/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// QA 08-05 #3 — Cc visibility on the ticket page: the description card shows
// a quiet To/Cc line from the ticket row, thread entries show per-message Cc
// from rawPayload, and opening the REPLY composer seeds Cc from the ticket
// (reply-cc preferred) — initial value only, never for internal notes.

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
  toEmails: ['it@bgc.ca'],
  ccEmails: ['cc-one@example.com', 'cc-two@example.com', 'cc-three@example.com'],
  replyCcEmails: ['reply-cc@example.com'],
  fwdEmails: [],
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
      rawPayload: {
        to_emails: ['it@bgc.ca'],
        cc_emails: ['cc-one@example.com', 'cc-two@example.com', 'cc-three@example.com'],
      },
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
      bodyText: 'internal context only',
      content: 'internal context only',
      occurredAt: '2026-08-05T10:02:00Z',
    },
  ],
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
  // Phase D signature strip fetch (reply mode) — keep it forever-pending here.
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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/tickets/501']}>
      <Routes>
        <Route path="/tickets/:id" element={<TicketDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TicketDetail Cc visibility', () => {
  beforeEach(() => {
    localStorage.clear();
    apiOverrides.get.mockClear();
  });
  afterEach(() => cleanup());

  test('description card shows the To/Cc line with expand', async () => {
    renderPage();

    const description = await screen.findByRole('region', { name: 'Ticket description' });
    expect(within(description).getByText('To:')).toBeInTheDocument();
    expect(within(description).getByText(/it@bgc\.ca/)).toBeInTheDocument();
    expect(within(description).getByText('Cc:')).toBeInTheDocument();
    expect(within(description).getByText(/cc-one@example\.com, cc-two@example\.com/)).toBeInTheDocument();
    // Third cc hidden behind the expand control.
    expect(within(description).queryByText(/cc-three@example\.com/)).not.toBeInTheDocument();

    fireEvent.click(within(description).getByRole('button', { name: '+1 more' }));
    expect(within(description).getByText(/cc-three@example\.com/)).toBeInTheDocument();
    expect(within(description).getByRole('button', { name: 'show less' })).toBeInTheDocument();
  });

  test('thread entries show per-message Cc from rawPayload; notes show none', async () => {
    renderPage();

    const requesterMessage = (await screen.findByText('Please fix the printer')).closest('li');
    expect(within(requesterMessage).getByText('Cc:')).toBeInTheDocument();
    expect(within(requesterMessage).getByText(/cc-one@example\.com, cc-two@example\.com/)).toBeInTheDocument();
    // Incoming replies keep their To out of the line (only forwards show To).
    expect(within(requesterMessage).queryByText('To:')).not.toBeInTheDocument();

    const note = screen.getByText('internal context only').closest('li');
    expect(within(note).queryByText('Cc:')).not.toBeInTheDocument();
  });

  test('opening the reply composer seeds Cc from replyCcEmails (initial value only)', async () => {
    renderPage();

    await screen.findByRole('region', { name: 'Ticket description' });
    // Composer defaults to internal note: no Cc field at all.
    expect(screen.queryByRole('combobox', { name: 'Cc recipients' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /reply\s?to requester/i }));
    // Seeded from replyCcEmails (preferred over ccEmails).
    expect(await screen.findByRole('button', { name: 'Remove reply-cc@example.com from Cc' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove cc-one@example.com from Cc' })).not.toBeInTheDocument();

    // User clears the seed — switching modes must NOT re-seed (edits are authoritative).
    fireEvent.click(screen.getByRole('button', { name: 'Remove reply-cc@example.com from Cc' }));
    fireEvent.click(screen.getByRole('button', { name: /internal note/i }));
    fireEvent.click(screen.getByRole('button', { name: /reply\s?to requester/i }));
    expect(screen.queryByRole('button', { name: 'Remove reply-cc@example.com from Cc' })).not.toBeInTheDocument();
  });
});
