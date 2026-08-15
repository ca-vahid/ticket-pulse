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
  getEventSource: vi.fn(),
}));

vi.mock('../services/api', () => ({
  dashboardAPI: {
    getDashboard: vi.fn(() => Promise.resolve({ success: true, data: {} })),
    getWeeklyDashboard: vi.fn(() => Promise.resolve({ success: true, data: { technicians: [] } })),
    getMonthlyDashboard: vi.fn(() => Promise.resolve({ success: true, data: { technicians: [] } })),
    getWeeklyStats: vi.fn(() => Promise.resolve({ success: true, data: { dailyCounts: [] } })),
  },
  getWorkspaceId: vi.fn(() => 1),
  sseAPI: { getEventSource: mocks.getEventSource },
  isAuthTokenExpiring: vi.fn(() => false),
  refreshAuthToken: vi.fn(() => Promise.resolve(null)),
}));

import { DashboardProvider, useDashboard } from './DashboardContext';

class FakeEventSource {
  static instances = [];

  constructor() {
    this.listeners = {};
    this.readyState = 0;
    this.onopen = null;
    this.onerror = null;
    this.onmessage = null;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  emit(type, data) {
    (this.listeners[type] || []).forEach((fn) => fn({ data }));
  }

  close() { this.readyState = 2; }
}
FakeEventSource.CONNECTING = 0;
FakeEventSource.OPEN = 1;
FakeEventSource.CLOSED = 2;

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
  vi.stubGlobal('EventSource', FakeEventSource);
  FakeEventSource.instances = [];
  mocks.getEventSource.mockReset().mockImplementation(() => new FakeEventSource());
  sessionStorage.clear();
  ctx = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

  test('a received SSE sync-completed data event stamps lastFreshAt', async () => {
    renderProvider();
    await act(async () => {});
    expect(ctx.lastFreshAt).toBeNull();
    const source = FakeEventSource.instances.at(-1);
    await act(async () => {
      source.emit('sync-completed', JSON.stringify({ syncType: 'full' }));
    });
    expect(ctx.lastFreshAt).toBeInstanceOf(Date);
  });
});
