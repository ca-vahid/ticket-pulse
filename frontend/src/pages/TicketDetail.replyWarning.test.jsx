/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// 22 Nov 2026 — the reply box warns when the requester does not read replies
// (a machine sender on the no-reply list, or an unattended requester). A quiet
// line above the composer in reply mode; sending is never blocked.
// (Harness from TicketDetail.replySubject.test.jsx.)

const BASE = {
  id: 501,
  subject: 'Disk alert on file server',
  description: '<p>Disk 90% full</p>',
  descriptionText: 'Disk 90% full',
  status: 'Open',
  priority: 2,
  ticketType: 'Incident',
  createdAt: '2026-11-20T10:00:00Z',
  updatedAt: '2026-11-20T10:05:00Z',
  lastActivityAt: '2026-11-20T10:05:00Z',
  requester: { id: 40, name: 'Alerts', email: 'noreply@alerts.example.com', unattended: false },
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
  replySubjectDefault: 'Re: Disk alert on file server [TP-1042]',
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
  actor: { kind: 'agent', email: 'dana.fox@example.com', workspaceRole: null, technicianId: 12 },
};

const pending = () => new Promise(() => {});
const apiOverrides = {
  get: vi.fn(),
  meta: vi.fn(() => Promise.resolve({ data: META })),
  reply: vi.fn(() => Promise.resolve({ data: { entry: { id: 1 }, email: { sent: true } } })),
  note: vi.fn(() => Promise.resolve({ data: { entry: { id: 2 } } })),
};
const replyWarningGet = vi.fn();

vi.mock('../services/api', () => ({
  ticketsAPI: new Proxy({}, { get: (_t, prop) => apiOverrides[prop] || pending }),
  assignmentAPI: new Proxy({}, { get: () => pending }),
  agentAPI: new Proxy({}, { get: () => pending }),
  replyWarningAPI: { get: (...args) => replyWarningGet(...args) },
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
import { resetReplyWarningCache } from '../components/tickets/replyWarning';

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

const warningData = (kind) => ({ success: true, data: { kind, unattended: kind === 'unattended', machineSender: kind === 'machine_sender' ? 'noreply' : null } });

describe('TicketDetail — the reply box warns when the requester does not read replies', () => {
  beforeEach(() => {
    localStorage.clear();
    resetReplyWarningCache();
    replyWarningGet.mockReset();
    apiOverrides.reply.mockClear();
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: BASE }));
  });
  afterEach(() => cleanup());

  test('a machine sender: the line shows in reply mode only, and the reply still sends', async () => {
    replyWarningGet.mockResolvedValue(warningData('machine_sender'));
    renderPage();
    await screen.findByRole('region', { name: 'Ticket description' });
    // Note mode (the default): no line, but the check has already been asked once.
    await waitFor(() => expect(replyWarningGet).toHaveBeenCalledWith(501));
    expect(screen.queryByTestId('reply-audience-warning')).not.toBeInTheDocument();

    await openReply();
    expect(await screen.findByTestId('reply-audience-warning')).toHaveTextContent('This address doesn’t read replies (it’s an automated sender). Add a private note instead, or reply to a person in Cc.');

    fireEvent.change(screen.getByRole('textbox', { name: 'Reply body' }), { target: { value: 'Acknowledged.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(apiOverrides.reply).toHaveBeenCalledTimes(1));
    expect(replyWarningGet).toHaveBeenCalledTimes(1);
  });

  test('an unattended requester: the automated-system line, from the ticket itself', async () => {
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: { ...BASE, requester: { ...BASE.requester, email: 'soc@example.com', unattended: true } } }));
    renderPage();
    await openReply();
    expect(screen.getByTestId('reply-audience-warning')).toHaveTextContent('This requester is an automated system and doesn’t read replies. Add a private note instead.');
    expect(replyWarningGet).not.toHaveBeenCalled();
  });

  test('a normal requester: no line', async () => {
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: { ...BASE, requester: { id: 41, name: 'Eli Park', email: 'eli.park@example.com', unattended: false } } }));
    replyWarningGet.mockResolvedValue(warningData(null));
    renderPage();
    await openReply();
    await waitFor(() => expect(replyWarningGet).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('reply-audience-warning')).not.toBeInTheDocument();
  });
});
