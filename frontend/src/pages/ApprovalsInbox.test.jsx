/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
vi.mock('../components/nav/navDestinations', () => ({
  useWorkspaceRole: () => 'member',
}));
vi.mock('../components/AppHeader', () => ({ default: () => <div>AppHeader</div> }));
vi.mock('../components/nav/MobileTabBar', () => ({ default: () => null }));

import ApprovalsInbox from './ApprovalsInbox';

const renderPage = () => render(
  <MemoryRouter initialEntries={['/approvals']}>
    <ApprovalsInbox />
  </MemoryRouter>,
);

describe('ApprovalsInbox (Phase B + E)', () => {
  afterEach(() => cleanup());

  test('subtitle marks approvals as a Ticket Pulse feature not synced to FreshService', async () => {
    renderPage();
    expect(await screen.findByText(/A Ticket Pulse feature — not synced to FreshService/i)).toBeInTheDocument();
  });

  test('pending rows show "absolute · relative" timestamps (QA 08-14 #3)', async () => {
    renderPage();
    await screen.findByText('New laptop for Rita');
    expect(screen.getByText(`${formatDayTime(createdAt)} · ${timeAgo(createdAt)}`)).toBeInTheDocument();
    expect(timeAgo(createdAt)).toBe('3h ago'); // sanity: relative half is real
  });
});
