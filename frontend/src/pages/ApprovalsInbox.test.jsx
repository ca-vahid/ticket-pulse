/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { formatDayTime, timeAgo } from '../components/tickets/ticketUi';

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

describe('ApprovalsInbox (Phase B + E)', () => {
  afterEach(() => { cleanup(); roleState.role = 'viewer'; });

  test('subtitle marks approvals as a Ticket Pulse feature not synced to FreshService', async () => {
    renderPage();
    expect(await screen.findByText(/A Ticket Pulse feature — not synced to FreshService/i)).toBeInTheDocument();
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

  test('All approvals (QA 09-16 #4): filter bar drives the overview query — search, status tile, sort, more filters', async () => {
    roleState.role = 'reviewer';
    apiOverrides.approvalsOverview = vi.fn(() => Promise.resolve({
      stats: { pending: 1, info_requested: 0, approved: 27, rejected: 2, cancelled: 19 },
      items: [{ id: 5, ticketId: 9, displayRef: '#228440', subject: 'New Computer/Improving Speeds', status: 'approved', categoryName: 'New Computer Upgrade', approverName: 'Reza Zaim', approverEmail: 'rzaim@x.io', requestedBy: 'mblackstock@x.io', createdAt, decidedAt: createdAt, tier: 1, tierCount: 1, decisionNote: null }],
    }));
    renderPage('/approvals?tab=all');
    await screen.findByText('New Computer/Improving Speeds');
    expect(screen.getByTestId('approvals-filters')).toBeInTheDocument();
    // status tile = one-click filter
    fireEvent.click(screen.getByRole('button', { name: /27\s*Approved/ }));
    await waitFor(() => expect(apiOverrides.approvalsOverview).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'approved' })));
    // more filters: approver + dates
    fireEvent.click(screen.getByRole('button', { name: /More filters/ }));
    fireEvent.change(screen.getByLabelText('Approver'), { target: { value: 'reza' } });
    fireEvent.change(await screen.findByLabelText('Requested from'), { target: { value: '2026-09-01' } });
    await waitFor(() => expect(apiOverrides.approvalsOverview).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'approved', approver: 'reza', from: '2026-09-01' })));
    // export is offered for the filtered set
    expect(screen.getByRole('button', { name: /Export CSV/ })).not.toBeDisabled();
    // clear
    fireEvent.click(screen.getByRole('button', { name: /Clear filters/ }));
    await waitFor(() => expect(apiOverrides.approvalsOverview).toHaveBeenLastCalledWith({}));
  });

  test('pending rows show "absolute · relative" timestamps (QA 08-14 #3)', async () => {
    renderPage();
    await screen.findByText('New laptop for Rita');
    expect(screen.getByText(`${formatDayTime(createdAt)} · ${timeAgo(createdAt)}`)).toBeInTheDocument();
    expect(timeAgo(createdAt)).toBe('3h ago'); // sanity: relative half is real
  });
});
