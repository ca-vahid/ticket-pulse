/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Custom-fields activation Phase 1 — TicketDetail side:
//  - thread entries with rawPayload.kind === 'field_card' dispatch to the
//    dedicated FieldCardNote (structured discriminator, timeline position kept)
//  - approval events prefer rawPayload.kind === 'approval_event' with the body
//    regex kept as the legacy fallback
//  - ticket.pinnedCards render above the conversation with a confirm-dismiss
//  - the "Ticket Pulse · Auto" treatment keys off authorType === 'system'

const FIELD_CARD_ENTRY = {
  id: 9101,
  eventType: 'note',
  authorType: 'system',
  incoming: false,
  isPrivate: true,
  visibility: 'private',
  actorName: 'Ticket Pulse',
  actorEmail: null,
  bodyText: 'Intake details: Client name Acme Corp',
  content: 'Intake details: Client name Acme Corp',
  occurredAt: '2026-08-05T10:02:00Z',
  rawPayload: {
    kind: 'field_card',
    v: 1,
    title: 'Intake details',
    intro: 'Captured from the Power App.',
    accent: 'violet',
    workflowId: 9,
    runId: 77,
    workflowName: 'API intake router',
    fields: [
      { key: 'client_name', label: 'Client name', type: 'text', value: 'Acme Corp' },
      { key: 'expedite', label: 'Expedite', type: 'boolean', value: true },
    ],
  },
};

