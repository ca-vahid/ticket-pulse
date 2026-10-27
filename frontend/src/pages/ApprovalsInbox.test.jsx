/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { formatDayTime } from '../components/tickets/ticketUi';
import { resolveWhen } from '../components/common/WhenFilter';

// Phase B + E (QA 08-11 #4, 08-14 #3): the inbox subtitle names approvals as a
// Ticket Pulse-only feature, and row timestamps follow "absolute · relative".

const createdAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3h ago
const pendingRow = {
  id: 11, ticketId: 501, displayRef: 'TP-77', subject: 'New laptop for Rita',
  categoryName: 'Hardware purchase', requestedBy: 'req@x.io', requesterName: null,
  requestNote: null, createdAt,
};

const apiOverrides = {
  approvalInbox: vi.fn(() => Promise.resolve([pendingRow])),
  approvalsNeedingMyInfo: vi.fn(() => Promise.resolve([])),
  approvalsOverview: vi.fn(() => Promise.resolve({ stats: {}, items: [] })),
};
const pending = () => new Promise(() => {});
vi.mock('../services/api', () => ({
  ticketsAPI: new Proxy({}, { get: (_t, prop) => apiOverrides[prop] || pending }),
}));
vi.mock('../hooks/useSSE', () => ({ useSSE: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { email: 'vahid@x.io', name: 'Vahid Haeri' } }) }));
vi.mock('../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspace: { id: 1, name: 'IT' }, isWorkspaceSelected: true }),
}));
const roleState = { role: 'viewer' };
vi.mock('../components/nav/navDestinations', () => ({
  useWorkspaceRole: () => roleState.role,
}));
vi.mock('../components/AppHeader', () => ({ default: () => <div>AppHeader</div> }));
vi.mock('../components/nav/MobileTabBar', () => ({ default: () => null }));
// The Categories tab mounts the SAME panel Settings does (one component, two
// mount points) — its own behavior is covered by ApprovalCategoriesPanel.test.
vi.mock('../components/settings/ApprovalCategoriesPanel', () => ({
  default: () => <div data-testid="approval-categories-panel">ApprovalCategoriesPanel</div>,
}));

import ApprovalsInbox from './ApprovalsInbox';

const renderPage = (path = '/approvals') => render(
  <MemoryRouter initialEntries={[path]}>
    <ApprovalsInbox />
  </MemoryRouter>,
);

