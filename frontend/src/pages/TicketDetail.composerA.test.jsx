/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Composer, release A (Nov 2026): R / N / ? keys, the bigger editor beside the
// thread, note-versus-reply safety, and "send and set status".

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
const FS_BORN = {
  ...BASE,
  origin: 'freshservice',
  freshserviceTicketId: '239470',
  displayRef: '#239470',
  replySubjectDefault: null,
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

const openReply = async () => {
  await screen.findByRole('region', { name: 'Ticket description' });
  fireEvent.click(screen.getByRole('button', { name: /reply\s?to requester/i }));
  return screen.findByTestId('reply-subject-row');
};

const body = (name) => screen.getByRole('textbox', { name });
const type = (name, value) => fireEvent.change(body(name), { target: { value } });
const ready = () => screen.findByRole('region', { name: 'Ticket description' });
const composer = () => document.querySelector('[aria-label="Reply composer"]');
const toReply = () => fireEvent.click(screen.getByRole('button', { name: /reply\s?to requester/i }));

describe('Ticket composer, release A', () => {
  beforeEach(() => {
    localStorage.clear();
    for (const fn of [apiOverrides.reply, apiOverrides.note, apiOverrides.setStatus, prefs.get, prefs.set]) fn.mockClear();
    prefs.get.mockImplementation(() => Promise.resolve({ data: { value: null } }));
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: NATIVE }));
    delete window.matchMedia;
    document.documentElement.removeAttribute('data-composer-dock');
  });
  afterEach(() => cleanup());

  test('R starts a reply and N goes back to a note, but never while typing', async () => {
    renderPage();
    await ready();
    fireEvent.keyDown(document.body, { key: 'r' });
    expect(await screen.findByTestId('reply-subject-row')).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'n' });
    await waitFor(() => expect(screen.queryByTestId('reply-subject-row')).not.toBeInTheDocument());
    expect(screen.getByTestId('note-audience')).toHaveTextContent('only your team sees this');
    // Typing an "r" inside the editor is just a letter.
    fireEvent.keyDown(body('Internal note body'), { key: 'r' });
    expect(screen.queryByTestId('reply-subject-row')).not.toBeInTheDocument();
  });

  test('? opens the list; single-letter keys can be switched off and that is remembered', async () => {
    renderPage();
    await ready();
    fireEvent.keyDown(document.body, { key: '?' });
    const dialog = await screen.findByTestId('composer-shortcuts');
    expect(dialog).toHaveTextContent('Reply to the requester');
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Single-letter keys' }));
    await waitFor(() => expect(prefs.set).toHaveBeenCalledWith('composer.singleKeys', 'off'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document.body, { key: 'r' });
    expect(screen.queryByTestId('reply-subject-row')).not.toBeInTheDocument();
  });

  test('Ctrl+Shift+F: full sheet on a narrow screen, docked beside the thread on a wide one', async () => {
    renderPage();
    await ready();
    expect(composer()).toHaveAttribute('data-composer-layout', 'inline');
    fireEvent.keyDown(document.body, { key: 'F', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(composer()).toHaveAttribute('data-composer-layout', 'full'));
    fireEvent.keyDown(composer(), { key: 'Escape' });
    await waitFor(() => expect(composer()).toHaveAttribute('data-composer-layout', 'inline'));
    cleanup();

    window.matchMedia = () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} });
    renderPage();
    await ready();
    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(composer()).toHaveAttribute('data-composer-layout', 'docked'));
    // The page makes room and the thread stays: no scrim, no scroll lock.
    expect(document.documentElement).toHaveAttribute('data-composer-dock', 'true');
    expect(document.body.style.overflow).not.toBe('hidden');
    expect(screen.getByText(/Writing beside the thread/)).toBeInTheDocument();
  });

  test('text written as a note and switched to a reply says so, and can go back', async () => {
    renderPage();
    await ready();
    type('Internal note body', 'user is on a plan, do not mention');
    toReply();
    const notice = await screen.findByTestId('note-to-reply-notice');
    expect(notice).toHaveTextContent('You wrote this as an internal note. As a reply it is e-mailed to Rita Requester.');
    fireEvent.click(within(notice).getByRole('button', { name: 'Keep it as a note' }));
    await waitFor(() => expect(screen.queryByTestId('note-to-reply-notice')).not.toBeInTheDocument());
    expect(screen.getByTestId('note-audience')).toBeInTheDocument();
    // Text typed in reply mode from the start raises nothing.
    type('Internal note body', '');
    toReply();
    type('Reply body', 'Hello Rita');
    expect(screen.queryByTestId('note-to-reply-notice')).not.toBeInTheDocument();
  });

  test('an @mention in a reply is held until confirmed', async () => {
    renderPage();
    await ready();
    toReply();
    type('Reply body', '<strong class="tp-mention">@Sam Ortiz</strong> can you check');
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    const notice = await screen.findByTestId('note-to-reply-notice');
    expect(notice).toHaveTextContent('@mention');
    expect(apiOverrides.reply).not.toHaveBeenCalled();
    fireEvent.click(within(notice).getByRole('button', { name: 'Send to the requester anyway' }));
    await waitFor(() => expect(apiOverrides.reply).toHaveBeenCalledTimes(1));
  });

  test('send and set status: the reply goes first, then the status, and the choice is remembered', async () => {
    renderPage();
    await ready();
    toReply();
    type('Reply body', 'Fixed, please confirm.');
    fireEvent.click(screen.getByRole('button', { name: 'Send and set status' }));
    const menu = await screen.findByTestId('send-status-menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Open' })).not.toBeInTheDocument(); // the status it already has
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Pending/ }));
    await waitFor(() => expect(apiOverrides.reply).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(apiOverrides.setStatus).toHaveBeenCalledWith(501, 'Pending'));
    expect(apiOverrides.reply.mock.invocationCallOrder[0]).toBeLessThan(apiOverrides.setStatus.mock.invocationCallOrder[0]);
    await waitFor(() => expect(prefs.set).toHaveBeenCalledWith('composer.sendStatus', 'Pending'));
  });

  test('a plain send never touches the status', async () => {
    renderPage();
    await ready();
    type('Internal note body', 'Called the user.');
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() => expect(apiOverrides.note).toHaveBeenCalledTimes(1));
    expect(apiOverrides.setStatus).not.toHaveBeenCalled();
  });
});
