/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SyncHealthBanner from './SyncHealthBanner';
import { syncAPI } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { useSSE } from '../hooks/useSSE';

vi.mock('../services/api', () => ({
  syncAPI: { getHealth: vi.fn() },
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: vi.fn(),
}));
// The banner subscribes to the SHARED realtime client for sync events (Phase
// SH); the mock captures its options so tests can fire the callbacks.
vi.mock('../hooks/useSSE', () => ({
  useSSE: vi.fn(() => ({})),
}));

const staleHealth = {
  checkedAt: new Date().toISOString(),
  overall: 'stale',
  workspaces: [
    { workspaceId: 1, name: 'IT', intervalMinutes: 5, lastSyncAt: new Date().toISOString(), ageMs: 60000, status: 'ok' },
    { workspaceId: 2, name: 'Accounting', intervalMinutes: 5, lastSyncAt: new Date(Date.now() - 3600000).toISOString(), ageMs: 3600000, status: 'stale' },
  ],
};

function renderBanner() {
  return render(<MemoryRouter><SyncHealthBanner /></MemoryRouter>);
}

describe('SyncHealthBanner', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test('renders the stale warning for global admins with a link to the health card', async () => {
    useAuth.mockReturnValue({ user: { role: 'admin' } });
    syncAPI.getHealth.mockResolvedValue({ success: true, data: staleHealth });

    renderBanner();

    await waitFor(() => expect(screen.getByText('FreshService sync is stale')).toBeInTheDocument());
    expect(screen.getByText(/Accounting hasn't completed a sync/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view sync freshness/i })).toHaveAttribute('href', '/settings#notification-providers');
  });

  test('renders nothing (and never fetches) for non-admins', async () => {
    useAuth.mockReturnValue({ user: { role: 'viewer' } });
    const { container } = renderBanner();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(syncAPI.getHealth).not.toHaveBeenCalled();
  });

  test('renders nothing when everything is fresh', async () => {
    useAuth.mockReturnValue({ user: { role: 'admin' } });
    syncAPI.getHealth.mockResolvedValue({
      success: true,
      data: { ...staleHealth, overall: 'ok', workspaces: staleHealth.workspaces.map((w) => ({ ...w, status: 'ok' })) },
    });
    const { container } = renderBanner();
    await waitFor(() => expect(syncAPI.getHealth).toHaveBeenCalled());
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  test('dismiss hides the current incident', async () => {
    useAuth.mockReturnValue({ user: { role: 'admin' } });
    syncAPI.getHealth.mockResolvedValue({ success: true, data: staleHealth });
    renderBanner();
    await waitFor(() => expect(screen.getByText('FreshService sync is stale')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('FreshService sync is stale')).not.toBeInTheDocument();
  });

  test('downgrades the copy (no scary "old data") when the stale workspace is syncing now', async () => {
    useAuth.mockReturnValue({ user: { role: 'admin' } });
    syncAPI.getHealth.mockResolvedValue({
      success: true,
      data: {
        ...staleHealth,
        workspaces: staleHealth.workspaces.map((w) => (
          w.status === 'stale'
            ? { ...w, syncRunning: true, runningSince: new Date().toISOString(), runningForMs: 180000 }
            : w
        )),
      },
    });

    renderBanner();

    await waitFor(() => expect(screen.getByText('FreshService sync is catching up')).toBeInTheDocument());
    expect(screen.getByText(/a sync is running now — data should refresh shortly/i)).toBeInTheDocument();
    expect(screen.queryByText(/dashboards are serving old data/i)).not.toBeInTheDocument();
  });

  test('refetches health on realtime sync-completed / sync-skipped events', async () => {
    useAuth.mockReturnValue({ user: { role: 'admin' } });
    syncAPI.getHealth.mockResolvedValue({ success: true, data: staleHealth });

    renderBanner();
    await waitFor(() => expect(syncAPI.getHealth).toHaveBeenCalledTimes(1));

    const sseOptions = useSSE.mock.calls.at(-1)[0];
    expect(sseOptions.enabled).toBe(true);

    sseOptions.onSyncCompleted({ workspaceId: 2 });
    await waitFor(() => expect(syncAPI.getHealth).toHaveBeenCalledTimes(2));
    sseOptions.onSyncSkipped({ workspaceId: 2 });
    await waitFor(() => expect(syncAPI.getHealth).toHaveBeenCalledTimes(3));
  });
});
