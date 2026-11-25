/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// QA 11-24 on the ticket page:
//  #5   Forward with the ticket's own files.
//  #7/8 A reply from the person we forwarded to is labelled as such, and
//       "Reply to <name>" answers them, never the requester.
//  #12  A picture opens the preview at that picture, not the first one.

const RITA_MAIL = {
  id: 60, eventType: 'original_email', source: 'email_inbound', authorType: 'requester', incoming: true, isPrivate: false,
  actorName: 'Rita Requester', actorEmail: 'rita@example.com', occurredAt: '2026-11-23T16:00:00Z',
  bodyText: 'Please approve the invoice. [Image: pasted-image-1.png]', bodyHtml: null, rawPayload: null,
};
const FORWARD = {
  id: 70, eventType: 'forward', source: 'ticketpulse_user', authorType: 'agent', incoming: false, isPrivate: true,
  actorName: 'Quinn Agent', actorEmail: 'qa@example.com', occurredAt: '2026-11-23T17:00:00Z',
  bodyText: 'Forwarded to tim@example.com', bodyHtml: null, rawPayload: { forwardTo: ['tim@example.com'] },
};
const TIM_REPLY = {
  id: 88, eventType: 'reply', source: 'email_inbound', authorType: 'requester', incoming: true, isPrivate: false,
  actorName: 'Tim Example', actorEmail: 'Tim@Example.com', occurredAt: '2026-11-23T18:00:00Z',
  bodyText: 'There was no attachment to the email.', bodyHtml: null, rawPayload: { to_emails: ['it@example.com'] },
};
const RITA_AGAIN = {
  id: 61, eventType: 'reply', source: 'email_inbound', authorType: 'requester', incoming: true, isPrivate: false,
  actorName: 'Rita Requester', actorEmail: 'rita@example.com', occurredAt: '2026-11-23T19:00:00Z',
  bodyText: 'Here is the second screenshot. [Image: pasted-image-1.png]', bodyHtml: null, rawPayload: null,
};
const INVOICE = { id: 12, threadEntryId: null, fileName: 'scan0001.pdf', displayName: 'Acme Supplies_INV-4471_2026_11_20.pdf', contentType: 'application/pdf', sizeBytes: 120000 };
const PO = { id: 14, threadEntryId: 60, fileName: 'po.pdf', contentType: 'application/pdf', sizeBytes: 90000 };
const SHOT_1 = { id: 21, threadEntryId: 60, fileName: 'pasted-image-1.png', contentType: 'image/png', sizeBytes: 5000 };
const SHOT_2 = { id: 22, threadEntryId: 61, fileName: 'pasted-image-1.png', contentType: 'image/png', sizeBytes: 6000 };
// Review 24 Nov 2026: a file on an internal note must not go out with a forward by default.
const TEAM_NOTE = {
  id: 65, eventType: 'note', source: 'ticketpulse_user', authorType: 'agent', incoming: false, isPrivate: true,
  actorName: 'Quinn Agent', actorEmail: 'qa@example.com', occurredAt: '2026-11-23T20:00:00Z',
  bodyText: 'Vendor portal shows the invoice as disputed.', bodyHtml: null, rawPayload: null,
};
const NOTE_FILE = { id: 31, threadEntryId: 65, fileName: 'vendor-portal.pdf', contentType: 'application/pdf', sizeBytes: 7000 };

