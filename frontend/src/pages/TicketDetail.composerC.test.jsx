/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Composer, release C (Nov 2026): the new editor is a personal switch, off by
// default, and only internal notes use it.

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
const NATIVE = {
  ...BASE,
  origin: 'ticketpulse',
  freshserviceTicketId: null,
  nativeNumber: 1042,
  displayRef: 'TP-1042',
  replySubjectDefault: 'Re: Laptop will not boot [TP-1042]',
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
  get: vi.fn(() => Promise.resolve({ data: NATIVE })),
  meta: vi.fn(() => Promise.resolve({ data: META })),
  reply: vi.fn(() => Promise.resolve({ data: { entry: { id: 1 }, email: { sent: true } } })),
  note: vi.fn(() => Promise.resolve({ data: { entry: { id: 2 } } })),
  setStatus: vi.fn(() => Promise.resolve({ data: {} })),
  listQuickNotes: vi.fn(() => Promise.resolve({ data: [{ id: 1, name: 'Called the user', bodyText: 'Called the user.', bodyHtml: null, internalCategoryIds: [] }] })),
  listTemplates: vi.fn(() => Promise.resolve({ data: [{ id: 9, name: 'Ask for the model', bodyText: 'Which model?', bodyHtml: null }] })),
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
vi.mock('../components/tickets/ComposerSignatureStrip', () => ({ default: () => null }));
vi.mock('../components/tickets/CcChips', () => ({ default: () => <div data-testid="cc-chips" /> }));
vi.mock('../components/tickets/composer/TiptapEditor', async () => {
  const { forwardRef } = await import('react');
  return {
    default: forwardRef(({ ariaLabel, onChange, slashItems, slashLabel }, _ref) => (
      <textarea
        data-editor="tiptap"
        data-slash={`${slashLabel}:${(slashItems || []).map((i) => i.name).join('|')}`}
        aria-label={ariaLabel || 'editor'}
        onChange={(e) => onChange?.({ html: `<p>${e.target.value}</p>`, text: e.target.value })}
      />
    )),
  };
});
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

const body = (name) => screen.getByRole('textbox', { name });
const type = (name, value) => fireEvent.change(body(name), { target: { value } });
const ready = () => screen.findByRole('region', { name: 'Ticket description' });
const toReply = () => fireEvent.click(screen.getByRole('button', { name: /reply\s?to requester/i }));

describe('Ticket composer, release C: the new editor', () => {
  beforeEach(() => {
    localStorage.clear();
    for (const fn of [apiOverrides.reply, apiOverrides.note, prefs.get, prefs.set]) fn.mockClear();
    prefs.get.mockImplementation(() => Promise.resolve({ data: { value: null } }));
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: NATIVE }));
  });
  afterEach(() => cleanup());

  test('off by default: notes and replies use the classic editor', async () => {
    renderPage();
    await ready();
    expect(body('Internal note body')).not.toHaveAttribute('data-editor');
    toReply();
    expect(body('Reply body')).not.toHaveAttribute('data-editor');
  });

  test('switched on: internal notes get the new editor with quick notes on "/", replies stay classic', async () => {
    prefs.get.mockImplementation((key) => Promise.resolve({ data: { value: key === 'composer.editor' ? 'new' : null } }));
    renderPage();
    await ready();
    await waitFor(() => expect(body('Internal note body')).toHaveAttribute('data-editor', 'tiptap'));
    await waitFor(() => expect(body('Internal note body')).toHaveAttribute('data-slash', 'Quick notes:Called the user'));
    // The note still sends through the same path.
    type('Internal note body', 'Called the user.');
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() => expect(apiOverrides.note).toHaveBeenCalledTimes(1));
    expect(apiOverrides.note.mock.calls[0][1]).toMatchObject({ bodyText: 'Called the user.' });
    toReply();
    await waitFor(() => expect(body('Reply body')).not.toHaveAttribute('data-editor'));
  });

  test('the switch lives in the keyboard and editor dialog and is remembered', async () => {
    renderPage();
    await ready();
    fireEvent.keyDown(document.body, { key: '?' });
    const dialog = await screen.findByTestId('composer-shortcuts');
    fireEvent.click(within(dialog).getByRole('switch', { name: 'New editor' }));
    await waitFor(() => expect(prefs.set).toHaveBeenCalledWith('composer.editor', 'new'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(body('Internal note body')).toHaveAttribute('data-editor', 'tiptap'));
  });
});
