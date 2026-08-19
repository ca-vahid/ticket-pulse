/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SyncHealthCard from './SyncHealthCard';
import { syncAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  syncAPI: { getHealth: vi.fn() },
}));

describe('SyncHealthCard', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test('renders per-workspace rows with status chips and the worst overall badge', async () => {
    syncAPI.getHealth.mockResolvedValue({
      success: true,
      data: {
        overall: 'stale',
        workspaces: [
          { workspaceId: 1, name: 'IT', intervalMinutes: 5, lastSyncAt: new Date().toISOString(), ageMs: 120000, status: 'ok' },
          { workspaceId: 2, name: 'Accounting', intervalMinutes: 10, lastSyncAt: new Date(Date.now() - 3600000).toISOString(), ageMs: 3600000, status: 'stale' },
          { workspaceId: 3, name: 'New Space', intervalMinutes: 5, lastSyncAt: null, ageMs: null, status: 'unknown' },
        ],
      },
    });

    render(<SyncHealthCard />);

    await waitFor(() => expect(screen.getByText('Accounting')).toBeInTheDocument());
    expect(screen.getByText('IT')).toBeInTheDocument();
    expect(screen.getByText('Fresh')).toBeInTheDocument();
    // Row chip + overall header badge both say Stale.
    expect(screen.getAllByText('Stale')).toHaveLength(2);
    expect(screen.getByText('No syncs yet')).toBeInTheDocument();
    expect(screen.getByText('every 10m')).toBeInTheDocument();
    expect(screen.getByText('never')).toBeInTheDocument();
  });

  test('surfaces a load error (e.g. 403 for non-admins) instead of a broken table', async () => {
    syncAPI.getHealth.mockRejectedValue(new Error('Request failed with status code 403'));
    render(<SyncHealthCard />);
    await waitFor(() => expect(screen.getByText(/403/)).toBeInTheDocument());
  });

  test('an in-flight run renders a "Syncing now" chip instead of a Stale/Late chip, plus data freshness', async () => {
    syncAPI.getHealth.mockResolvedValue({
      success: true,
      data: {
        checkedAt: '2026-08-18T16:32:10Z',
        overall: 'ok',
        workspaces: [
          {
            workspaceId: 2,
            name: 'Accounting',
            intervalMinutes: 5,
            lastSyncAt: new Date(Date.now() - 22 * 60000).toISOString(),
            ageMs: 22 * 60000,
            status: 'ok',
            syncRunning: true,
            runningSince: new Date(Date.now() - 3 * 60000).toISOString(),
            runningForMs: 3 * 60000,
            dataFreshAt: new Date(Date.now() - 60000).toISOString(),
            dataAgeMs: 60000,
          },
        ],
      },
    });

    render(<SyncHealthCard />);

    await waitFor(() => expect(screen.getByText(/Syncing now · started 3m ago/)).toBeInTheDocument());
    expect(screen.queryByText('Stale')).not.toBeInTheDocument();
    expect(screen.queryByText('Late')).not.toBeInTheDocument();
    expect(screen.getByText('Data fresh 1m ago')).toBeInTheDocument();
    // checkedAt renders as a wall-clock "Checked …" stamp.
    expect(screen.getByText(/^Checked /)).toBeInTheDocument();
  });

  test('the refresh button refetches and updates the checked timestamp', async () => {
    const healthAt = (checkedAt) => ({
      success: true,
      data: {
        checkedAt,
        overall: 'ok',
        workspaces: [{
          workspaceId: 1,
          name: 'IT',
          intervalMinutes: 5,
          lastSyncAt: new Date().toISOString(),
          ageMs: 60000,
          status: 'ok',
          syncRunning: false,
          runningSince: null,
          runningForMs: null,
          dataFreshAt: null,
          dataAgeMs: null,
        }],
      },
    });
    syncAPI.getHealth.mockResolvedValueOnce(healthAt('2026-08-18T16:00:00Z'));

    render(<SyncHealthCard />);
    await waitFor(() => expect(screen.getByText('IT')).toBeInTheDocument());
    expect(syncAPI.getHealth).toHaveBeenCalledTimes(1);
    const firstStamp = screen.getByText(/^Checked /).textContent;

    syncAPI.getHealth.mockResolvedValueOnce(healthAt('2026-08-18T16:05:30Z'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh sync health' }));

    await waitFor(() => expect(syncAPI.getHealth).toHaveBeenCalledTimes(2));
    // The ≥400ms minimum spinner holds `loading` before the new stamp lands.
    await waitFor(() => {
      expect(screen.getByText(/^Checked /).textContent).not.toBe(firstStamp);
    }, { timeout: 2000 });
  });
});
