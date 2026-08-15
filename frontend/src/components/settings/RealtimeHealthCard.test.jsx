/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import RealtimeHealthCard from './RealtimeHealthCard';
import { realtimeAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  realtimeAPI: { getTelemetrySummary: vi.fn() },
}));

describe('RealtimeHealthCard', () => {
  afterEach(() => cleanup());

  test('renders today\'s counters and the truncated most-affected list (no leaderboard framing)', async () => {
    realtimeAPI.getTelemetrySummary.mockResolvedValue({
      success: true,
      data: {
        sampling: 'Reports are sampled from ~10% of sessions…',
        activeConnections: 12,
        today: {
          date: '2026-08-15',
          reports: 9,
          downgrades: 4,
          downgradesByTransport: { longpoll: 3, shortpoll: 1 },
          offline: 2,
          offlineTerminal: 1,
          churnMax: 14,
          affectedUsers: 3,
          topUsers: [
            { user: 'adr…@bgcengineering.ca', events: 5 },
            { user: 'kir…@bgcengineering.ca', events: 2 },
          ],
        },
        yesterday: { date: '2026-08-14', reports: 2, downgrades: 2, downgradesByTransport: { longpoll: 2, shortpoll: 0 }, offline: 0, offlineTerminal: 0, churnMax: 4 },
      },
    });

    render(<RealtimeHealthCard />);

    await waitFor(() => expect(screen.getByText('Realtime health')).toBeInTheDocument());
    expect(screen.getByText('4')).toBeInTheDocument(); // downgrades
    expect(screen.getByText('(1 to short-poll)')).toBeInTheDocument();
    expect(screen.getByText('12 live connections')).toBeInTheDocument();
    expect(screen.getByText('adr…@bgcengineering.ca')).toBeInTheDocument();
    // Team-safe framing: support triage, not a ranking of people.
    expect(screen.getByText(/support triage/i)).toBeInTheDocument();
    expect(screen.getByText(/Yesterday: 2 downgrades, 0 offline/)).toBeInTheDocument();
  });

  test('quiet day renders the all-good note', async () => {
    realtimeAPI.getTelemetrySummary.mockResolvedValue({
      success: true,
      data: {
        activeConnections: 3,
        today: { date: '2026-08-15', reports: 0, downgrades: 0, downgradesByTransport: { longpoll: 0, shortpoll: 0 }, offline: 0, offlineTerminal: 0, churnMax: 0, affectedUsers: 0, topUsers: [] },
        yesterday: null,
      },
    });
    render(<RealtimeHealthCard />);
    await waitFor(() => expect(screen.getByText(/No degradations reported today/)).toBeInTheDocument());
  });
});