const NATIVE = {
  id: 501,
  subject: 'Laptop will not boot',
  description: '<p>Screen stays black</p>',
  descriptionText: 'Screen stays black',
  status: 'Open',
  priority: 2,
  ticketType: 'Incident',
  createdAt: '2026-11-23T16:00:00Z',
  updatedAt: '2026-11-23T19:05:00Z',
  lastActivityAt: '2026-11-23T19:05:00Z',
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
  attachments: [INVOICE, PO, SHOT_1, SHOT_2, NOTE_FILE],
  mergedInto: null,
  stateChip: null,
  thread: [RITA_MAIL, FORWARD, TIM_REPLY, RITA_AGAIN, TEAM_NOTE],
  origin: 'ticketpulse',
  freshserviceTicketId: null,
  nativeNumber: 1042,
  displayRef: 'TP-1042',
  replySubjectDefault: 'Re: Laptop will not boot [TP-1042]',
};
const META = {
  nativeTicketingEnabled: true,
  forwardAvailable: true,
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
  forward: vi.fn(() => Promise.resolve({ data: { entry: { id: 3 }, to: ['eng@example.com'] } })),
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
// The preview says which file it opened and where that file sits in its list.
vi.mock('../components/tickets/AttachmentPreviewModal', () => ({
  default: ({ attachment, items }) => (
    <div data-testid="preview">{`${attachment.id} · ${(items || []).findIndex((a) => a.id === attachment.id) + 1} of ${(items || []).length}`}</div>
  ),
}));
vi.mock('../components/tickets/ImageMarkupModal', () => ({ default: () => null }));
vi.mock('../components/tickets/ApprovalTimeline', () => ({ default: () => null }));
vi.mock('../components/tickets/StagedFileChip', () => ({ default: ({ file }) => <li data-testid="staged-file">{file.name}</li> }));
vi.mock('../components/tickets/ComposerSignatureStrip', () => ({ default: () => null }));
vi.mock('../components/tickets/CcChips', () => ({
  default: ({ label, value, onChange }) => (
    <input aria-label={label || 'Cc'} data-value={(value || []).join(',')} onChange={(e) => onChange?.(e.target.value ? [e.target.value] : [])} />
  ),
}));
vi.mock('../components/tickets/RichTextEditor', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    default: forwardRef(({ ariaLabel, onChange, placeholder }, ref) => {
      useImperativeHandle(ref, () => ({ focus: () => {}, insertHtml: () => {}, insertText: () => {} }));
      return (
        <textarea
          aria-label={ariaLabel || 'editor'}
          placeholder={placeholder}
          onChange={(e) => onChange?.({ html: `<p>${e.target.value}</p>`, text: e.target.value })}
        />
      );
    }),
    isRichContent: () => false,
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

const ready = () => screen.findByRole('region', { name: 'Ticket description' });
const bubbleOf = (text) => screen.getByText(text).closest('li');

beforeEach(() => {
  localStorage.clear();
  for (const fn of [apiOverrides.reply, apiOverrides.note, apiOverrides.forward]) fn.mockClear();
});
afterEach(cleanup);

describe('a reply from the person the ticket was forwarded to (QA 11-24 #7/#8)', () => {
  test('is labelled as a reply to the forward, not "From requester"; the requester\'s own mail still is', async () => {
    renderPage();
    await ready();
    const tim = bubbleOf('There was no attachment to the email.');
    expect(within(tim).getByTestId('entry-kind-badge')).toHaveTextContent('Reply to your forward');
    expect(within(tim).getByTestId('entry-role')).toHaveTextContent('Forwarded to');
    expect(within(tim).queryByText(/From requester/)).toBeNull();
    const rita = bubbleOf(/Here is the second screenshot/);
    expect(within(rita).getByTestId('entry-kind-badge')).toHaveTextContent('From requester');
    expect(within(rita).getByTestId('entry-role')).toHaveTextContent('Requester');
    // Only the non-requester's message offers "Reply to <name>".
    expect(within(rita).queryByTestId('reply-to-sender')).toBeNull();
  });

  test('"Reply to Tim" opens the composer addressed to him only, and the send names him, not the requester', async () => {
    renderPage();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Reply to Tim' }));

    const header = await screen.findByTestId('reply-target');
    expect(header).toHaveTextContent('Reply to Tim Example');
    expect(header).toHaveTextContent('<tim@example.com>');
    expect(header).toHaveTextContent(/Rita Requester is not included/);
    expect(screen.getByTestId('reply-target-subject')).toHaveTextContent('Re: FW: Laptop will not boot [TP-1042]');
    expect(screen.getByRole('button', { name: /^reply\s?to requester$/i })).toHaveAttribute('aria-pressed', 'false');
    // No Cc seeded from the requester's side.
    expect(screen.getByLabelText('Cc')).toHaveAttribute('data-value', '');
    const body = screen.getByRole('textbox', { name: 'Reply body' });
    expect(body).toHaveAttribute('placeholder', expect.stringMatching(/^Write a reply to Tim/));

    fireEvent.change(body, { target: { value: 'Here it is, attached.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(apiOverrides.reply).toHaveBeenCalledTimes(1));
    const [id, payload] = apiOverrides.reply.mock.calls[0];
    expect(id).toBe(501);
    expect(payload).toMatchObject({ bodyText: 'Here it is, attached.', cc: [], replyToEntryId: 88, replyToEmail: 'tim@example.com' });
    expect(payload.ccRemoved).toBeUndefined();
    expect(payload.subject).toBeUndefined();
    expect(await screen.findByText(/Reply sent to Tim Example\. The requester was not included\./)).toBeInTheDocument();
    // Done: the composer is back to the requester.
    await waitFor(() => expect(screen.queryByTestId('reply-target')).toBeNull());
  });

  test('"Reply to the requester instead" goes back to an ordinary reply', async () => {
    renderPage();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Reply to Tim' }));
    await screen.findByTestId('reply-target');
    fireEvent.click(screen.getByRole('button', { name: 'Reply to the requester instead' }));
    expect(screen.queryByTestId('reply-target')).toBeNull();
    expect(screen.getByRole('button', { name: /^reply\s?to requester$/i })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'Hi Rita' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(apiOverrides.reply).toHaveBeenCalledTimes(1));
    expect(apiOverrides.reply.mock.calls[0][1].replyToEntryId).toBeUndefined();
  });
});

// Review (c): FreshService sends FS-born replies, and it can only write to the requester.
describe('"Reply to <name>" on a FreshService ticket', () => {
  const fsTicket = (lane) => ({ ...NATIVE, origin: 'freshservice', freshserviceTicketId: '24800', nativeNumber: null, displayRef: '#24800', replyLane: lane, replySubjectDefault: null });
  afterEach(() => apiOverrides.get.mockImplementation(() => Promise.resolve({ data: NATIVE })));

  test('hidden where FreshService sends the replies', async () => {
    apiOverrides.get.mockImplementation(() => Promise.resolve({ data: fsTicket('freshservice') }));
    renderPage();
    await ready();
    expect(within(bubbleOf('There was no attachment to the email.')).getByTestId('entry-kind-badge')).toHaveTextContent('Reply to your forward');
    expect(screen.queryByTestId('reply-to-sender')).toBeNull();
  });

  test('offered where Ticket Pulse sends FS-born replies', async () => {
    apiOverrides.get.mockImplementation(() => Promise.resolve({ data: fsTicket('ticketpulse') }));
    renderPage();
    await ready();
    expect(screen.getByRole('button', { name: 'Reply to Tim' })).toBeInTheDocument();
  });
});

describe('forward with the ticket\'s files (QA 11-24 #5)', () => {
  test('the files are listed ticked under their shown name; the ticked ids go with the forward', async () => {
    renderPage();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /^Forward$/ }));
    const box = screen.getByRole('checkbox', { name: 'Include the original attachments (2)' });
    expect(box).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Include Acme Supplies_INV-4471_2026_11_20.pdf' })).toBeChecked();
    // The pictures shown inside the messages are left out, behind their own line.
    expect(screen.getByRole('button', { name: 'Show pictures from the e-mail (2)' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Include po.pdf' }));
    fireEvent.change(screen.getByLabelText('Forward recipients'), { target: { value: 'eng@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Forward thread' }));
    await waitFor(() => expect(apiOverrides.forward).toHaveBeenCalledTimes(1));
    expect(apiOverrides.forward.mock.calls[0][1]).toMatchObject({ to: ['eng@example.com'], includeAttachmentIds: [12] });
    expect(apiOverrides.forward.mock.calls[0][1].includePrivateAttachments).toBeUndefined();
  });

  test('an internal note\'s file is not ticked by default; ticked on purpose it goes, and the server is told', async () => {
    renderPage();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /^Forward$/ }));
    // Not in the list of files, and not counted.
    expect(screen.getByRole('checkbox', { name: 'Include the original attachments (2)' })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'Include vendor-portal.pdf' })).toBeNull();

    // Sent as is: only the public files.
    fireEvent.change(screen.getByLabelText('Forward recipients'), { target: { value: 'eng@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Forward thread' }));
    await waitFor(() => expect(apiOverrides.forward).toHaveBeenCalledTimes(1));
    expect(apiOverrides.forward.mock.calls[0][1].includeAttachmentIds).toEqual([12, 14]);
    expect(apiOverrides.forward.mock.calls[0][1].includePrivateAttachments).toBeUndefined();

    // Chosen deliberately under "From internal notes".
    fireEvent.click(screen.getByRole('button', { name: 'From internal notes (1)' }));
    const noteFile = screen.getByRole('checkbox', { name: 'Include vendor-portal.pdf' });
    expect(noteFile).not.toBeChecked();
    fireEvent.click(noteFile);
    fireEvent.change(screen.getByLabelText('Forward recipients'), { target: { value: 'lead@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Forward thread' }));
    await waitFor(() => expect(apiOverrides.forward).toHaveBeenCalledTimes(2));
    expect(apiOverrides.forward.mock.calls[1][1]).toMatchObject({ includeAttachmentIds: [12, 14, 31], includePrivateAttachments: true });
  });

  test('with the box unticked nothing of the ticket\'s goes', async () => {
    renderPage();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /^Forward$/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include the original attachments (2)' }));
    fireEvent.change(screen.getByLabelText('Forward recipients'), { target: { value: 'eng@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Forward thread' }));
    await waitFor(() => expect(apiOverrides.forward).toHaveBeenCalledTimes(1));
    expect(apiOverrides.forward.mock.calls[0][1].includeAttachmentIds).toBeUndefined();
  });
});

describe('pictures open at the one clicked (QA 11-24 #12)', () => {
  test('two messages each with "pasted-image-1.png": the second opens the second file, at its place in the list', async () => {
    renderPage();
    await ready();
    const refs = await screen.findAllByRole('button', { name: 'Open picture pasted-image-1.png' });
    expect(refs).toHaveLength(2);
    fireEvent.click(refs[1]);
    expect(await screen.findByTestId('preview')).toHaveTextContent('22 · 4 of 5');
    cleanup();
    renderPage();
    await ready();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Open picture pasted-image-1.png' }))[0]);
    // In conversation order: the invoice, po.pdf, then this picture.
    expect(await screen.findByTestId('preview')).toHaveTextContent('21 · 3 of 5');
  });
});