const TICKET = {
  id: 501,
  origin: 'ticketpulse',
  freshserviceTicketId: null,
  displayRef: 'TP-501',
  subject: 'New client onboarding',
  description: '<p>Set up the new client</p>',
  descriptionText: 'Set up the new client',
  status: 'Open',
  priority: 2,
  ticketType: 'Service Request',
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
  customFields: { client_name: 'Acme Corp Ltd', expedite: true },
  pinnedCards: [
    {
      id: 'pin-1',
      kind: 'field_card',
      createdAt: '2026-08-05T10:02:00Z',
      payload: { ...FIELD_CARD_ENTRY.rawPayload },
    },
  ],
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
      bodyText: 'Please onboard Acme',
      content: 'Please onboard Acme',
      occurredAt: '2026-08-05T10:01:00Z',
    },
    FIELD_CARD_ENTRY,
    {
      // Structured approval event: the body deliberately does NOT match the
      // legacy regexes, so only discriminator dispatch can style it.
      id: 9102,
      eventType: 'note',
      authorType: 'system',
      isPrivate: true,
      visibility: 'private',
      actorName: 'Ticket Pulse',
      bodyText: 'Manager declined the hardware request',
      content: 'Manager declined the hardware request',
      occurredAt: '2026-08-05T10:03:00Z',
      rawPayload: { kind: 'approval_event', event: 'rejected' },
    },
    {
      // Legacy approval note (no rawPayload) — regex fallback must still work.
      id: 9103,
      eventType: 'note',
      authorType: 'system',
      isPrivate: true,
      visibility: 'private',
      actorName: 'Ticket Pulse',
      bodyText: 'Approval APPROVED by Jane Manager',
      content: 'Approval APPROVED by Jane Manager',
      occurredAt: '2026-08-05T10:04:00Z',
    },
    {
      // System note under a different actor name: the Auto treatment must key
      // off authorType, not the "Ticket Pulse" string.
      id: 9104,
      eventType: 'note',
      authorType: 'system',
      isPrivate: true,
      visibility: 'private',
      actorName: 'Assignment engine',
      bodyText: 'routing context recorded',
      content: 'routing context recorded',
      occurredAt: '2026-08-05T10:05:00Z',
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
  dismissPinnedCard: vi.fn(() => Promise.resolve({ data: { ok: true } })),
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
  CustomFieldsCard: () => <div data-testid="custom-fields-card" />,
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

import TicketDetail, { approvalEventMeta } from './TicketDetail';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/tickets/501']}>
      <Routes>
        <Route path="/tickets/:id" element={<TicketDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TicketDetail field cards & structured approval dispatch', () => {
  beforeEach(() => {
    localStorage.clear();
    apiOverrides.get.mockClear();
    apiOverrides.dismissPinnedCard.mockClear();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(() => Promise.resolve()) }, configurable: true });
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => cleanup());

  test('field_card thread entries dispatch to FieldCardNote in timeline position', async () => {
    renderPage();

    const card = await screen.findByTestId('field-card-note');
    expect(within(card).getByText('Intake details')).toBeInTheDocument();
    expect(within(card).getByText('via API intake router · Auto')).toBeInTheDocument();
    // Live overlay: current customFields.client_name drifted from the snapshot.
    const updated = within(card).getByText('Acme Corp Ltd');
    expect(updated).toHaveAttribute('title', 'Updated since this note — was: Acme Corp');
    // Snapshot body text is NOT rendered as a plain note.
    expect(screen.queryByText('Intake details: Client name Acme Corp')).not.toBeInTheDocument();
  });

  test('field-card pencil scrolls to and flashes the custom-fields card', async () => {
    renderPage();
    const card = await screen.findByTestId('field-card-note');
    fireEvent.click(within(card).getByRole('button', { name: 'Edit Client name' }));
    expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    expect(screen.getByTestId('custom-fields-card-slot').className).toContain('ring-violet-400');
  });

  test('structured approval_event dispatches without matching the legacy regex', async () => {
    renderPage();
    const rejected = (await screen.findByText('Manager declined the hardware request')).closest('li');
    expect(within(rejected).getByText('Rejected')).toBeInTheDocument();
    expect(within(rejected).getByText('Approval')).toBeInTheDocument();
  });

  test('legacy approval notes still style through the regex fallback', async () => {
    renderPage();
    const approved = (await screen.findByText('Approval APPROVED by Jane Manager')).closest('li');
    expect(within(approved).getByText('Approved')).toBeInTheDocument();
  });

  test('system notes read as Ticket Pulse · Auto keyed off authorType', async () => {
    renderPage();
    const note = (await screen.findByText('routing context recorded')).closest('li.flex');
    expect(within(note).getByText('Auto')).toBeInTheDocument();
    expect(within(note).getByTitle('Ticket Pulse')).toBeInTheDocument();
  });

  test('pinned card renders above the conversation and dismisses after confirm', async () => {
    renderPage();
    const pinned = await screen.findByTestId('pinned-intake-card');
    expect(within(pinned).getByText('Intake details')).toBeInTheDocument();
    expect(within(pinned).getByText('via API intake router')).toBeInTheDocument();

    fireEvent.click(within(pinned).getByRole('button', { name: 'Dismiss card' }));
    expect(screen.getByRole('dialog', { name: 'Confirm dismiss' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(apiOverrides.dismissPinnedCard).toHaveBeenCalledWith(501, 'pin-1'));
    expect(screen.queryByTestId('pinned-intake-card')).not.toBeInTheDocument();
  });
});

describe('approvalEventMeta discriminator', () => {
  test('prefers rawPayload.kind over body text', () => {
    const meta = approvalEventMeta({
      authorType: 'system',
      bodyText: 'free-form wording',
      rawPayload: { kind: 'approval_event', event: 'approved', changed: true },
    });
    expect(meta?.label).toBe('Approved (changed)');
  });

  test('unknown structured events fall back to the body regex', () => {
    const meta = approvalEventMeta({
      authorType: 'system',
      bodyText: 'Clarification requested from approver',
      rawPayload: { kind: 'approval_event', event: 'mystery_event' },
    });
    expect(meta?.label).toBe('Clarification requested');
  });

  test('non-system entries never style as approval events', () => {
    expect(approvalEventMeta({ authorType: 'agent', bodyText: 'Approval APPROVED' })).toBeNull();
  });
});
