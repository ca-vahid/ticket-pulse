/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Autofill v2 — the "Autofill run" card on the AI & Routing tab: rendered
// from GET /tickets/:id/intake-runs, collapsed by default, "Show proposal"
// reveals what the model proposed (with match states + confidences) and what
// the agent kept. Absent entirely when the ticket has no run.

const TICKET = {
  id: 9,
  origin: 'ticketpulse',
  displayRef: 'TP-9',
  subject: 'Laptop won’t boot after Windows update',
  description: '<p>Request</p>',
  descriptionText: 'Request',
  status: 'Open',
  priority: 3,
  ticketType: 'Incident',
  createdAt: '2026-08-31T15:12:00Z',
  updatedAt: '2026-08-31T15:12:00Z',
  lastActivityAt: '2026-08-31T15:12:00Z',
  requester: { id: 41, name: 'Simon Dickinson', email: 'sdickinson@acme.com' },
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
  activities: [],
  thread: [],
};

const META = {
  nativeTicketingEnabled: true,
  technicians: [{ id: 5, name: 'Soheil Nasiri' }],
  categoryTree: [],
  categoryGroupLinks: [],
  groups: [],
  tags: [],
  approvalCategories: [],
  statuses: [],
  actor: { kind: 'admin', email: 'ada@example.com', workspaceRole: 'admin', technicianId: null },
};

const RUN = {
  id: 123,
  createdAt: '2026-08-31T15:10:30Z',
  actorName: 'Jane Agent',
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  durationMs: 7480,
  inputTokens: 3100,
  outputTokens: 610,
  requestSummary: 'Teams chat + 1 screenshot',
  result: {
    subject: 'Laptop won’t boot after Windows update',
    description: { request: 'Laptop blue-screens on boot since the update.', details: ['Restarted twice'], nextStep: 'Roll back', discussedWith: [] },
    descriptionText: 'Request: Laptop blue-screens on boot since the update.',
    requesterNameOrEmail: 'Simon',
    requesterMatch: { status: 'matched', candidate: { requesterId: 41, email: 'sdickinson@acme.com', name: 'Simon Dickinson', source: 'requester' }, candidates: [], reason: 'unique' },
    assigneeHint: { name: 'Soheil', reason: 'let me ask Soheil to help' },
    assigneeMatch: { status: 'matched', technician: { id: 5, name: 'Soheil Nasiri', email: null }, candidates: [], reason: 'unique' },
    categoryHint: 'Hardware',
    categoryLevel: 'top',
    priorityHint: 3,
    typeHint: 'Incident',
    sourceSummary: 'Teams chat + 1 screenshot',
    confidence: { subject: 0.92, description: 0.8, requester: 0.6, category: 0.3, priority: 0.55, type: 0.7, assignee: 0.8 },
  },
  resolved: { ticketId: 9, applied: { subject: true, description: true, requester: true, assignee: true, category: true, priority: false, type: true } },
};

const pending = () => new Promise(() => {});
const apiOverrides = {
  get: vi.fn(() => Promise.resolve({ data: TICKET })),
  meta: vi.fn(() => Promise.resolve({ data: META })),
  intakeRuns: vi.fn(() => Promise.resolve({ data: [RUN] })),
};

