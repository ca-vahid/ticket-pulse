/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Composer, release B (Nov 2026): undo send, template search, drag-and-drop,
// emoji, quote selection and "someone is writing".

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
const inserted = [];
const apiOverrides = {
  get: vi.fn(() => Promise.resolve({ data: NATIVE })),
  meta: vi.fn(() => Promise.resolve({ data: META })),
  reply: vi.fn(() => Promise.resolve({ data: { entry: { id: 1 }, email: { sent: true } } })),
  note: vi.fn(() => Promise.resolve({ data: { entry: { id: 2 } } })),
  setStatus: vi.fn(() => Promise.resolve({ data: {} })),
  listTemplates: vi.fn(() => Promise.resolve({ data: TEMPLATES })),
};
const TEMPLATES = ['Ask for the device model', 'Password reset steps', 'VPN client reinstall', 'Printer driver', 'Out of warranty', 'Loaner laptop'].map((name, i) => ({ id: i + 1, name, bodyText: `${name} body`, bodyHtml: null }));
const presence = { viewers: [] };
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
  useTicketPresence: (...args) => { presence.args = args; return { viewers: presence.viewers, onPresence: vi.fn() }; },
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
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    default: forwardRef(({ ariaLabel, onChange }, ref) => {
      useImperativeHandle(ref, () => ({ focus: () => {}, insertHtml: (h) => inserted.push(['html', h]), insertText: (t) => inserted.push(['text', t]) }));
      return (
        <textarea
          aria-label={ariaLabel || 'editor'}
          onChange={(e) => onChange?.({ html: `<p>${e.target.value}</p>`, text: e.target.value })}
        />
      );
    }),
    isRichContent: () => false,
    // The page reads a restored draft through this.
    htmlToPlainText: (h) => String(h || '').replace(/<[^>]+>/g, ''),
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
const composer = () => document.querySelector('[aria-label="Reply composer"]');
const toReply = () => fireEvent.click(screen.getByRole('button', { name: /reply\s?to requester/i }));

