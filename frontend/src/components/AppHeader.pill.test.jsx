/** @vitest-environment jsdom */
// Realtime plan Phase 2 — status-pill vocabulary + self-diagnosing popover:
//   Live (SSE, green) / Auto-refresh (polling, amber) / Offline (red,
//   working Reconnect), with diagnostics rows (transport, last event age,
//   reconnect churn, channel workspace) while the popover is open.
//
// Honest pill (QA 08-19 #3): the pill reads the SHARED realtime client's
// status (useRealtimeStatus), NOT DashboardContext's route-gated
// subscription — /approvals (outside APP_LIVE_SSE_ROUTES) used to show a red
// Offline while the tab's shared connection was genuinely live. The legacy
// EventSource transport has no shared client; the pill falls back to the
// DashboardContext-derived state there (rt.active === false).
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
  useRealtimeStatus: vi.fn(),
}));

vi.mock('../services/api', () => ({
  syncAPI: { trigger: mocks.trigger, getStatus: mocks.getStatus },
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: mocks.useAuth }));
vi.mock('../contexts/DashboardContext', () => ({ useDashboard: mocks.useDashboard }));
vi.mock('../contexts/WorkspaceContext', () => ({ useWorkspace: mocks.useWorkspace }));
vi.mock('../hooks/useRealtimeStatus', () => ({ useRealtimeStatus: mocks.useRealtimeStatus }));
vi.mock('./nav/SideRail', () => ({ default: () => null }));
vi.mock('./ChangelogModal', () => ({ default: () => null }));

import AppHeader from './AppHeader';

// lastEventAt computed at CALL time — module-load time drifts by however long
// the test run takes to reach this file.
const baseDiag = () => ({ state: 'live-sse', transport: 'sse', lastEventAt: Date.now() - 12000, churn: 3, workspaceId: 1, cursor: 'e1:9', epoch: 'e1' });

// Shared-client status (the pill's primary source). Pass `rt: null` to force
// the legacy fallback path (rt.active === false → DashboardContext values).
const baseRt = () => ({
  active: true,
  state: 'live-sse',
  transport: 'sse',
  retry: vi.fn(),
  getDiagnostics: () => baseDiag(),
  getReconnectChurn: () => 3,
});
const legacyRt = () => ({ active: false, state: null, transport: null, retry: null, getDiagnostics: null, getReconnectChurn: null });

function setup(dashboard = {}, { rt = {}, activePage = 'tickets' } = {}) {
  mocks.useAuth.mockReturnValue({ user: { name: 'Pat', email: 'pat@bgc.ca', role: 'viewer' }, logout: vi.fn() });
  mocks.useRealtimeStatus.mockReturnValue(rt === null ? legacyRt() : { ...baseRt(), ...rt });
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
      <AppHeader activePage={activePage} />
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
    setup({}, { rt: { state: 'live-poll', transport: 'longpoll' } });
    const pill = screen.getByRole('button', { name: /auto-refresh/i });
    expect(pill.className).toContain('amber');
  });

  test('offline shows the red pill with a WORKING reconnect', () => {
    const retry = vi.fn();
    setup({}, { rt: { state: 'offline', transport: null, retry } });
    const pill = screen.getByRole('button', { name: /offline — reconnect/i });
    expect(pill.className).toContain('red');
    fireEvent.click(pill);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test('legacy transport (no shared client) falls back to the connection status', () => {
    setup(
      { sseTransportStatus: undefined, sseTransport: undefined, sseGetDiagnostics: undefined, sseConnectionStatus: 'connected' },
      { rt: null },
    );
    expect(screen.getByRole('button', { name: /^live/i })).toBeInTheDocument();
  });
});

describe('AppHeader honest pill — shared client, not the route-gated consumer (QA 08-19 #3)', () => {
  test('/approvals shows Live while the shared client is live, even with the dashboard feed route-gated off', () => {
    // DashboardContext on /approvals used to report enabled:false →
    // 'disconnected' → a red Offline pill. The pill must read the SHARED
    // client instead, which is genuinely live on every page.
    setup(
      { sseEnabled: false, sseConnectionStatus: 'disconnected', sseTransportStatus: 'idle', sseTransport: null },
      { activePage: 'approvals' },
    );
    expect(screen.getByRole('button', { name: /^live/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /offline/i })).not.toBeInTheDocument();
  });

  test('shared client offline wins over a stale-looking dashboard state, and Retry works with sseEnabled false', () => {
    // Flap honesty (v3.4.x): the ladder's terminal state is Offline — and the
    // manual Retry must be actionable wherever the shared client runs, even on
    // routes where the dashboard consumer is disabled.
    const retry = vi.fn();
    setup(
      { sseEnabled: false, sseConnectionStatus: 'connected' },
      { rt: { state: 'offline', transport: null, retry }, activePage: 'approvals' },
    );
    const pill = screen.getByRole('button', { name: /offline — reconnect/i });
    fireEvent.click(pill);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("shared client 'idle' renders as Connecting, never Offline", () => {
    setup({}, { rt: { state: 'idle', transport: null } });
    expect(screen.getByRole('button', { name: /connecting/i })).toBeInTheDocument();
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

  test('diagnostics stay available on /approvals (shared-client getDiagnostics, not the dashboard consumer)', () => {
    setup(
      { sseEnabled: false, sseConnectionStatus: 'disconnected', sseTransportStatus: 'idle', sseTransport: null, sseGetDiagnostics: undefined, sseGetReconnectChurn: undefined },
      { activePage: 'approvals' },
    );
    fireEvent.click(screen.getByRole('button', { name: /^live/i }));
    expect(screen.getByText('Transport')).toBeInTheDocument();
    expect(screen.getByText('Live stream (SSE)')).toBeInTheDocument();
    expect(screen.getByText(/IT \(ws 1\)/)).toBeInTheDocument();
  });

  test('live-poll popover explains the degraded transport', () => {
    setup({}, {
      rt: {
        state: 'live-poll',
        transport: 'longpoll',
        getDiagnostics: () => ({ ...baseDiag(), state: 'live-poll', transport: 'longpoll' }),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /auto-refresh/i }));
    expect(screen.getByText(/live stream unavailable on this network/i)).toBeInTheDocument();
    expect(screen.getByText('Long-poll fallback')).toBeInTheDocument();
  });

  test('diagnostics rows are hidden on the legacy path (no getDiagnostics)', () => {
    setup(
      { sseTransportStatus: undefined, sseTransport: undefined, sseGetDiagnostics: undefined },
      { rt: null },
    );
    fireEvent.click(screen.getByRole('button', { name: /^live/i }));
    expect(screen.queryByText('Transport')).not.toBeInTheDocument();
    // The v3.4.00 rows stay intact.
    expect(screen.getByText('Data refreshed')).toBeInTheDocument();
    expect(screen.getByText('Background sync')).toBeInTheDocument();
  });
});
