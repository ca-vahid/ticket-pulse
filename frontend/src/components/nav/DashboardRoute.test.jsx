/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

// QA 11-19 item 2: an admin lets one agent see the Dashboard (read only). The
// route gate lets a listed agent in (and waits for the answer instead of
// bouncing), the nav shows the Dashboard tile, and home stays where it was.

const authState = { user: { email: 'dana.fox@example.com', role: 'agent' }, isAuthenticated: true, isLoading: false };
const wsState = {
  currentWorkspace: { id: 1 },
  availableWorkspaces: [{ id: 1, role: 'agent' }],
  isWorkspaceSelected: true,
  isHydrated: true,
};
const mine = vi.fn();
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => authState }));
vi.mock('../../contexts/WorkspaceContext', () => ({ useWorkspace: () => wsState }));
vi.mock('../../services/api', () => ({ dashboardViewersAPI: { mine: (...a) => mine(...a) } }));
vi.mock('../../hooks/useHrLifecycleStatus', () => ({ useHrLifecycleStatus: () => ({ available: false, loading: false }) }));
vi.mock('../../hooks/useUrgentResponseStatus', () => ({ useUrgentResponseStatus: () => ({ visible: false, loading: false }) }));

const { DashboardRoute, ViewRoute } = await import('./AdminRoute');
const { homePathFor, useNavDestinations } = await import('./navDestinations');
const { resetDashboardViewAccess } = await import('../../hooks/useDashboardViewAccess');

function Probe({ label }) {
  const location = useLocation();
  return <div data-testid="probe">{label}@{location.pathname}</div>;
}

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/dashboard" element={<DashboardRoute><Probe label="dashboard" /></DashboardRoute>} />
      <Route path="/technician/:id" element={<DashboardRoute><Probe label="technician" /></DashboardRoute>} />
      <Route path="/timeline" element={<ViewRoute><Probe label="timeline" /></ViewRoute>} />
      <Route path="/tickets" element={<Probe label="tickets" />} />
      <Route path="/login" element={<Probe label="login" />} />
    </Routes>
  </MemoryRouter>,
);

const listed = () => mine.mockResolvedValue({ success: true, data: { dashboard: true, viaGrant: true } });
const unlisted = () => mine.mockResolvedValue({ success: true, data: { dashboard: false, viaGrant: false } });

beforeEach(() => {
  resetDashboardViewAccess();
  mine.mockReset();
  Object.assign(authState, { user: { email: 'dana.fox@example.com', role: 'agent' }, isAuthenticated: true, isLoading: false });
  Object.assign(wsState, { availableWorkspaces: [{ id: 1, role: 'agent' }], isWorkspaceSelected: true, isHydrated: true });
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe('DashboardRoute', () => {
  test('a listed agent waits for the answer, then opens the Dashboard and a technician page', async () => {
    listed();
    renderAt('/dashboard');
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('dashboard@/dashboard'));
    cleanup();
    renderAt('/technician/13');
    expect(screen.getByTestId('probe')).toHaveTextContent('technician@/technician/13');
    // One question per workspace per page load.
    expect(mine).toHaveBeenCalledTimes(1);
  });

  test('an unlisted agent is sent to Tickets', async () => {
    unlisted();
    renderAt('/dashboard');
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('tickets@/tickets'));
  });

  test('a failed answer fails closed', async () => {
    mine.mockRejectedValue(new Error('network'));
    renderAt('/dashboard');
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('tickets@/tickets'));
  });

  test('the grant opens the Dashboard only: Timeline still bounces a listed agent', async () => {
    listed();
    renderAt('/timeline');
    expect(screen.getByTestId('probe')).toHaveTextContent('tickets@/tickets');
  });

  test('a listed Standard member is let in; an unlisted one is bounced with the toast marker', async () => {
    authState.user = { email: 'eli.park@example.com', role: 'viewer' };
    wsState.availableWorkspaces = [{ id: 1, role: 'viewer' }];
    unlisted();
    renderAt('/dashboard');
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('tickets@/tickets'));
    expect(sessionStorage.getItem('tp_accessBounce')).toBe('/dashboard');
    cleanup();
    resetDashboardViewAccess();
    listed();
    renderAt('/dashboard');
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('dashboard@/dashboard'));
  });

  test('admins never ask the server', () => {
    wsState.availableWorkspaces = [{ id: 1, role: 'admin' }];
    authState.user = { email: 'lead@example.com', role: 'viewer' };
    renderAt('/dashboard');
    expect(screen.getByTestId('probe')).toHaveTextContent('dashboard@/dashboard');
    expect(mine).not.toHaveBeenCalled();
  });
});

describe('nav and home for a listed agent', () => {
  test('the Dashboard tile appears for a listed agent, not for an unlisted one', async () => {
    listed();
    const { result } = renderHook(() => useNavDestinations());
    await waitFor(() => expect(result.current.map((d) => d.id)).toContain('dashboard'));
    expect(result.current.map((d) => d.id)).not.toContain('timeline');
    expect(result.current.map((d) => d.id)).not.toContain('analytics');

    resetDashboardViewAccess();
    unlisted();
    const again = renderHook(() => useNavDestinations());
    await waitFor(() => expect(mine).toHaveBeenCalledTimes(2));
    expect(again.result.current.map((d) => d.id)).not.toContain('dashboard');
  });

  test('home does not change: a listed agent keeps their usual home page', () => {
    expect(homePathFor({ role: 'agent' }, 'agent')).toBe('/tickets');
    expect(homePathFor({ role: 'viewer' }, 'viewer')).toBe('/tickets');
  });
});
