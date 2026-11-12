/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Composer, release D2 (Nov 2026): writing help (AI) on the person's own text,
// and the draft kept on the server so it follows them to another computer.

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
  composeAssist: vi.fn(() => Promise.resolve({ data: { text: 'Please restart the laptop.', action: 'improve' } })),
  getDraft: vi.fn(() => Promise.resolve({ data: null })),
  saveDraft: vi.fn(() => Promise.resolve({ data: {} })),
  deleteDraft: vi.fn(() => Promise.resolve({ data: null })),
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
    default: forwardRef(({ ariaLabel, onChange, slashItems, slashLabel, completionOn }, _ref) => (
      <textarea
        data-editor="tiptap"
        data-completion={completionOn ? 'on' : 'off'}
        data-slash={`${slashLabel}:${(slashItems || []).map((i) => i.name).join('|')}`}
        aria-label={ariaLabel || 'editor'}
        onChange={(e) => onChange?.({ html: `<p>${e.target.value}</p>`, text: e.target.value })}
      />
    )),
  };
});
// Editable stand-in for the rich editor: typing updates both html + text, and
// the test can say what is "selected".
const selection = { current: null };
const replaced = vi.fn(() => true);
vi.mock('../components/tickets/RichTextEditor', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  const strip = (html) => String(html || '').replace(/<\/p><p>/g, '\n').replace(/<[^>]+>/g, '');
  return {
    default: forwardRef(({ ariaLabel, onChange, value }, ref) => {
      useImperativeHandle(ref, () => ({ focus: () => {}, getSelection: () => selection.current, replaceSelection: (...a) => replaced(...a) }));
      return (
        <textarea
          aria-label={ariaLabel || 'editor'}
          value={strip(value)}
          onChange={(e) => onChange?.({ html: `<p>${e.target.value}</p>`, text: e.target.value })}
        />
      );
    }),
    isRichContent: () => false,
    htmlToPlainText: strip,
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

const openAi = () => fireEvent.click(screen.getByRole('button', { name: 'Writing help (AI)' }));
const pick = (label) => fireEvent.click(within(screen.getByTestId('assist-menu')).getByRole('menuitem', { name: label }));

describe('Ticket composer, release D2', () => {
  beforeEach(() => {
    localStorage.clear();
    selection.current = null;
    for (const fn of [apiOverrides.reply, apiOverrides.note, apiOverrides.composeAssist, apiOverrides.getDraft, apiOverrides.saveDraft, apiOverrides.deleteDraft, prefs.get, prefs.set, replaced]) fn.mockClear();
    prefs.get.mockImplementation(() => Promise.resolve({ data: { value: null } }));
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: NATIVE }));
    apiOverrides.getDraft.mockImplementation(() => Promise.resolve({ data: null }));
    apiOverrides.composeAssist.mockImplementation(() => Promise.resolve({ data: { text: 'Please restart the laptop.', action: 'improve' } }));
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  describe('writing help (AI)', () => {
    test('whole draft: the suggestion is shown first, Replace puts it in, and the old text can come back', async () => {
      renderPage();
      await ready();
      toReply();
      type('Reply body', 'pls restart teh laptop');
      openAi();
      expect(within(screen.getByTestId('assist-menu')).getByText('On the whole draft')).toBeInTheDocument();
      pick('Fix spelling and grammar');
      expect(apiOverrides.composeAssist).toHaveBeenCalledWith(501, { action: 'improve', text: 'pls restart teh laptop' });
      expect(await screen.findByTestId('assist-result')).toHaveTextContent('Please restart the laptop.');
      // Nothing changed yet.
      expect(body('Reply body')).toHaveValue('pls restart teh laptop');
      fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
      expect(body('Reply body')).toHaveValue('Please restart the laptop.');
      fireEvent.click(screen.getByRole('button', { name: 'Put my text back' }));
      expect(body('Reply body')).toHaveValue('pls restart teh laptop');
      expect(screen.queryByTestId('assist-panel')).not.toBeInTheDocument();
      expect(apiOverrides.reply).not.toHaveBeenCalled();
    });

    test('selected text: only that part goes to the AI and only that part is replaced', async () => {
      renderPage();
      await ready();
      toReply();
      type('Reply body', 'Hi Rita. pls restart teh laptop. Thanks');
      selection.current = { text: 'pls restart teh laptop.', rich: false, token: { id: 1 } };
      openAi();
      expect(within(screen.getByTestId('assist-menu')).getByText('On the text you selected')).toBeInTheDocument();
      pick('Make it shorter');
      expect(apiOverrides.composeAssist).toHaveBeenCalledWith(501, { action: 'shorter', text: 'pls restart teh laptop.' });
      await screen.findByTestId('assist-result');
      fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
      expect(replaced).toHaveBeenCalledWith({ id: 1 }, 'Please restart the laptop.');
    });

    test('the selection changed meanwhile: nothing is replaced and the person is told', async () => {
      replaced.mockReturnValueOnce(false);
      renderPage();
      await ready();
      toReply();
      type('Reply body', 'pls restart teh laptop');
      selection.current = { text: 'restart teh laptop', rich: false, token: { id: 2 } };
      openAi();
      pick('Fix spelling and grammar');
      await screen.findByTestId('assist-result');
      fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
      expect(screen.getByText(/has changed since/)).toBeInTheDocument();
      expect(body('Reply body')).toHaveValue('pls restart teh laptop');
    });

    test('Add below keeps what was written; an error offers Try again', async () => {
      apiOverrides.composeAssist.mockImplementationOnce(() => Promise.reject({ response: { data: { message: 'That is a lot of rewrites in one minute. Give it a moment and try again.' } } }));
      renderPage();
      await ready();
      toReply();
      type('Reply body', 'restart it');
      openAi();
      pick('Translate to French');
      expect(await screen.findByText(/a lot of rewrites/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await screen.findByTestId('assist-result');
      fireEvent.click(screen.getByRole('button', { name: 'Add below' }));
      expect(body('Reply body')).toHaveValue('restart it\nPlease restart the laptop.');
    });

    test('"Turn my notes into a reply" is for replies only; an empty draft has nothing to ask about', async () => {
      renderPage();
      await ready();
      openAi();
      const menu = screen.getByTestId('assist-menu');
      expect(within(menu).queryByRole('menuitem', { name: 'Turn my notes into a reply' })).not.toBeInTheDocument();
      expect(within(menu).getByText('Write something first, then ask.')).toBeInTheDocument();
      expect(within(menu).getByRole('menuitem', { name: 'Make it shorter' })).toBeDisabled();
      fireEvent.keyDown(document, { key: 'Escape' });
      toReply();
      openAi();
      expect(within(screen.getByTestId('assist-menu')).getByRole('menuitem', { name: 'Turn my notes into a reply' })).toBeInTheDocument();
    });

    test('switched off for this person: no AI button; the switch is in the keyboard and editor dialog', async () => {
      prefs.get.mockImplementation((key) => Promise.resolve({ data: { value: key === 'composer.ai' ? 'off' : null } }));
      renderPage();
      await ready();
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Writing help (AI)' })).not.toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
      const sw = within(screen.getByTestId('composer-shortcuts')).getByRole('switch', { name: 'Writing help (AI)' });
      expect(sw).toHaveAttribute('aria-checked', 'false');
      fireEvent.click(sw);
      await waitFor(() => expect(prefs.set).toHaveBeenCalledWith('composer.ai', 'on'));
      expect(screen.getByRole('button', { name: 'Writing help (AI)' })).toBeInTheDocument();
    });
  });

  describe('the draft on the server', () => {
    test('nothing here, a draft on the server: it is picked up, with its mode', async () => {
      apiOverrides.getDraft.mockImplementation(() => Promise.resolve({ data: { mode: 'reply', body: '<p>Started at my desk</p>', cc: [], updatedAt: '2026-11-12T20:00:00Z' } }));
      renderPage();
      await ready();
      await waitFor(() => expect(body('Reply body')).toHaveValue('Started at my desk'));
      expect(screen.getByText('Picked up the draft you started on another computer')).toBeInTheDocument();
      expect(apiOverrides.saveDraft).not.toHaveBeenCalled();
    });

    test('unsent edits on this computer win over the server copy', async () => {
      localStorage.setItem('tp_ticket_draft_501', JSON.stringify({ body: '<p>Newer, typed here</p>', cc: [], mode: 'note' }));
      localStorage.setItem('tp_ticket_draft_sync_501', JSON.stringify({ body: '<p>Older</p>' }));
      apiOverrides.getDraft.mockImplementation(() => Promise.resolve({ data: { mode: 'note', body: '<p>Older</p>', cc: [] } }));
      renderPage();
      await ready();
      await waitFor(() => expect(apiOverrides.getDraft).toHaveBeenCalledWith(501));
      expect(body('Internal note body')).toHaveValue('Newer, typed here');
    });

    test('sent or cleared on another computer: the stale copy here goes away', async () => {
      localStorage.setItem('tp_ticket_draft_501', JSON.stringify({ body: '<p>Already sent</p>', cc: [], mode: 'note' }));
      localStorage.setItem('tp_ticket_draft_sync_501', JSON.stringify({ body: '<p>Already sent</p>' }));
      renderPage();
      await ready();
      await waitFor(() => expect(body('Internal note body')).toHaveValue(''));
      expect(localStorage.getItem('tp_ticket_draft_501')).toBeNull();
    });

    test('typing saves it a moment later; sending removes it', async () => {
      renderPage();
      await ready();
      await waitFor(() => expect(apiOverrides.getDraft).toHaveBeenCalled());
      type('Internal note body', 'Called the user');
      await waitFor(() => expect(apiOverrides.saveDraft).toHaveBeenCalledWith(501, { mode: 'note', body: '<p>Called the user</p>', cc: [] }), { timeout: 4000 });
      fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
      await waitFor(() => expect(apiOverrides.note).toHaveBeenCalled());
      await waitFor(() => expect(apiOverrides.deleteDraft).toHaveBeenCalledWith(501));
    });

    test('the server does not answer: the composer works as before and nothing is saved there', async () => {
      apiOverrides.getDraft.mockImplementation(() => Promise.reject(new Error('offline')));
      localStorage.setItem('tp_ticket_draft_501', JSON.stringify({ body: '<p>Kept here</p>', cc: [], mode: 'note' }));
      renderPage();
      await ready();
      expect(body('Internal note body')).toHaveValue('Kept here');
      type('Internal note body', 'Kept here, more');
      await new Promise((r) => setTimeout(r, 1700));
      expect(apiOverrides.saveDraft).not.toHaveBeenCalled();
    });
  });
});
