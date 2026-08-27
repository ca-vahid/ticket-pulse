/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// v3.7.02 role lockdown (QA 08-24 #3): the phone tab bar follows the same
// destination filter as the SideRail — viewers/reviewers get Tickets +
// Approvals and a sane "More" sheet with no Settings row.

const authState = { user: { email: 'me@x.com', role: 'viewer' }, logout: vi.fn() };
const wsState = {
  currentWorkspace: { id: 1, name: 'IT' },
  availableWorkspaces: [{ id: 1, name: 'IT', role: 'viewer' }],
  switchWorkspace: vi.fn(),
};
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => authState }));
vi.mock('../../contexts/WorkspaceContext', () => ({ useWorkspace: () => wsState }));
vi.mock('../../contexts/DashboardContext', () => ({
  useDashboard: () => ({ lastUpdated: null, sseConnectionStatus: 'connected' }),
}));
vi.mock('../../utils/demoMode', () => ({ useDemoMode: () => false, scrubFreeText: (s) => s }));
vi.mock('../ChangelogModal', () => ({ default: () => null }));
vi.mock('../../data/changelog', () => ({ APP_VERSION: '0.0.0-test' }));

const { default: MobileTabBar } = await import('./MobileTabBar');

afterEach(() => {
  cleanup();
  authState.user = { email: 'me@x.com', role: 'viewer' };
  wsState.availableWorkspaces = [{ id: 1, name: 'IT', role: 'viewer' }];
});

const renderBar = (path = '/tickets') => render(
  <MemoryRouter initialEntries={[path]}>
    <MobileTabBar />
  </MemoryRouter>,
);

const tabLabels = () => within(screen.getByRole('navigation')).getAllByRole('button').map((b) => b.textContent.trim());

describe('MobileTabBar', () => {
  test.each(['viewer', 'reviewer'])('%s: Tickets + Approvals tabs, More sheet without Settings', (role) => {
    wsState.availableWorkspaces = [{ id: 1, name: 'IT', role }];
    renderBar();
    expect(tabLabels()).toEqual(['Tickets', 'Approvals', 'More']);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const sheet = screen.getByRole('dialog', { name: 'More navigation' });
    expect(within(sheet).queryByText('Settings')).not.toBeInTheDocument();
    expect(within(sheet).queryByText('Dashboard')).not.toBeInTheDocument();
    expect(within(sheet).queryByText('Analytics')).not.toBeInTheDocument();
    // Personal pages stay for everyone.
    expect(within(sheet).getByText('My Skills')).toBeInTheDocument();
    expect(within(sheet).getByText('Notifications')).toBeInTheDocument();
    expect(within(sheet).getByText('Sign out')).toBeInTheDocument();
  });

  test('workspace admin: four primary tabs, the rest + Settings in More', () => {
    wsState.availableWorkspaces = [{ id: 1, name: 'IT', role: 'admin' }];
    renderBar('/dashboard');
    expect(tabLabels()).toEqual(['Dashboard', 'Tickets', 'Timeline', 'Analytics', 'More']);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const sheet = screen.getByRole('dialog', { name: 'More navigation' });
    for (const label of ['Assignment', 'Mail Workflows', 'Agent Maps', 'Approvals', 'Settings']) {
      expect(within(sheet).getByText(label)).toBeInTheDocument();
    }
  });

  test('unresolved role fails closed to the ticket surface', () => {
    wsState.availableWorkspaces = [];
    renderBar();
    expect(tabLabels()).toEqual(['Tickets', 'Approvals', 'More']);
  });

  test('agents unchanged: Tickets + Approvals, no Settings', () => {
    authState.user = { email: 'tech@x.com', role: 'agent' };
    wsState.availableWorkspaces = [{ id: 1, name: 'IT', role: 'agent' }];
    renderBar();
    expect(tabLabels()).toEqual(['Tickets', 'Approvals', 'More']);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(within(screen.getByRole('dialog')).queryByText('Settings')).not.toBeInTheDocument();
  });
});
