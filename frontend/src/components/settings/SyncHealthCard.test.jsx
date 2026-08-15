/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import SyncHealthCard from './SyncHealthCard';
import { syncAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  syncAPI: { getHealth: vi.fn() },
}));

describe('SyncHealthCard', () => {
  afterEach(() => cleanup());

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
});
