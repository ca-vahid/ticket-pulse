/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// QA 09-25 item 6: "Forward to <team>" in the More menu — only for enabled
// teams with an address; confirm with a note, forward, then offer
// "Resolve as forwarded" (TP-born).

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
  requesterId: 40,
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
const NATIVE = { ...BASE, origin: 'ticketpulse', freshserviceTicketId: null, nativeNumber: 1042, displayRef: 'TP-1042' };

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
  update: vi.fn(() => Promise.resolve({ data: {} })),
  fsUpdate: vi.fn(() => Promise.resolve({ data: { synced: ['subject'] } })),
  requesterSearch: vi.fn(() => Promise.resolve({ data: { requesters: [{ id: 41, name: 'Nadia New', email: 'nadia@example.com', jobTitle: 'Analyst' }], directory: [] } })),
  requesterPhoto: vi.fn(() => Promise.resolve({ data: { photo: null } })),
  requesterStats: vi.fn(() => Promise.resolve({ data: { total: 3 } })),
  forward: vi.fn(() => Promise.resolve({ data: { sent: true } })),
  note: vi.fn(() => Promise.resolve({ data: {} })),
  setStatus: vi.fn(() => Promise.resolve({ data: {} })),
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
vi.mock('../components/tickets/RequestApprovalModal', () => ({ default: () => null }));
vi.mock('../components/tickets/MergeTicketsModal', () => ({ default: () => <div data-testid="merge-modal" /> }));
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
const ready = () => { renderPage(); return screen.findByRole('region', { name: 'Ticket description' }); };

const DS = { id: 1, label: 'Digital Solutions Team', email: 'ds@example.com' };
const openMore = async () => {
  await ready();
  fireEvent.click(screen.getByTestId('more-actions'));
  return screen.findByTestId('more-actions-menu');
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  apiOverrides.get = vi.fn(() => Promise.resolve({ data: NATIVE }));
  apiOverrides.meta = vi.fn(() => Promise.resolve({ data: { ...META, forwardAvailable: true, teamForwards: [DS] } }));
});
afterEach(() => cleanup());

describe('Forward to a team (QA 09-25 item 6)', () => {
  test('the More menu offers the team; forwarding sends to its inbox with the note', async () => {
    const menu = await openMore();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Forward to Digital Solutions Team/ }));
    const dialog = await screen.findByTestId('team-forward-dialog');
    fireEvent.change(within(dialog).getByLabelText(/Note/), { target: { value: 'Power Apps form bug' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Forward' }));
    await waitFor(() => expect(apiOverrides.forward).toHaveBeenCalledWith(501, { to: ['ds@example.com'], note: 'Power Apps form bug' }));

    fireEvent.click(await within(dialog).findByRole('button', { name: 'Resolve as forwarded' }));
    await waitFor(() => expect(apiOverrides.note).toHaveBeenCalledWith(501, expect.objectContaining({
      bodyText: expect.stringContaining('Forwarded to Digital Solutions Team (ds@example.com)'),
    })));
    await waitFor(() => expect(apiOverrides.setStatus).toHaveBeenCalledWith(501, 'Resolved'));
    // The note goes in only after the resolve landed.
    await waitFor(() => expect(apiOverrides.note).toHaveBeenCalled());
    expect(apiOverrides.setStatus.mock.invocationCallOrder[0]).toBeLessThan(apiOverrides.note.mock.invocationCallOrder[0]);
  });

  test('Enter in the note is a new line; Ctrl+Enter forwards', async () => {
    const menu = await openMore();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Forward to Digital Solutions Team/ }));
    const dialog = await screen.findByTestId('team-forward-dialog');
    const note = within(dialog).getByLabelText(/Note/);
    fireEvent.keyDown(note, { key: 'Enter' });
    expect(apiOverrides.forward).not.toHaveBeenCalled();
    fireEvent.keyDown(note, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(apiOverrides.forward).toHaveBeenCalledTimes(1));
  });

  test('a failed resolve writes no note and keeps the dialog open', async () => {
    apiOverrides.setStatus = vi.fn(() => Promise.reject(new Error('Nope')));
    const menu = await openMore();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Forward to Digital Solutions Team/ }));
    const dialog = await screen.findByTestId('team-forward-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Forward' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Resolve as forwarded' }));
    await waitFor(() => expect(apiOverrides.setStatus).toHaveBeenCalled());
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Resolve as forwarded' })).not.toBeDisabled());
    expect(apiOverrides.note).not.toHaveBeenCalled();
    expect(screen.getByTestId('team-forward-dialog')).toBeInTheDocument();
    apiOverrides.setStatus = vi.fn(() => Promise.resolve({ data: {} }));
  });

  test('cancelling the resolution-reason prompt writes no note', async () => {
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: { ...NATIVE, internalCategory: { id: 9, name: 'Security' } } }));
    const menu = await openMore();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Forward to Digital Solutions Team/ }));
    const dialog = await screen.findByTestId('team-forward-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Forward' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Resolve as forwarded' }));
    // The reason prompt takes over; the forward dialog steps aside.
    const closeReason = await screen.findByRole('button', { name: 'Close dialog' });
    expect(dialog).toHaveClass('hidden');
    fireEvent.click(closeReason);
    await waitFor(() => expect(dialog).not.toHaveClass('hidden'));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Resolve as forwarded' })).not.toBeDisabled());
    expect(apiOverrides.setStatus).not.toHaveBeenCalled();
    expect(apiOverrides.note).not.toHaveBeenCalled();
  });

  test('hidden when no team has an address', async () => {
    apiOverrides.meta = vi.fn(() => Promise.resolve({ data: { ...META, forwardAvailable: true, teamForwards: [{ id: 2, label: 'No inbox', email: null }] } }));
    const menu = await openMore();
    expect(within(menu).queryByTestId('team-forward-item')).not.toBeInTheDocument();
  });

  test('hidden when the workspace cannot send mail', async () => {
    apiOverrides.meta = vi.fn(() => Promise.resolve({ data: { ...META, forwardAvailable: false, teamForwards: [DS] } }));
    const menu = await openMore();
    expect(within(menu).queryByTestId('team-forward-item')).not.toBeInTheDocument();
  });
});
