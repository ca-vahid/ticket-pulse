/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Mega 08-30 Phase SN5/SN6 (QA 08-27 #8) + DR3 — the reply composer's
// collapsible Subject row: hidden behind a one-line note for FS-born tickets
// (FreshService composes their subjects), prefilled with the server's
// `replySubjectDefault` and editable for TP-born ones, and the edited value
// rides the reply payload together with the per-session Idempotency-Key.

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
};

vi.mock('../services/api', () => ({
  ticketsAPI: new Proxy({}, { get: (_t, prop) => apiOverrides[prop] || pending }),
  assignmentAPI: new Proxy({}, { get: () => pending }),
  agentAPI: new Proxy({}, { get: () => pending }),
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

describe('TicketDetail reply subject row (Phase SN5)', () => {
  beforeEach(() => {
    localStorage.clear();
    apiOverrides.reply.mockClear();
    apiOverrides.note.mockClear();
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: NATIVE }));
  });
  afterEach(() => cleanup());

  test('internal-note mode has no subject row at all', async () => {
    renderPage();
    await screen.findByRole('region', { name: 'Ticket description' });
    expect(screen.queryByTestId('reply-subject-row')).not.toBeInTheDocument();
  });

  test('TP-born: collapsed row shows the server default, opens to an editable prefilled field', async () => {
    renderPage();
    const row = await openReply();

    const opener = within(row).getByRole('button', { name: 'Edit reply subject' });
    expect(opener).toHaveTextContent('Re: Laptop will not boot [TP-1042]');
    fireEvent.click(opener);

    const input = within(row).getByRole('textbox', { name: 'Reply subject' });
    expect(input).toHaveValue('Re: Laptop will not boot [TP-1042]');
    expect(input).toHaveAttribute('maxlength', '255');

    fireEvent.change(input, { target: { value: 'Your laptop is ready for pickup' } });
    expect(input).toHaveValue('Your laptop is ready for pickup');

    // Reset returns to the default and collapses.
    fireEvent.click(within(row).getByRole('button', { name: 'Reset' }));
    expect(within(row).getByRole('button', { name: 'Edit reply subject' })).toHaveTextContent('Re: Laptop will not boot [TP-1042]');
  });

  test('edited subject is sent in the reply payload with the per-session idempotency key; untouched default is not', async () => {
    renderPage();
    await openReply();

    fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'We are on it!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(apiOverrides.reply).toHaveBeenCalledTimes(1));
    const [, firstPayload] = apiOverrides.reply.mock.calls[0];
    expect(firstPayload).not.toHaveProperty('subject');
    expect(firstPayload.idempotencyKey).toEqual(expect.any(String));
    expect(firstPayload.idempotencyKey.length).toBeGreaterThan(8);

    // Second send: edited subject → sent; a NEW key after the first success.
    fireEvent.click(await screen.findByRole('button', { name: 'Edit reply subject' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply subject' }), { target: { value: 'Your laptop is ready for pickup' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'Ready at the desk.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(apiOverrides.reply).toHaveBeenCalledTimes(2));
    const [, secondPayload] = apiOverrides.reply.mock.calls[1];
    expect(secondPayload.subject).toBe('Your laptop is ready for pickup');
    expect(secondPayload.bodyText).toBe('Ready at the desk.');
    expect(secondPayload.idempotencyKey).not.toBe(firstPayload.idempotencyKey);
  });

  test('FS-born: the field is replaced by the one-line FreshService note', async () => {
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: FS_BORN }));
    renderPage();
    const row = await openReply();

    expect(within(row).getByText('FreshService composes the subject for replies on FreshService tickets.')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Edit reply subject' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('textbox', { name: 'Reply subject' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'hello from TP' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(apiOverrides.reply).toHaveBeenCalledTimes(1));
    expect(apiOverrides.reply.mock.calls[0][1]).not.toHaveProperty('subject');
  });
});
