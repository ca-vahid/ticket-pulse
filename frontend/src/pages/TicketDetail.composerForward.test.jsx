/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// QA 11-16: Forward carries files (#2) and the note's links (#1b); the
// composer refuses files past the cap out loud instead of dropping them (#3).

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
  forward: vi.fn(() => Promise.resolve({ data: { entry: { id: 3 }, to: ['ops@example.com'] } })),
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
vi.mock('../components/tickets/AttachmentPreviewModal', () => ({ default: () => null }));
vi.mock('../components/tickets/ImageMarkupModal', () => ({ default: () => null }));
vi.mock('../components/tickets/ApprovalTimeline', () => ({ default: () => null }));
vi.mock('../components/tickets/StagedFileChip', () => ({ default: ({ file }) => <li data-testid="staged-file">{file.name}</li> }));
vi.mock('../components/tickets/ComposerSignatureStrip', () => ({ default: () => null }));
// The forward recipients row: one input that adds what is typed.
vi.mock('../components/tickets/CcChips', () => ({
  default: ({ label, onChange }) => (
    <input aria-label={label || 'Cc'} onChange={(e) => onChange?.(e.target.value ? [e.target.value] : [])} />
  ),
}));
// The editor stand-in: what is typed is the HTML (so a link can be typed), and
// it hands its paste hook to the test.
const editor = { onImagePaste: null };
vi.mock('../components/tickets/RichTextEditor', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    default: forwardRef(({ ariaLabel, onChange, onImagePaste }, ref) => {
      editor.onImagePaste = onImagePaste;
      useImperativeHandle(ref, () => ({ focus: () => {}, insertHtml: () => {}, insertText: () => {} }));
      return (
        <textarea
          aria-label={ariaLabel || 'editor'}
          onChange={(e) => onChange?.({ html: `<p>${e.target.value}</p>`, text: e.target.value.replace(/<[^>]+>/g, '') })}
        />
      );
    }),
    isRichContent: (html) => /<(a|b|strong|ul|ol|img)\b/i.test(String(html || '')),
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
const composer = () => document.querySelector('[aria-label="Reply composer"]');
const dropFiles = (files) => fireEvent.drop(composer(), { dataTransfer: { types: ['Files'], files } });
const png = (name) => new File([name], name, { type: 'image/png' });

describe('Ticket composer — Forward and files (QA 11-16)', () => {
  beforeEach(() => {
    localStorage.clear();
    for (const fn of [apiOverrides.reply, apiOverrides.note, apiOverrides.forward]) fn.mockClear();
  });
  afterEach(cleanup);

  test('Forward has the Attach control, and the files and the note\'s link go with the forward', async () => {
    renderPage();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /^Forward$/ }));
    expect(screen.getByRole('button', { name: 'Attach' })).toBeInTheDocument();
    expect(screen.getByText(/Sends your note, any files you attach/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Forward recipients'), { target: { value: 'ops@example.com' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Forward note' }), {
      target: { value: 'See <a href="https://forms.example.com/item/7">this form</a>' },
    });
    dropFiles([png('quote.png')]);
    await screen.findByText('quote.png');

    fireEvent.click(screen.getByRole('button', { name: 'Forward thread' }));
    await waitFor(() => expect(apiOverrides.forward).toHaveBeenCalledTimes(1));
    const [id, payload] = apiOverrides.forward.mock.calls[0];
    expect(id).toBe(501);
    expect(payload.to).toEqual(['ops@example.com']);
    expect(payload.noteHtml).toContain('<a href="https://forms.example.com/item/7">this form</a>');
    expect(payload.files.map((f) => f.name)).toEqual(['quote.png']);
    // Sent: the staged files are cleared.
    await waitFor(() => expect(screen.queryByText('quote.png')).not.toBeInTheDocument());
  });

  test('more files than a message can carry: the extra ones are refused out loud, not dropped silently', async () => {
    renderPage();
    await ready();
    dropFiles(Array.from({ length: 22 }, (_, i) => png(`shot-${i + 1}.png`)));
    await waitFor(() => expect(screen.getAllByTestId('staged-file')).toHaveLength(20));
    expect(screen.getByText(/A message can carry up to 20 files\. 2 files were not added\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Attach' })).toBeDisabled();
  });

  test('a pasted picture past the cap gets no "[Image: …]" in the text', async () => {
    renderPage();
    await ready();
    dropFiles(Array.from({ length: 19 }, (_, i) => png(`shot-${i + 1}.png`)));
    await waitFor(() => expect(screen.getAllByTestId('staged-file')).toHaveLength(19));
    // Two screenshots in one paste: the first fits, the second does not.
    expect(editor.onImagePaste(new Blob(['a'], { type: 'image/png' }))).toBe('pasted-image-1.png');
    expect(editor.onImagePaste(new Blob(['b'], { type: 'image/png' }))).toBeNull();
    await waitFor(() => expect(screen.getAllByTestId('staged-file')).toHaveLength(20));
  });

  test('a file the server could not store is named in a red notice', async () => {
    apiOverrides.note.mockImplementationOnce(() => Promise.resolve({
      data: { entry: { id: 2 }, attachmentsFailed: [{ fileName: 'pasted-image-6.png', reason: 'A ticket can hold at most 20 attachments' }] },
    }));
    renderPage();
    await ready();
    fireEvent.change(screen.getByRole('textbox', { name: 'Internal note body' }), { target: { value: 'Screens attached.' } });
    dropFiles([png('pasted-image-6.png')]);
    await screen.findByText('pasted-image-6.png');
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() => expect(apiOverrides.note).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Note added\. One file was not stored: pasted-image-6\.png\./)).toBeInTheDocument();
  });
});
