/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// MEGA 09-01 Phase RO-2 / TU-2 — the Activity (History) tab: actor-kind chips,
// "Hide machine activity" (default ON, remembered per viewer), the hidden
// count, collapsed identical rows, and FS status/assignment lines that name
// the human who acted in FreshService.

const T0 = Date.parse('2026-08-18T14:46:36Z');
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();

const TICKET = {
  id: 39618,
  origin: 'freshservice',
  freshserviceTicketId: 237051,
  displayRef: '#237051',
  subject: 'PMT-FC 19279',
  description: '<p>invoice</p>',
  descriptionText: 'invoice',
  status: 'Closed',
  priority: 3,
  ticketType: 'Incident',
  createdAt: '2026-08-11T16:03:00Z',
  updatedAt: iso(0),
  lastActivityAt: iso(0),
  requester: { id: 40, name: '1800 Recevables', email: 'ar@vendor.example.com' },
  assignedTech: null,
  internalCategory: null,
  internalSubcategory: null,
  groupId: null,
  tags: [],
  approvals: [],
  attachments: [],
  mergedInto: null,
  stateChip: null,
  pipelineRuns: [],
  assignmentEpisodes: [],
  activities: [
    // Human edit in TP.
    { id: 1, activityType: 'fields_updated', performedBy: 'Kirsten Fanning', performedAt: iso(-60 * 60 * 1000), actorKind: 'human', details: { actorEmail: 'kfanning@example.com', source: 'ticketpulse_native', actorKind: 'human' } },
    // Attributed sync row (RO-1).
    { id: 2, activityType: 'status_changed', performedBy: 'Dominic Bautista (FreshService)', performedAt: iso(51 * 1000), actorKind: 'freshservice_sync', details: { oldStatus: 'Open', newStatus: 'Closed', note: 'Status changed from Open to Closed', via: 'freshservice', actorKind: 'freshservice_sync', actorName: 'Dominic Bautista' } },
    // Three identical reconcile flaps → one collapsed row (TU-2).
    { id: 3, activityType: 'status_changed', performedBy: 'FreshService', performedAt: iso(-3 * 60 * 60 * 1000), actorKind: 'reconcile', details: { oldStatus: 'Open', newStatus: 'Spam', note: 'Ticket was marked as spam in FreshService (spam=true)', actorKind: 'reconcile' } },
    { id: 4, activityType: 'status_changed', performedBy: 'FreshService', performedAt: iso(-3 * 60 * 60 * 1000 + 60 * 1000), actorKind: 'reconcile', details: { oldStatus: 'Open', newStatus: 'Spam', note: 'Ticket was marked as spam in FreshService (spam=true)', actorKind: 'reconcile' } },
    { id: 5, activityType: 'status_changed', performedBy: 'FreshService', performedAt: iso(-3 * 60 * 60 * 1000 + 3 * 60 * 1000), actorKind: 'reconcile', details: { oldStatus: 'Open', newStatus: 'Spam', note: 'Ticket was marked as spam in FreshService (spam=true)', actorKind: 'reconcile' } },
    // API row (Power Apps).
    { id: 6, activityType: 'resubmitted', performedBy: 'Coreshack intake', performedAt: iso(-2 * 60 * 60 * 1000), actorKind: 'api', details: { actorEmail: 'apikey:tp_live_x', actorKind: 'api', via: 'api_v1' } },
  ],
  thread: [
    // FS feed line for the SAME close as row #2 (within ±3 min) → deduped.
    { id: 900, source: 'freshservice_activity', eventType: 'status_event', actorName: 'Dominic Bautista', content: 'Dominic Bautista set Status as Closed', occurredAt: iso(0) },
    // FS feed line with no audit twin → surfaced, named.
    { id: 901, source: 'freshservice_activity', eventType: 'status_event', actorName: 'Kirsten Fanning', content: 'Kirsten Fanning set Status as Open', occurredAt: iso(-24 * 60 * 60 * 1000) },
    // FS system feed → machine.
    { id: 902, source: 'freshservice_activity', eventType: 'activity', actorName: 'Ticket Workflow', content: 'Ticket Workflow executed Update department', bodyText: 'Ticket Workflow executed Update department', occurredAt: iso(-25 * 60 * 60 * 1000) },
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
  actor: { kind: 'admin', email: 'ada@example.com', workspaceRole: 'admin', technicianId: null },
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
  useWorkspace: () => ({ workspaceId: 2, currentWorkspace: { id: 2, name: 'Accounting' }, availableWorkspaces: [] }),
}));
vi.mock('../components/nav/navDestinations', () => ({
  useWorkspaceRole: () => ({ role: 'admin', canManage: true, canReview: true }),
  NAV_DESTINATIONS: [],
}));
vi.mock('../hooks/useSSE', () => ({ useSSE: vi.fn() }));
vi.mock('../hooks/useTicketPresence', () => ({ useTicketPresence: () => ({ viewers: [], onPresence: vi.fn() }) }));
vi.mock('../hooks/useTicketTypes', () => ({ useTicketTypes: () => ({ activeTypes: [], types: [], typeByName: () => null }) }));
vi.mock('../components/AppHeader', () => ({ default: () => <div>AppHeader</div> }));
vi.mock('../components/nav/MobileTabBar', () => ({ default: () => null }));
vi.mock('../components/tickets/ThreadSummaryCard', () => ({ default: () => null }));
vi.mock('../components/tickets/ProposedReplyCard', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketFamilyCard', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketAiTab', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketTasksTab', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketTagEditor', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketOpsCards', () => ({ CustomFieldsCard: () => null, MacroMenu: () => null, TicketLinksCard: () => null }));
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
  return { default: forwardRef((_props, _ref) => <textarea aria-label="editor" />), isRichContent: () => false };
});

