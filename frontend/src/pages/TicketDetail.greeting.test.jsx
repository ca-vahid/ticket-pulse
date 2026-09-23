/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// QA 09-18 #4 — the reply composer opens with the workspace greeting and
// closes with the sign-off; each agent's auto/manual choice is remembered.

const NATIVE = {
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
  origin: 'ticketpulse',
  freshserviceTicketId: null,
  nativeNumber: 1042,
  displayRef: 'TP-1042',
  replySubjectDefault: 'Re: Laptop will not boot [TP-1042]',
};

const metaWith = (replyGreeting) => ({
  nativeTicketingEnabled: true,
  technicians: [],
  categoryTree: [],
  categoryGroupLinks: [],
  groups: [],
  tags: [],
  approvalCategories: [],
  statuses: [],
  actor: { kind: 'admin', email: 'andrii@example.com', name: 'Andrii Grynik', workspaceRole: 'admin', technicianId: null },
  ...(replyGreeting ? { replyGreeting } : {}),
});

const pending = () => new Promise(() => {});
const apiOverrides = {
  get: vi.fn(() => Promise.resolve({ data: NATIVE })),
  meta: vi.fn(() => Promise.resolve({ data: metaWith({ enabled: true, greeting: 'Hi {{requester.firstName}},', signoff: 'Thank you,\n{{agent.firstName}}' }) })),
  reply: vi.fn(() => Promise.resolve({ data: { entry: { id: 1 }, email: { sent: true } } })),
  note: vi.fn(() => Promise.resolve({ data: { entry: { id: 2 } } })),
  listTemplates: vi.fn(() => Promise.resolve({ data: [] })),
};
const prefs = { get: vi.fn(() => Promise.resolve({ data: { value: null } })), set: vi.fn(() => Promise.resolve({ data: {} })) };

vi.mock('../services/api', () => ({
  ticketsAPI: new Proxy({}, { get: (_t, prop) => apiOverrides[prop] || pending }),
  assignmentAPI: new Proxy({}, { get: () => pending }),
  agentAPI: new Proxy({}, { get: () => pending }),
  uiPreferencesAPI: { get: (...a) => prefs.get(...a), set: (...a) => prefs.set(...a) },
}));
vi.mock('../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ workspaceId: 1, currentWorkspace: { id: 1, name: 'IT' }, availableWorkspaces: [] }),
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
vi.mock('../components/tickets/SplitTicketModal', () => ({ default: () => null }));
vi.mock('../components/tickets/AttachmentPreviewModal', () => ({ default: () => null }));
vi.mock('../components/tickets/ImageMarkupModal', () => ({ default: () => null }));
vi.mock('../components/tickets/ApprovalTimeline', () => ({ default: () => null }));
vi.mock('../components/tickets/StagedFileChip', () => ({ default: () => null }));
vi.mock('../components/tickets/ComposerSignatureStrip', () => ({ default: () => null }));
vi.mock('../components/tickets/CcChips', () => ({ default: () => <div data-testid="cc-chips" /> }));
// Editor stand-in that SHOWS its value (the real one is contenteditable).
vi.mock('../components/tickets/RichTextEditor', async () => {
  const { forwardRef } = await import('react');
  return {
    default: forwardRef(({ ariaLabel, onChange, value }, _ref) => (
      <textarea
        aria-label={ariaLabel || 'editor'}
        value={value || ''}
        onChange={(e) => onChange?.({ html: `<p>${e.target.value}</p>`, text: e.target.value })}
      />
    )),
    isRichContent: () => false,
    // QA 09-22 #1: TicketDetail reads plain text through the editor's block walker.
    htmlToPlainText: (html) => String(html || '').replace(/<\/p>\s*<p>/g, '\n\n').replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, ''),
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

const openReply = async () => {
  await screen.findByRole('region', { name: 'Ticket description' });
  await waitFor(() => expect(apiOverrides.meta).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: /reply\s?to requester/i }));
  return screen.findByTestId('reply-subject-row');
};

describe('TicketDetail reply greeting (QA 09-18 #4)', () => {
  beforeEach(() => {
    localStorage.clear();
    prefs.get.mockClear();
    prefs.set.mockClear();
    prefs.get.mockImplementation(() => Promise.resolve({ data: { value: null } }));
    apiOverrides.meta.mockImplementation(() => Promise.resolve({ data: metaWith({ enabled: true, greeting: 'Hi {{requester.firstName}},', signoff: 'Thank you,\n{{agent.firstName}}' }) }));
  });
  afterEach(() => cleanup());

  test('auto (the default): starting a reply pre-fills the greeting and the sign-off with real names', async () => {
    renderPage();
    await openReply();
    await waitFor(() => expect(prefs.get).toHaveBeenCalledWith('composer.greeting'));
    const body = screen.getByRole('textbox', { name: 'Reply body' });
    expect(body.value).toContain('Hi Rita,');
    expect(body.value).toContain('Thank you,<br>Andrii');
    fireEvent.click(screen.getByRole('button', { name: 'Greeting options' }));
    expect(screen.getByRole('menuitemradio', { name: /Add automatically when I start a reply/ })).toHaveAttribute('aria-checked', 'true');
  });

  test('manual (remembered): nothing is added until the Greeting button; ticking auto saves the preference', async () => {
    prefs.get.mockImplementation(() => Promise.resolve({ data: { value: 'manual' } }));
    renderPage();
    await screen.findByRole('region', { name: 'Ticket description' });
    await waitFor(() => expect(prefs.get).toHaveBeenCalledWith('composer.greeting'));
    fireEvent.click(screen.getByRole('button', { name: /reply\s?to requester/i }));
    await screen.findByTestId('greeting-controls');
    const body = screen.getByRole('textbox', { name: 'Reply body' });
    expect(body).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Greeting options' }));
    expect(screen.getByRole('menuitemradio', { name: /Only when I click Greeting/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: /Add automatically/ })).toHaveAttribute('aria-checked', 'false');

    fireEvent.change(body, { target: { value: 'The list is updated.' } });
    fireEvent.click(screen.getByRole('button', { name: /^greeting$/i }));
    expect(body).toHaveValue('<p>Hi Rita,</p><p><br></p><p>The list is updated.</p><p><br></p><p>Thank you,<br>Andrii</p>');

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Add automatically when I start a reply/ }));
    await waitFor(() => expect(prefs.set).toHaveBeenCalledWith('composer.greeting', 'auto'));
    expect(screen.queryByRole('menu', { name: 'Greeting options' })).not.toBeInTheDocument();
  });

  test('a workspace with the greeting off shows no controls and adds nothing', async () => {
    apiOverrides.meta.mockImplementation(() => Promise.resolve({ data: metaWith({ enabled: false, greeting: 'Hi {{requester.firstName}},', signoff: '' }) }));
    renderPage();
    await openReply();
    expect(screen.queryByTestId('greeting-controls')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Reply body' })).toHaveValue('');
    expect(prefs.get).not.toHaveBeenCalled();
  });
});
