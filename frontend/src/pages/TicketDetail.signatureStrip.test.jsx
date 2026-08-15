/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Mega 08-15 Phase D — the composer signature strip is REPLY-mode only:
// internal notes and forwards never carry a signature, so the strip must not
// even hint at one there. Read-only by design (appended server-side at send).

const TICKET = {
  id: 501,
  origin: 'ticketpulse',
  nativeNumber: 1042,
  displayRef: 'TP-1042',
  subject: 'Laptop will not boot',
  description: '<p>Black screen</p>',
  descriptionText: 'Black screen',
  status: 'Open',
  priority: 3,
  ticketType: 'Incident',
  createdAt: '2026-08-15T10:00:00Z',
  updatedAt: '2026-08-15T10:05:00Z',
  lastActivityAt: '2026-08-15T10:05:00Z',
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
  get: vi.fn(() => Promise.resolve({ data: TICKET })),
  meta: vi.fn(() => Promise.resolve({ data: META })),
};
const getMySignature = vi.fn();

vi.mock('../services/api', () => ({
  ticketsAPI: new Proxy({}, { get: (_t, prop) => apiOverrides[prop] || pending }),
  assignmentAPI: new Proxy({}, { get: () => pending }),
  agentAPI: { getMySignature: (...args) => getMySignature(...args) },
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
vi.mock('../components/tickets/RichTextEditor', async () => {
  const { forwardRef } = await import('react');
  return {
    default: forwardRef(({ ariaLabel }, _ref) => <textarea aria-label={ariaLabel || 'editor'} />),
    isRichContent: () => false,
  };
});

import TicketDetail from './TicketDetail';
import { clearSignatureStripCache } from '../components/tickets/ComposerSignatureStrip';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/tickets/501']}>
      <Routes>
        <Route path="/tickets/:id" element={<TicketDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

const STRIP_TEXT = /your signature will be appended/i;

describe('TicketDetail composer signature strip (Phase D)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    clearSignatureStripCache();
    getMySignature.mockResolvedValue({
      data: { enabled: true, exists: true, html: '<p><strong>Ana</strong></p>', text: 'Ana' },
    });
  });
  afterEach(() => cleanup());

  test('reply mode only: hidden on notes, shown (read-only, expandable) on replies', async () => {
    renderPage();
    await screen.findByRole('region', { name: 'Ticket description' });

    // Default mode is internal note — no strip, and the signature is NOT in
    // the editor either (never seeded).
    expect(screen.queryByText(STRIP_TEXT)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /reply\s?to requester/i }));
    expect(await screen.findByText(STRIP_TEXT)).toBeInTheDocument();
    expect(getMySignature).toHaveBeenCalledWith({ workspaceId: 1 });
    // The editable area stays empty — the signature is preview-only.
    expect(screen.getByRole('textbox', { name: 'Reply body' })).toHaveValue('');

    fireEvent.click(screen.getByText(STRIP_TEXT).closest('button'));
    expect(screen.getByTestId('composer-signature-preview')).toBeInTheDocument();

    // Back to note mode: strip goes away.
    fireEvent.click(screen.getByRole('button', { name: /internal note/i }));
    expect(screen.queryByText(STRIP_TEXT)).not.toBeInTheDocument();
  });

  test('no strip when the user has no enabled signature', async () => {
    getMySignature.mockResolvedValue({ data: { enabled: false, exists: false, html: '', text: '' } });
    renderPage();
    await screen.findByRole('region', { name: 'Ticket description' });

    fireEvent.click(screen.getByRole('button', { name: /reply\s?to requester/i }));
    await waitFor(() => expect(getMySignature).toHaveBeenCalled());
    expect(screen.queryByText(STRIP_TEXT)).not.toBeInTheDocument();
  });
});
