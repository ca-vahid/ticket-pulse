/** @vitest-environment jsdom */
// Realtime plan Phase 1 — "Last updated" honesty. lastFreshAt used to be
// stamped ONLY by the daily-view fetch, so weekly/monthly/force-refresh
// viewers (and every SSE data event) never moved it: the popover row was a
// "daily dashboard fetched" stamp masquerading as data freshness.
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  client: null,
}));

vi.mock('../services/api', () => ({
  dashboardAPI: {
    getDashboard: vi.fn(() => Promise.resolve({ success: true, data: {} })),
    getWeeklyDashboard: vi.fn(() => Promise.resolve({ success: true, data: { technicians: [] } })),
    getMonthlyDashboard: vi.fn(() => Promise.resolve({ success: true, data: { technicians: [] } })),
    getWeeklyStats: vi.fn(() => Promise.resolve({ success: true, data: { dailyCounts: [] } })),
  },
  getWorkspaceId: vi.fn(() => 1),
}));

// Fake shared realtime client: captures the provider's fan-out callbacks so
// the test can inject data events like the real client would.
class FakeRealtimeClient {
  constructor() {
    this.subs = [];
  }

  subscribe(sub) {
    this.subs.push(sub);
    if (sub.onStatus) sub.onStatus({ state: 'live-sse', transport: 'sse' });
    return { update: (fields) => Object.assign(sub, fields), unsubscribe: () => {} };
  }

  emit(name, data) {
    for (const sub of this.subs) {
      if (sub.enabled === false) continue;
      const cb = sub.callbacks || {};
      if (name === 'sync-completed' && cb.onSyncCompleted) cb.onSyncCompleted(data);
    }
  }

  retry() {}

  getDiagnostics() {
    return { state: 'live-sse', transport: 'sse', lastEventAt: Date.now(), churn: 1, workspaceId: 1 };
  }
}

vi.mock('../services/realtimeClient', () => ({
  getSharedRealtimeClient: () => mocks.client,
}));

import { DashboardProvider, useDashboard } from './DashboardContext';

let ctx;
function Probe() {
  ctx = useDashboard();
  useEffect(() => {}, []);
  return <span data-testid="fresh">{ctx.lastFreshAt ? 'fresh' : 'never'}</span>;
}

function renderProvider() {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <DashboardProvider>
        <Probe />
      </DashboardProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.client = new FakeRealtimeClient();
  sessionStorage.clear();
  ctx = null;
});

afterEach(() => {
  cleanup();
});

describe('DashboardContext lastFreshAt honesty', () => {
  test('starts unset', async () => {
    renderProvider();
    await act(async () => {});
    expect(screen.getByTestId('fresh')).toHaveTextContent('never');
  });

  test('weekly fetch stamps lastFreshAt', async () => {
    renderProvider();
    await act(async () => {});
    await act(async () => { await ctx.fetchWeeklyDashboard('2026-08-10'); });
    expect(ctx.lastFreshAt).toBeInstanceOf(Date);
  });

  test('monthly fetch stamps lastFreshAt', async () => {
    renderProvider();
    await act(async () => {});
    await act(async () => { await ctx.fetchMonthlyDashboard('2026-08-01'); });
    expect(ctx.lastFreshAt).toBeInstanceOf(Date);
  });

  test('force refresh (no-cache) stamps lastFreshAt', async () => {
    renderProvider();
    await act(async () => {});
    await act(async () => { ctx.setCurrentView('weekly', null, '2026-08-10', null); });
    await act(async () => { await ctx.forceRefreshNoCache(); });
    expect(ctx.lastFreshAt).toBeInstanceOf(Date);
  });

  test('a received sync-completed data event stamps lastFreshAt', async () => {
    renderProvider();
    await act(async () => {});
    expect(ctx.lastFreshAt).toBeNull();
    await act(async () => {
      mocks.client.emit('sync-completed', { syncType: 'full' });
    });
    expect(ctx.lastFreshAt).toBeInstanceOf(Date);
  });
});
