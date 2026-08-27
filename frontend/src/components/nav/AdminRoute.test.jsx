/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

// v3.7.02 role lockdown (QA 08-24 #3): the route gate behind every page
// beyond Tickets/Approvals. Viewers, reviewers and agents bounce to /tickets;
// admins render; nobody is bounced before the workspace list has hydrated.

const authState = { user: { email: 'me@x.com', role: 'viewer' }, isAuthenticated: true, isLoading: false };
const wsState = {
  currentWorkspace: { id: 1 },
  availableWorkspaces: [{ id: 1, role: 'viewer' }],
  isWorkspaceSelected: true,
  isHydrated: true,
};
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => authState }));
vi.mock('../../contexts/WorkspaceContext', () => ({ useWorkspace: () => wsState }));

const { default: AdminRoute } = await import('./AdminRoute');
const { ACCESS_BOUNCE_KEY } = await import('./navDestinations');

function Probe({ label }) {
  const location = useLocation();
  return <div data-testid="probe">{label}@{location.pathname}</div>;
}

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/dashboard" element={<AdminRoute><Probe label="dashboard" /></AdminRoute>} />
      <Route path="/settings" element={<AdminRoute><Probe label="settings" /></AdminRoute>} />
      <Route path="/tickets" element={<Probe label="tickets" />} />
      <Route path="/login" element={<Probe label="login" />} />
      <Route path="/workspace" element={<Probe label="workspace" />} />
    </Routes>
  </MemoryRouter>,
);

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  Object.assign(authState, { user: { email: 'me@x.com', role: 'viewer' }, isAuthenticated: true, isLoading: false });
  Object.assign(wsState, { availableWorkspaces: [{ id: 1, role: 'viewer' }], isWorkspaceSelected: true, isHydrated: true });
});

describe('AdminRoute', () => {
  test.each(['viewer', 'reviewer'])('%s at /dashboard is bounced to /tickets (and the bounce is recorded once)', (role) => {
    wsState.availableWorkspaces = [{ id: 1, role }];
    renderAt('/dashboard');
    expect(screen.getByTestId('probe')).toHaveTextContent('tickets@/tickets');
    expect(sessionStorage.getItem(ACCESS_BOUNCE_KEY)).toBe('/dashboard');
  });

  test('viewer at /settings is bounced to /tickets', () => {
    renderAt('/settings');
    expect(screen.getByTestId('probe')).toHaveTextContent('tickets@/tickets');
  });

  test('workspace admin renders the page', () => {
    wsState.availableWorkspaces = [{ id: 1, role: 'admin' }];
    renderAt('/dashboard');
    expect(screen.getByTestId('probe')).toHaveTextContent('dashboard@/dashboard');
    expect(sessionStorage.getItem(ACCESS_BOUNCE_KEY)).toBeNull();
  });

  test('global admin renders the page even when the workspace list carries no role', () => {
    authState.user = { email: 'root@x.com', role: 'admin' };
    wsState.availableWorkspaces = [{ id: 1 }];
    renderAt('/settings');
    expect(screen.getByTestId('probe')).toHaveTextContent('settings@/settings');
  });

  test('waits on hydration — no flash-bounce for an admin whose role is not known yet', () => {
    wsState.isHydrated = false;
    wsState.availableWorkspaces = [];
    renderAt('/dashboard');
    expect(screen.queryByTestId('probe')).not.toBeInTheDocument();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(sessionStorage.getItem(ACCESS_BOUNCE_KEY)).toBeNull();
  });

  test('signed out → /login; agent → /tickets; no workspace among several → /workspace', () => {
    authState.isAuthenticated = false;
    renderAt('/dashboard');
    expect(screen.getByTestId('probe')).toHaveTextContent('login@/login');
    cleanup();

    Object.assign(authState, { isAuthenticated: true, user: { email: 't@x.com', role: 'agent' } });
    renderAt('/dashboard');
    expect(screen.getByTestId('probe')).toHaveTextContent('tickets@/tickets');
    cleanup();

    Object.assign(authState, { user: { email: 'me@x.com', role: 'viewer' } });
    Object.assign(wsState, { isWorkspaceSelected: false, availableWorkspaces: [{ id: 1, role: 'admin' }, { id: 2, role: 'admin' }] });
    renderAt('/dashboard');
    expect(screen.getByTestId('probe')).toHaveTextContent('workspace@/workspace');
  });
});