describe('ApprovalsInbox (Phase B + E; 1B · 2A · 3B redesign 27 Oct 2026)', () => {
  afterEach(() => { cleanup(); roleState.role = 'viewer'; });

  test('requests I asked about stay on For you under "Waiting on an answer", still decidable, no quick approve; the Latest column says what is out (27 Oct 2026)', async () => {
    apiOverrides.approvalsWaitingOnAnswer = vi.fn(() => Promise.resolve([
      { ...pendingRow, id: 12, subject: 'Claude AI', displayRef: 'TP-10518', status: 'info_requested', waitingSince: createdAt, latest: { kind: 'question', authorEmail: 'vahid@x.io', authorName: 'Vahid Haeri', at: createdAt } },
      { ...pendingRow, id: 13, subject: 'Firewall change', displayRef: 'TP-10600', status: 'info_requested', requestedByName: 'Anton K', conditions: { items: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }], submittedAt: null } },
    ]));
    try {
      renderPage();
      const section = await screen.findByTestId('waiting-section');
      expect(section).toHaveTextContent('Waiting on an answer');
      expect(section).toHaveTextContent('2');
      expect(section).toHaveTextContent('Claude AI');
      expect(section).toHaveTextContent('You asked · no answer yet');
      expect(section).toHaveTextContent('Waiting on Anton’s answers');
      expect(section.querySelectorAll('[data-testid="approval-status"]')[0]).toHaveTextContent('Needs info');
      expect(section).not.toHaveTextContent('Quick approve');
      // the pending row above keeps its quick approve
      expect(screen.getAllByText('Quick approve')).toHaveLength(1);
    } finally {
      delete apiOverrides.approvalsWaitingOnAnswer;
    }
  });

  test('subtitle marks approvals as a Ticket Pulse feature not synced to FreshService; the header counts what is waiting', async () => {
    renderPage();
    expect(await screen.findByText(/A Ticket Pulse feature — not synced to FreshService/i)).toBeInTheDocument();
    // the counts fill in once the lists have loaded
    await screen.findByText('New laptop for Rita');
    await waitFor(() => expect(screen.getByTestId('approvals-hero')).toHaveTextContent('1 to decide · 0 waiting on an answer'));
  });

  test('reviewer gets a Categories tab that mounts ApprovalCategoriesPanel (v3.7.02 RM1)', async () => {
    roleState.role = 'reviewer';
    renderPage();
    await screen.findByText('New laptop for Rita');
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent.trim());
    expect(tabs).toEqual(['For you', 'All approvals', 'Categories']);
    expect(screen.queryByTestId('approval-categories-panel')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Categories/ }));
    expect(screen.getByRole('tab', { name: /Categories/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('approval-categories-panel')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Approval categories' })).toBeInTheDocument();
  });

  test('the selected tab is underlined in the primary colour, the others are plain (no boxed tabs)', async () => {
    roleState.role = 'reviewer';
    renderPage();
    await screen.findByText('New laptop for Rita');
    expect(screen.getByRole('tab', { name: /For you/ })).toHaveClass('border-b-2', 'border-primary');
    expect(screen.getByRole('tab', { name: /All approvals/ })).toHaveClass('border-transparent');
    fireEvent.click(screen.getByRole('tab', { name: /All approvals/ }));
    expect(screen.getByRole('tab', { name: /All approvals/ })).toHaveClass('border-primary');
  });

  test('admins get the Categories tab too, and ?tab=categories deep-links straight to it', async () => {
    roleState.role = 'admin';
    renderPage('/approvals?tab=categories');
    expect(await screen.findByTestId('approval-categories-panel')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Categories/ })).toHaveAttribute('aria-selected', 'true');
  });

  test('viewers get no tabs at all — no Categories, no All approvals (read-only inbox)', async () => {
    roleState.role = 'viewer';
    renderPage('/approvals?tab=categories');
    await screen.findByText('New laptop for Rita');
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByTestId('approval-categories-panel')).not.toBeInTheDocument();
  });

  test('All approvals (3B): one table with asked / decided / took; the filter bar drives the overview query — search, status counts + menu (several at once), approver, When presets', async () => {
    roleState.role = 'reviewer';
    const asked = '2026-10-23T19:03:00Z';
    const decidedAt = '2026-10-23T19:54:00Z';
    apiOverrides.approvalsOverview = vi.fn(() => Promise.resolve({
      stats: { pending: 1, info_requested: 0, approved: 27, rejected: 2, cancelled: 19 },
      items: [{ id: 5, ticketId: 9, displayRef: '#228440', subject: 'New Computer/Improving Speeds', status: 'approved', categoryName: 'New Computer Upgrade', approverName: 'Reza Zaim', approverEmail: 'rzaim@x.io', requestedBy: 'mblackstock@x.io', requesterName: 'Marcus Blackstock', createdAt: asked, decidedAt, tier: 1, tierCount: 1, decisionNote: null }],
    }));
    renderPage('/approvals?tab=all');
    await screen.findByText('New Computer/Improving Speeds');
    expect(screen.getByTestId('approvals-filters')).toBeInTheDocument();
    const row = screen.getByTestId('approval-row');
    expect(row).toHaveTextContent('Approved');
    expect(row).toHaveTextContent('Reza Zaim');
    expect(row).toHaveTextContent(formatDayTime(asked));
    expect(row).toHaveTextContent(formatDayTime(decidedAt));
    expect(row).toHaveTextContent('51 m');
    // the ticket number links to the ticket's Approvals tab
    expect(screen.getByRole('link', { name: 'Open ticket #228440' })).toHaveAttribute('href', '/tickets/9?tab=approvals');
    // status counts = one-click toggles; two on = comma-joined
    fireEvent.click(screen.getByRole('button', { name: /27\s*Approved/ }));
    await waitFor(() => expect(apiOverrides.approvalsOverview).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'approved' })));
    fireEvent.click(screen.getByRole('button', { name: /2\s*Not approved/ }));
    await waitFor(() => expect(apiOverrides.approvalsOverview).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'approved,rejected' })));
    // the status menu shows the same choice with counts, and unticks one
    fireEvent.click(screen.getByRole('button', { name: /^Status: 2 statuses/ }));
    const approvedOpt = screen.getByRole('option', { name: /Approved\s*27/ });
    expect(approvedOpt).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(approvedOpt);
    await waitFor(() => expect(apiOverrides.approvalsOverview).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'rejected' })));
    // approver is typed straight into the bar
    fireEvent.change(screen.getByLabelText('Approver'), { target: { value: 'reza' } });
    await waitFor(() => expect(apiOverrides.approvalsOverview).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'rejected', approver: 'reza' })));
    // When: one control, presets resolve to from / to
    fireEvent.click(screen.getByRole('button', { name: /^When: Any time/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Last 30 days' }));
    const { from, to } = resolveWhen('30d');
    await waitFor(() => expect(apiOverrides.approvalsOverview).toHaveBeenLastCalledWith(expect.objectContaining({ approver: 'reza', from, to })));
    expect(screen.getByRole('button', { name: /^When: Last 30 days/ })).toBeInTheDocument();
    // export is offered for the filtered set
    expect(screen.getByRole('button', { name: /Export CSV/ })).not.toBeDisabled();
    // clear
    fireEvent.click(screen.getByRole('button', { name: /Clear filters/ }));
    await waitFor(() => expect(apiOverrides.approvalsOverview).toHaveBeenLastCalledWith({}));
  });

  test('For you (1B): the whole row opens it, Quick approve asks first, no Ask / Escalate / Forward until it opens; the ticket number is a link', async () => {
    renderPage();
    await screen.findByText('New laptop for Rita');
    expect(screen.getByTestId('for-you-table')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Quick approve/ }));
    expect(await screen.findByText('Approve this request?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    expect(screen.getByTestId('approval-status')).toHaveTextContent('Pending');
    expect(screen.queryByRole('button', { name: /Escalate|Forward|^Ask/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open ticket TP-77' })).toHaveAttribute('href', '/tickets/501?tab=approvals');
    expect(screen.getByRole('link', { name: 'Open ticket TP-77' })).toHaveTextContent('TP-77');
  });

  test('Latest says who answered and when, in the accent colour, when it was not me (Phillip, 27 Oct 2026)', async () => {
    const at = '2026-10-27T14:09:10Z';
    apiOverrides.approvalInbox = vi.fn(() => Promise.resolve([{ ...pendingRow, latest: { kind: 'answer', authorEmail: 'phillip@x.io', authorName: 'Phillip Crispell', at } }]));
    try {
      renderPage();
      const latest = (await screen.findAllByTestId('approval-latest'))[0];
      expect(latest).toHaveTextContent('Phillip answered');
      expect(latest).toHaveTextContent(formatDayTime(at));
      expect(latest.querySelector('.text-primary')).not.toBeNull();
    } finally {
      apiOverrides.approvalInbox = vi.fn(() => Promise.resolve([pendingRow]));
    }
  });

  test('2A: opening a row shows the whole conversation, newest last, beside the decision; the note opens full screen', async () => {
    apiOverrides.approvalInbox = vi.fn(() => Promise.resolve([{ ...pendingRow, requestGroupId: 'g1', requestNote: 'Request for Claude AI', requestedByName: 'Alexey L', approverEmail: 'vahid@x.io' }]));
    apiOverrides.approvalMessages = vi.fn(() => Promise.resolve({ data: [
      { id: 74, kind: 'question', audience: 'requester', requestGroupId: 'g1', approvalId: 11, author: { email: 'vahid@x.io', name: 'Vahid Haeri', role: 'approver' }, bodyText: 'Could ChatGPT do it?', to: ['phillip@x.io'], cc: [], createdAt: '2026-10-27T02:33:19Z' },
      { id: 85, kind: 'answer', audience: 'requester', requestGroupId: 'g1', approvalId: 11, author: { email: 'phillip@x.io', name: 'Phillip Crispell', role: 'requester' }, bodyText: 'Sounds like ChatGPT would be fine for my needs.', to: ['vahid@x.io'], cc: [], inReplyToId: 74, createdAt: '2026-10-27T14:09:10Z' },
      { id: 99, kind: 'question', audience: 'internal', requestGroupId: 'other', approvalId: 40, author: { email: 'x@x.io', name: 'Someone' }, bodyText: 'Another request entirely', to: [], cc: [], createdAt: '2026-10-27T15:00:00Z' },
    ] }));
    try {
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: /^Open New laptop for Rita/ }));
      const convo = await screen.findByTestId('request-conversation');
      await waitFor(() => expect(convo).toHaveTextContent('Sounds like ChatGPT would be fine for my needs.'));
      expect(convo).toHaveTextContent('Request for Claude AI');
      expect(convo).toHaveTextContent('Could ChatGPT do it?');
      expect(convo).not.toHaveTextContent('Another request entirely');
      expect(convo.querySelector('[data-latest="true"]')).toHaveTextContent('Phillip Crispell');
      expect(screen.getByTestId('approval-choices')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Close New laptop for Rita/ })).toHaveAttribute('aria-expanded', 'true');
      // full screen: the same composer as a dialog, with a way back
      fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toContainElement(screen.getByTestId('composer-fullscreen-header'));
      expect(dialog).toHaveTextContent('New laptop for Rita');
      expect(dialog).toContainElement(screen.getByTestId('approval-choices'));
      fireEvent.keyDown(dialog, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    } finally {
      apiOverrides.approvalInbox = vi.fn(() => Promise.resolve([pendingRow]));
      delete apiOverrides.approvalMessages;
    }
  });

  test('rows say how long a request has been open, and "Requested" with its time when nothing has happened since', async () => {
    renderPage();
    await screen.findByText('New laptop for Rita');
    const row = screen.getByTestId('inbox-row');
    expect(row).toHaveTextContent('3 h');
    expect(screen.getByTestId('approval-latest')).toHaveTextContent(`Requested${formatDayTime(createdAt)}`);
  });
});
