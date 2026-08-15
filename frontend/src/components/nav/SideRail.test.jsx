/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SideRail from './SideRail';

const authState = { user: { email: 'me@x.com', role: 'admin' } };
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => authState }));
vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({
    currentWorkspace: { id: 1 },
    availableWorkspaces: [{ id: 1, role: 'admin' }],
  }),
}));

const approvalCount = vi.fn(() => 0);
vi.mock('../../hooks/useApprovalCount', () => ({ useApprovalCount: () => approvalCount() }));

afterEach(() => {
  cleanup();
  authState.user = { email: 'me@x.com', role: 'admin' };
  approvalCount.mockReturnValue(0);
});

function renderRail(path = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SideRail />
    </MemoryRouter>,
  );
}

describe('SideRail', () => {
  test('renders every destination plus Settings for an admin', () => {
    renderRail();
    for (const label of ['Dashboard', 'Tickets', 'Timeline', 'Analytics', 'Assignment', 'Mail Workflows', 'Agent Maps', 'Approvals', 'Settings']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  test('marks the current route with aria-current', () => {
    renderRail('/tickets/42');
    expect(screen.getByRole('button', { name: /Tickets/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: /Dashboard/ })).not.toHaveAttribute('aria-current');
  });

  test('marks Settings active on /settings', () => {
    renderRail('/settings');
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
  });

  test('agents only see Tickets and Approvals', () => {
    authState.user = { email: 'agent@x.com', role: 'agent' };
    renderRail('/tickets');
    expect(screen.getByRole('button', { name: /Tickets/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Approvals/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Analytics/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mail Workflows/ })).not.toBeInTheDocument();
  });

  test('agents get no Settings entry (Phase A1 — no sections exist for them)', () => {
    authState.user = { email: 'agent@x.com', role: 'agent' };
    renderRail('/tickets');
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
  });

  test('tickets pages show the full rail by default with a collapse control (QA 07-13 #6)', () => {
    localStorage.removeItem('tp_ticketsRailCollapsed');
    renderRail('/tickets/42');
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).not.toHaveClass('tp-side-rail--peek');
    expect(screen.getByTitle(/Collapse the navigation/i)).toBeInTheDocument();
    cleanup();
    renderRail('/dashboard');
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).not.toHaveClass('tp-side-rail--peek');
    expect(screen.queryByTitle(/Collapse the navigation/i)).not.toBeInTheDocument();
  });

  test('a persisted collapse preference restores peek mode on tickets pages', () => {
    localStorage.setItem('tp_ticketsRailCollapsed', 'true');
    renderRail('/tickets/42');
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toHaveClass('tp-side-rail--peek');
    localStorage.removeItem('tp_ticketsRailCollapsed');
  });

  test('shows the pending-approvals badge when the count is positive', () => {
    approvalCount.mockReturnValue(4);
    renderRail();
    expect(screen.getByText('4')).toBeInTheDocument();
  });
});