vi.mock('../services/api', () => ({
  ticketsAPI: new Proxy({}, { get: (_t, prop) => apiOverrides[prop] || pending }),
  assignmentAPI: new Proxy({}, { get: () => pending }),
}));
vi.mock('../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ workspaceId: 2, currentWorkspace: { id: 2, name: 'Accounting' }, availableWorkspaces: [] }),
}));
vi.mock('../components/nav/navDestinations', () => ({
  useWorkspaceRole: () => 'admin', // the real hook returns the role string
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
vi.mock('../components/tickets/TicketAiTab', () => ({ default: () => <div data-testid="ai-tab" /> }));
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
  return {
    default: forwardRef((_props, _ref) => <textarea aria-label="editor" />),
    isRichContent: () => false,
    sanitizeRichHtml: (html) => String(html || ''),
  };
});

import TicketDetail from './TicketDetail';

function renderAiTab() {
  return render(
    <MemoryRouter initialEntries={['/tickets/9?tab=ai']}>
      <Routes>
        <Route path="/tickets/:id" element={<TicketDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TicketDetail AI & Routing — Autofill run card (Autofill v2)', () => {
  beforeEach(() => {
    apiOverrides.intakeRuns.mockImplementation(() => Promise.resolve({ data: [RUN] }));
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  test('renders the run summary from GET /tickets/:id/intake-runs, collapsed, above the AI tab', async () => {
    renderAiTab();
    const card = await screen.findByRole('region', { name: 'Autofill run' });
    expect(apiOverrides.intakeRuns).toHaveBeenCalledWith(9);
    const run = within(card).getByTestId('autofill-run');
    expect(run).toHaveTextContent('Run #123');
    expect(run).toHaveTextContent('by Jane Agent');
    expect(run).toHaveTextContent('claude-sonnet-5');
    expect(run).toHaveTextContent('7.5 s');
    expect(run).toHaveTextContent('3.1K in / 610 out tokens');
    expect(run).toHaveTextContent('Teams chat + 1 screenshot');
    // Collapsed by default.
    expect(within(card).getByRole('button', { name: /Show proposal/ })).toHaveAttribute('aria-expanded', 'false');
    expect(within(card).queryByTestId('autofill-run-row-subject')).not.toBeInTheDocument();
    // Card sits with the rest of the tab.
    expect(screen.getByTestId('ai-tab')).toBeInTheDocument();
    // Admins get the link to the workspace-wide table.
    expect(within(card).getByRole('link', { name: 'All runs' })).toHaveAttribute('href', '/settings#ai-usage');
  });

  test('"Show proposal" reveals every proposed field with match state, confidence and what was kept', async () => {
    renderAiTab();
    const card = await screen.findByRole('region', { name: 'Autofill run' });
    fireEvent.click(within(card).getByRole('button', { name: /Show proposal/ }));
    expect(within(card).getByRole('button', { name: /Hide proposal/ })).toHaveAttribute('aria-expanded', 'true');

    const row = (key) => within(card).getByTestId(`autofill-run-row-${key}`);
    expect(row('subject')).toHaveTextContent('Laptop won’t boot after Windows update');
    expect(row('subject')).toHaveTextContent('high');
    expect(row('subject')).toHaveTextContent('kept');
    expect(row('description')).toHaveTextContent('Laptop blue-screens on boot since the update.');
    expect(row('requester')).toHaveTextContent('Simon Dickinson · sdickinson@acme.com');
    expect(row('requester')).toHaveTextContent('matched from known requesters');
    expect(row('assignee')).toHaveTextContent('Soheil Nasiri');
    expect(row('assignee')).toHaveTextContent('from: “let me ask Soheil to help”');
    expect(row('category')).toHaveTextContent('Hardware');
    expect(row('category')).toHaveTextContent('category only — subcategory left for the agent');
    expect(row('category')).toHaveTextContent('low');
    expect(row('priority')).toHaveTextContent('High (P3)');
    expect(row('priority')).toHaveTextContent('no'); // not kept
    expect(row('type')).toHaveTextContent('Incident');
    expect(within(card).getByText('Material read: Teams chat + 1 screenshot')).toBeInTheDocument();
  });

  test('no runs → no card at all', async () => {
    apiOverrides.intakeRuns.mockImplementation(() => Promise.resolve({ data: [] }));
    renderAiTab();
    await screen.findByTestId('ai-tab');
    await waitFor(() => expect(apiOverrides.intakeRuns).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Autofill run' })).not.toBeInTheDocument();
  });

  test('a failing GET (older backend) is silent', async () => {
    apiOverrides.intakeRuns.mockImplementation(() => Promise.reject(Object.assign(new Error('nope'), { response: { status: 404 } })));
    renderAiTab();
    await screen.findByTestId('ai-tab');
    await waitFor(() => expect(apiOverrides.intakeRuns).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Autofill run' })).not.toBeInTheDocument();
  });
});