import TicketDetail from './TicketDetail';

function renderHistory() {
  return render(
    <MemoryRouter initialEntries={['/tickets/39618?tab=history']}>
      <Routes>
        <Route path="/tickets/:id" element={<TicketDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function historySection() {
  return screen.findByRole('region', { name: 'Ticket history' });
}

describe('TicketDetail History tab — actor kinds, machine filter, collapsing (RO-2 / TU-2)', () => {
  beforeEach(() => {
    localStorage.clear();
    apiOverrides.get.mockClear();
  });
  afterEach(() => cleanup());

  test('machine rows are hidden by default with a count; human, API and named-FS rows stay', async () => {
    renderHistory();
    const section = await historySection();

    expect(within(section).getByRole('checkbox', { name: /hide machine activity/i })).toBeChecked();
    // 3 reconcile flaps + 1 FS system-feed line = 4 machine events.
    expect(within(section).getByTestId('machine-hidden-count')).toHaveTextContent('4 machine events hidden');

    // Attributed sync row reads as the human's action in FreshService (RO-1/RO-2).
    expect(within(section).getByText('Closed')).toBeInTheDocument();
    expect(within(section).getByText('Dominic Bautista')).toBeInTheDocument();
    // The FS feed line for the same close is NOT duplicated.
    expect(within(section).getAllByText('Dominic Bautista')).toHaveLength(1);
    // An FS status line with no audit twin is surfaced, named.
    expect(within(section).getAllByText('Kirsten Fanning').length).toBeGreaterThanOrEqual(1);
    // Each row carries its actor kind (QA 11-05 #9: as data, no "Human" pill).
    const kinds = within(section).getAllByTestId('history-row').map((r) => r.getAttribute('data-kind'));
    expect(kinds).toEqual(expect.arrayContaining(['human', 'api', 'freshservice_sync']));
    expect(kinds).not.toContain('reconcile');
    expect(within(section).queryByTestId('actor-kind-chip')).not.toBeInTheDocument();
    expect(within(section).queryByText('Human')).not.toBeInTheDocument();
    // The collapsed Spam flap is hidden.
    expect(within(section).queryByText(/Open → Spam/)).not.toBeInTheDocument();
  });

  test('unticking shows every machine action as its own line; expanding one shows the ×3 flap with a time span, and the choice is remembered', async () => {
    renderHistory();
    const section = await historySection();

    fireEvent.click(within(section).getByRole('checkbox', { name: /hide machine activity/i }));

    expect(within(section).queryByTestId('machine-hidden-count')).not.toBeInTheDocument();
    // No "N automation events" bursts any more (QA 11-05 #9): one line per action.
    expect(within(section).queryByTestId('history-burst')).not.toBeInTheDocument();
    const machineRows = within(section).getAllByTestId('history-row').filter((r) => r.getAttribute('data-machine') === 'true');
    expect(machineRows).toHaveLength(2); // the ×3 reconcile flap (one line, ×3) + the FreshService system line
    const flap = machineRows.find((r) => r.getAttribute('data-kind') === 'reconcile');
    expect(flap).toHaveTextContent('×3');
    fireEvent.click(within(flap).getByRole('button', { expanded: false }));
    // Three identical reconcile rows folded into one with a span.
    expect(within(flap).getByTestId('collapsed-span')).toHaveTextContent(/×3, \d{1,2}:\d{2}.*–.*\d{1,2}:\d{2}/);
    expect(within(section).getAllByText(/Spam/).length).toBeGreaterThanOrEqual(1);
    expect(within(section).getByText(/Ticket Workflow executed Update department/)).toBeInTheDocument();
    expect(localStorage.getItem('tp.ticketHistory.hideMachine')).toBe('false');
  });

  test('a remembered "off" preference is honoured on load', async () => {
    localStorage.setItem('tp.ticketHistory.hideMachine', 'false');
    renderHistory();
    const section = await historySection();
    expect(within(section).getByRole('checkbox', { name: /hide machine activity/i })).not.toBeChecked();
    expect(within(section).getAllByTestId('history-row').map((r) => r.getAttribute('data-kind'))).toContain('reconcile');
  });

  test('each row is a keyboard-focusable button that expands and collapses its details (QA 11-05 #9)', async () => {
    renderHistory();
    const section = await historySection();
    const row = within(section).getAllByTestId('history-row').find((r) => r.getAttribute('data-kind') === 'freshservice_sync' && /Dominic Bautista/.test(r.textContent));
    const button = within(row).getByRole('button');
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const details = within(row).getByTestId('history-details');
    expect(button).toHaveAttribute('aria-controls', details.id);
    expect(within(details).getByTestId('actor-kind')).toHaveTextContent(/FreshService/);
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(within(row).queryByTestId('history-details')).not.toBeInTheDocument();
  });
});