describe('Ticket composer, release B', () => {
  beforeEach(() => {
    localStorage.clear();
    inserted.length = 0;
    presence.viewers = [];
    for (const fn of [apiOverrides.reply, apiOverrides.note, apiOverrides.setStatus, prefs.get, prefs.set]) fn.mockClear();
    prefs.get.mockImplementation(() => Promise.resolve({ data: { value: null } }));
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: NATIVE }));
  });
  afterEach(() => { vi.useRealTimers(); cleanup(); });

  test('undo send is off unless the person switched it on: a reply goes at once', async () => {
    renderPage();
    await ready();
    toReply();
    type('Reply body', 'On its way.');
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(apiOverrides.reply).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('pending-send')).not.toBeInTheDocument();
  });

  test('with undo send on, a reply waits; Undo keeps the draft and sends nothing', async () => {
    prefs.get.mockImplementation((key) => Promise.resolve({ data: { value: key === 'composer.undoSend' ? 'on' : null } }));
    renderPage();
    await ready();
    await waitFor(() => expect(prefs.get).toHaveBeenCalledWith('composer.undoSend'));
    toReply();
    type('Reply body', 'On its way.');
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    const bar = await screen.findByTestId('pending-send');
    expect(bar).toHaveTextContent(/Sending in \d s/);
    expect(apiOverrides.reply).not.toHaveBeenCalled();
    fireEvent.click(within(bar).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.queryByTestId('pending-send')).not.toBeInTheDocument());
    expect(apiOverrides.reply).not.toHaveBeenCalled();
    expect(body('Reply body')).toHaveValue('On its way.');
  });

  test('with undo send on, sending again sends at once (for agents on a call)', async () => {
    prefs.get.mockImplementation((key) => Promise.resolve({ data: { value: key === 'composer.undoSend' ? 'on' : null } }));
    renderPage();
    await ready();
    await waitFor(() => expect(prefs.get).toHaveBeenCalledWith('composer.undoSend'));
    toReply();
    type('Reply body', 'On its way.');
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await screen.findByTestId('pending-send');
    fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
    await waitFor(() => expect(apiOverrides.reply).toHaveBeenCalledTimes(1));
  });

  // Vahid, 11 Nov 2026: leaving during the wait must not leave the reply unsent.
  test('leaving the ticket while a reply waits sends it', async () => {
    prefs.get.mockImplementation((key) => Promise.resolve({ data: { value: key === 'composer.undoSend' ? 'on' : null } }));
    const view = renderPage();
    await ready();
    await waitFor(() => expect(prefs.get).toHaveBeenCalledWith('composer.undoSend'));
    toReply();
    type('Reply body', 'On its way.');
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await screen.findByTestId('pending-send');
    expect(apiOverrides.reply).not.toHaveBeenCalled();
    view.unmount(); // navigated away
    await waitFor(() => expect(apiOverrides.reply).toHaveBeenCalledTimes(1));
    expect(apiOverrides.reply.mock.calls[0][0]).toBe(501);
    expect(apiOverrides.reply.mock.calls[0][1]).toMatchObject({ bodyText: 'On its way.' });
    // Sent, so no draft is left behind.
    await waitFor(() => expect(localStorage.getItem('tp_ticket_draft_501')).toBeNull());
  });

  test('Undo, then leaving: nothing is sent and the draft stays', async () => {
    prefs.get.mockImplementation((key) => Promise.resolve({ data: { value: key === 'composer.undoSend' ? 'on' : null } }));
    const view = renderPage();
    await ready();
    await waitFor(() => expect(prefs.get).toHaveBeenCalledWith('composer.undoSend'));
    toReply();
    type('Reply body', 'On its way.');
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    fireEvent.click(within(await screen.findByTestId('pending-send')).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.queryByTestId('pending-send')).not.toBeInTheDocument());
    view.unmount();
    await new Promise((r) => setTimeout(r, 50));
    expect(apiOverrides.reply).not.toHaveBeenCalled();
  });

  test('a reply cut off by closing the tab comes back saying it was not sent, with Send it now', async () => {
    localStorage.setItem('tp_ticket_draft_501', JSON.stringify({ body: '<p>On its way.</p>', cc: [], mode: 'reply', savedAt: Date.now(), held: true }));
    renderPage();
    await ready();
    const notice = await screen.findByTestId('held-draft-notice');
    expect(notice).toHaveTextContent('This reply was not sent.');
    fireEvent.click(within(notice).getByRole('button', { name: 'Send it now' }));
    await waitFor(() => expect(apiOverrides.reply).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('held-draft-notice')).not.toBeInTheDocument());
  });

  test('an ordinary draft comes back without that notice', async () => {
    localStorage.setItem('tp_ticket_draft_501', JSON.stringify({ body: '<p>Half a thought</p>', cc: [], mode: 'reply', savedAt: Date.now() }));
    renderPage();
    await ready();
    await screen.findByTestId('reply-subject-row');
    expect(screen.queryByTestId('held-draft-notice')).not.toBeInTheDocument();
  });

  test('internal notes never wait, even with undo send on', async () => {
    prefs.get.mockImplementation((key) => Promise.resolve({ data: { value: key === 'composer.undoSend' ? 'on' : null } }));
    renderPage();
    await ready();
    await waitFor(() => expect(prefs.get).toHaveBeenCalledWith('composer.undoSend'));
    type('Internal note body', 'Called the user.');
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() => expect(apiOverrides.note).toHaveBeenCalledTimes(1));
  });

  test('the undo-send switch lives in the send menu and is remembered', async () => {
    renderPage();
    await ready();
    toReply();
    type('Reply body', 'x');
    fireEvent.click(screen.getByRole('button', { name: 'Send and set status' }));
    const menu = await screen.findByTestId('send-status-menu');
    fireEvent.click(within(menu).getByRole('switch', { name: '5 seconds to undo a reply' }));
    await waitFor(() => expect(prefs.set).toHaveBeenCalledWith('composer.undoSend', 'on'));
  });

  test('templates: a search box once there are many; into a draft the pick goes to the caret', async () => {
    renderPage();
    await ready();
    toReply();
    await waitFor(() => expect(apiOverrides.listTemplates).toHaveBeenCalled());
    type('Reply body', 'Hi Rita,');
    fireEvent.click(await screen.findByRole('button', { name: /Templates/ }));
    const find = await screen.findByRole('searchbox', { name: 'Find a template' });
    fireEvent.change(find, { target: { value: 'vpn' } });
    expect(screen.getByText('VPN client reinstall')).toBeInTheDocument();
    expect(screen.queryByText('Printer driver')).not.toBeInTheDocument();
    fireEvent.keyDown(find, { key: 'Enter' });
    expect(inserted).toEqual([['html', 'VPN client reinstall body']]);
    // Nothing matches: say so.
    fireEvent.click(screen.getByRole('button', { name: /Templates/ }));
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Find a template' }), { target: { value: 'zzz' } });
    expect(screen.getByText(/No template matches/)).toBeInTheDocument();
  });

  test('files dropped on the composer are attached', async () => {
    renderPage();
    await ready();
    const file = new File(['x'], 'screenshot.png', { type: 'image/png' });
    fireEvent.dragOver(composer(), { dataTransfer: { types: ['Files'], files: [file] } });
    expect(composer()).toHaveAttribute('data-drag-over', 'true');
    expect(screen.getByText('Drop to attach (up to 5 files)')).toBeInTheDocument();
    fireEvent.drop(composer(), { dataTransfer: { types: ['Files'], files: [file] } });
    expect(composer()).not.toHaveAttribute('data-drag-over');
    await waitFor(() => expect(screen.getByRole('list', { name: 'Files to attach' })).toBeInTheDocument());
  });

  test('the emoji picker drops the emoji at the caret', async () => {
    renderPage();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Insert an emoji' }));
    const picker = await screen.findByTestId('emoji-picker');
    fireEvent.click(within(picker).getByRole('button', { name: '👍' }));
    expect(inserted).toEqual([['text', '👍']]);
    expect(screen.queryByTestId('emoji-picker')).not.toBeInTheDocument();
  });

  test('says who is writing a reply on this ticket, and announces my own writing', async () => {
    presence.viewers = [{ email: 'sam@example.com', name: 'Sam Ortiz', composing: 'reply' }, { email: 'kim@example.com', name: 'Kim Lee', composing: null }];
    renderPage();
    await ready();
    expect(screen.getByTestId('others-writing')).toHaveTextContent('Sam is writing a reply on this ticket right now.');
    expect(presence.args[2]).toBeNull();
    type('Internal note body', 'checking');
    await waitFor(() => expect(presence.args[2]).toBe('note'));
    toReply();
    await waitFor(() => expect(presence.args[2]).toBe('reply'));
  });
});
