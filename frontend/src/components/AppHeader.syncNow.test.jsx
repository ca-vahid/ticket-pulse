/** @vitest-environment jsdom */
// Realtime plan Phase 1 — honest "Sync now":
//  - hidden for non-admins (the route is requireAdmin; the silent 403 no-op is gone)
//  - response-driven feedback: {status:'skipped'} → "already running", success toast
//  - the popover's Background-sync row fetches the REAL status lazily (it was a
//    hard-coded "Idle" off-dashboard), and the freshness row says "Data refreshed"
//  - workspace switch failures surface as a visible banner with Retry/Dismiss
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
// Legacy-shaped stub (active:false) so this suite keeps exercising the
// DashboardContext-driven pill state it always asserted against; the shared
// client path has its own suite (AppHeader.pill.test.jsx).
vi.mock('../hooks/useRealtimeStatus', () => ({
  useRealtimeStatus: () => ({ active: false, state: null, transport: null, retry: null, getDiagnostics: null, getReconnectChurn: null }),
}));
vi.mock('./nav/SideRail', () => ({ default: () => null }));
vi.mock('./ChangelogModal', () => ({ default: () => null }));

import AppHeader from './AppHeader';

const baseDashboard = {
  isRefreshing: false,
  lastUpdated: new Date('2026-08-15T10:00:00'),
  sseConnectionStatus: 'connected',
  sseRetry: vi.fn(),
  sseEnabled: true,
  syncSkippedEvent: null,
};

function workspaceValue(role, extra = {}) {
  return {
    currentWorkspace: { id: 1, name: 'IT', slug: 'it' },
    availableWorkspaces: [{ id: 1, name: 'IT', slug: 'it', role }],
    switchWorkspace: vi.fn(),
    switchError: null,
    clearSwitchError: vi.fn(),
    retryWorkspaceSync: vi.fn(),
    ...extra,
  };
}

function setup({ userRole = 'viewer', wsRole = 'viewer', dashboard = {}, workspace = {} } = {}) {
  mocks.useAuth.mockReturnValue({ user: { name: 'Pat', email: 'pat@bgc.ca', role: userRole }, logout: vi.fn() });
  mocks.useDashboard.mockReturnValue({ ...baseDashboard, ...dashboard });
  mocks.useWorkspace.mockReturnValue(workspaceValue(wsRole, workspace));
  return render(
    <MemoryRouter>
      <AppHeader activePage="tickets" />
    </MemoryRouter>,
  );
}

async function openStatusPopover() {
  fireEvent.click(screen.getByRole('button', { name: /live|connecting|offline|syncing/i }));
}

beforeEach(() => {
  mocks.trigger.mockReset().mockResolvedValue({ success: true, data: { ticketsSynced: 3 } });
  mocks.getStatus.mockReset().mockResolvedValue({ success: true, data: { sync: { isRunning: false, progress: null } } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AppHeader — Sync now visibility', () => {
  test('non-admins do not get a Sync now button (route is admin-gated)', async () => {
    setup({ userRole: 'viewer', wsRole: 'viewer' });
    await openStatusPopover();
    expect(screen.queryByRole('button', { name: /sync now/i })).not.toBeInTheDocument();
  });

  test('workspace admins get the button', async () => {
    setup({ userRole: 'viewer', wsRole: 'admin' });
    await openStatusPopover();
    expect(screen.getByRole('button', { name: /sync now/i })).toBeInTheDocument();
  });
});

describe('AppHeader — response-driven Sync now feedback', () => {
  test("{status:'skipped'} shows 'A sync is already running'", async () => {
    mocks.trigger.mockResolvedValue({ success: true, data: { status: 'skipped', reason: 'busy' } });
    setup({ userRole: 'admin', wsRole: 'admin' });
    await openStatusPopover();

    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('A sync is already running');
    });
  });

  test('a successful trigger reports completion', async () => {
    setup({ userRole: 'admin', wsRole: 'admin' });
    await openStatusPopover();

    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/sync finished/i);
    });
  });

  test('a 403 rejection is reported, not swallowed', async () => {
    mocks.trigger.mockRejectedValue({ response: { status: 403 } });
    setup({ userRole: 'admin', wsRole: 'admin' });
    await openStatusPopover();

    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/only admins/i);
    });
  });

  test('a broadcast sync-skipped event (another tab clicked) surfaces the notice too', async () => {
    setup({
      userRole: 'admin',
      wsRole: 'admin',
      dashboard: { syncSkippedEvent: { at: Date.now(), reason: 'busy' } },
    });
    await openStatusPopover();
    expect(await screen.findByRole('status')).toHaveTextContent('A sync is already running');
  });
});

describe('AppHeader — honest popover rows', () => {
  test('freshness row is labeled "Data refreshed"', async () => {
    setup({ userRole: 'admin', wsRole: 'admin' });
    await openStatusPopover();
    expect(screen.getByText('Data refreshed')).toBeInTheDocument();
  });

  test('opening the popover lazily fetches the real background-sync status', async () => {
    mocks.getStatus.mockResolvedValue({
      success: true,
      data: { sync: { isRunning: true, progress: { currentStep: 'Syncing tickets 2/5' } } },
    });
    setup({ userRole: 'admin', wsRole: 'admin' });
    await openStatusPopover();

    expect(mocks.getStatus).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByText('Syncing tickets 2/5')).toBeInTheDocument();
    });
    expect(screen.queryByText('Idle')).not.toBeInTheDocument();
  });

  test('idle status keeps the Idle row', async () => {
    setup({ userRole: 'admin', wsRole: 'admin' });
    await openStatusPopover();
    await waitFor(() => { expect(mocks.getStatus).toHaveBeenCalled(); });
    expect(screen.getByText('Idle')).toBeInTheDocument();
  });
});

describe('AppHeader — workspace switch divergence banner', () => {
  test('shows the persistent switch error with Retry and Dismiss', async () => {
    const retryWorkspaceSync = vi.fn();
    const clearSwitchError = vi.fn();
    setup({
      userRole: 'admin',
      wsRole: 'admin',
      workspace: {
        switchError: 'Workspace switch did not reach the server — live updates and data may still show the previous workspace.',
        retryWorkspaceSync,
        clearSwitchError,
      },
    });

    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent(/did not reach the server/i);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retryWorkspaceSync).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(clearSwitchError).toHaveBeenCalledTimes(1);
  });
});
