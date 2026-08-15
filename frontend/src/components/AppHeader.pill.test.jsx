/** @vitest-environment jsdom */
// Realtime plan Phase 2 — status-pill vocabulary + self-diagnosing popover:
//   Live (SSE, green) / Auto-refresh (polling, amber) / Offline (red,
//   working Reconnect), with diagnostics rows (transport, last event age,
//   reconnect churn, channel workspace) while the popover is open.
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  trigger: vi.fn(),
  getStatus: vi.fn(),
  useAuth: vi.fn(),
  useDashboard: vi.fn(),
  useWorkspace: vi.fn(),
}));

vi.mock('../services/api', () => ({
  syncAPI: { trigger: mocks.trigger, getStatus: mocks.getStatus },
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: mocks.useAuth }));
vi.mock('../contexts/DashboardContext', () => ({ useDashboard: mocks.useDashboard }));
vi.mock('../contexts/WorkspaceContext', () => ({ useWorkspace: mocks.useWorkspace }));
vi.mock('./nav/SideRail', () => ({ default: () => null }));
vi.mock('./ChangelogModal', () => ({ default: () => null }));

import AppHeader from './AppHeader';

// lastEventAt computed at CALL time — module-load time drifts by however long
// the test run takes to reach this file.
const baseDiag = () => ({ state: 'live-sse', transport: 'sse', lastEventAt: Date.now() - 12000, churn: 3, workspaceId: 1, cursor: 'e1:9', epoch: 'e1' });

function setup(dashboard = {}) {
  mocks.useAuth.mockReturnValue({ user: { name: 'Pat', email: 'pat@bgc.ca', role: 'viewer' }, logout: vi.fn() });
  mocks.useDashboard.mockReturnValue({
    isRefreshing: false,
    lastUpdated: new Date('2026-08-15T10:00:00'),
    sseConnectionStatus: 'connected',
    sseTransportStatus: 'live-sse',
    sseTransport: 'sse',
    sseRetry: vi.fn(),
    sseGetReconnectChurn: () => 3,
    sseGetDiagnostics: () => baseDiag(),
    sseEnabled: true,
    syncSkippedEvent: null,
    ...dashboard,
  });
  mocks.useWorkspace.mockReturnValue({
    currentWorkspace: { id: 1, name: 'IT', slug: 'it' },
    availableWorkspaces: [{ id: 1, name: 'IT', slug: 'it', role: 'viewer' }],
    switchWorkspace: vi.fn(),
    switchError: null,
    clearSwitchError: vi.fn(),
    retryWorkspaceSync: vi.fn(),
  });
  return render(
    <MemoryRouter>
      <AppHeader activePage="tickets" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.trigger.mockReset().mockResolvedValue({ success: true, data: {} });
  mocks.getStatus.mockReset().mockResolvedValue({ success: true, data: { sync: { isRunning: false, progress: null } } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AppHeader pill vocabulary', () => {
  test('live-sse shows the green Live pill', () => {
    setup();
    expect(screen.getByRole('button', { name: /^live/i })).toBeInTheDocument();
  });

  test('live-poll shows the amber Auto-refresh pill', () => {
    setup({ sseTransportStatus: 'live-poll', sseTransport: 'longpoll' });
    const pill = screen.getByRole('button', { name: /auto-refresh/i });
    expect(pill.className).toContain('amber');
  });

  test('offline shows the red pill with a WORKING reconnect', () => {
    const sseRetry = vi.fn();
    setup({ sseTransportStatus: 'offline', sseTransport: null, sseConnectionStatus: 'disconnected', sseRetry });
    const pill = screen.getByRole('button', { name: /offline — reconnect/i });
    expect(pill.className).toContain('red');
    fireEvent.click(pill);
    expect(sseRetry).toHaveBeenCalledTimes(1);
  });

  test('legacy transport (no transportStatus) falls back to the connection status', () => {
    setup({ sseTransportStatus: undefined, sseTransport: undefined, sseGetDiagnostics: undefined, sseConnectionStatus: 'connected' });
    expect(screen.getByRole('button', { name: /^live/i })).toBeInTheDocument();
  });
});

describe('AppHeader popover diagnostics', () => {
  test('shows transport, last event age, reconnect churn, and channel workspace', async () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /^live/i }));

    expect(screen.getByText('Transport')).toBeInTheDocument();
    expect(screen.getByText('Live stream (SSE)')).toBeInTheDocument();
    expect(screen.getByText('Last event')).toBeInTheDocument();
    expect(screen.getByText(/12s ago/)).toBeInTheDocument();
    expect(screen.getByText('Reconnects')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Channel')).toBeInTheDocument();
    expect(screen.getByText(/IT \(ws 1\)/)).toBeInTheDocument();
  });

  test('live-poll popover explains the degraded transport', () => {
    setup({ sseTransportStatus: 'live-poll', sseTransport: 'longpoll' });
    fireEvent.click(screen.getByRole('button', { name: /auto-refresh/i }));
    expect(screen.getByText(/live stream unavailable on this network/i)).toBeInTheDocument();
    expect(screen.getByText('Long-poll fallback')).toBeInTheDocument();
  });

  test('diagnostics rows are hidden on the legacy path (no getDiagnostics)', () => {
    setup({ sseTransportStatus: undefined, sseTransport: undefined, sseGetDiagnostics: undefined });
    fireEvent.click(screen.getByRole('button', { name: /^live/i }));
    expect(screen.queryByText('Transport')).not.toBeInTheDocument();
    // The v3.4.00 rows stay intact.
    expect(screen.getByText('Data refreshed')).toBeInTheDocument();
    expect(screen.getByText('Background sync')).toBeInTheDocument();
  });
});
