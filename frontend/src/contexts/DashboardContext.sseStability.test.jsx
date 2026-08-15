/** @vitest-environment jsdom */
// Phase 2 (QA 08-07 #14) — DashboardContext must NOT tear down and rebuild
// its realtime subscription on route changes. The old handleSyncCompleted
// closed over location.pathname, so every navigation changed a callback
// identity and useSSE re-subscribed (one cause of the perpetual "Connecting"
// flicker). With the shared realtime client, callback churn only updates the
// fan-out table — ONE subscription for the provider's lifetime.
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  client: null,
}));

vi.mock('../services/api', () => ({
  dashboardAPI: {
    getDashboard: vi.fn(() => Promise.resolve({ success: true, data: {} })),
    getWeeklyDashboard: vi.fn(() => Promise.resolve({ success: true, data: {} })),
    getMonthlyDashboard: vi.fn(() => Promise.resolve({ success: true, data: {} })),
    getWeeklyStats: vi.fn(() => Promise.resolve({ success: true, data: {} })),
    getTechnician: vi.fn(() => Promise.resolve({ success: true, data: {} })),
    getTechnicianWeekly: vi.fn(() => Promise.resolve({ success: true, data: {} })),
    getTechnicianCSAT: vi.fn(() => Promise.resolve({ success: true, data: {} })),
  },
  getWorkspaceId: vi.fn(() => 1),
}));

class FakeRealtimeClient {
  constructor() {
    this.subscribeCalls = 0;
    this.unsubscribeCalls = 0;
  }

  subscribe(sub) {
    this.subscribeCalls += 1;
    if (sub.onStatus) sub.onStatus({ state: 'live-sse', transport: 'sse' });
    return {
      update: () => {},
      unsubscribe: () => { this.unsubscribeCalls += 1; },
    };
  }

  retry() {}

  getDiagnostics() {
    return { state: 'live-sse', transport: 'sse', lastEventAt: Date.now(), churn: 1, workspaceId: 1 };
  }
}

vi.mock('../services/realtimeClient', () => ({
  getSharedRealtimeClient: () => mocks.client,
}));

import { DashboardProvider } from './DashboardContext';

function NavButton({ to }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>go-{to}</button>
  );
}

function renderAt(initialPath) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <DashboardProvider>
        <Routes>
          <Route path="*" element={(
            <div>
              <NavButton to="/technician/7" />
              <NavButton to="/timeline" />
              <NavButton to="/dashboard" />
            </div>
          )}
          />
        </Routes>
      </DashboardProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.client = new FakeRealtimeClient();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('DashboardContext SSE stability across route changes', () => {
  test('navigating between live routes keeps ONE realtime subscription (no rebuild thrash)', async () => {
    renderAt('/dashboard');
    await act(async () => {});
    expect(mocks.client.subscribeCalls).toBe(1);

    await act(async () => { screen.getByText('go-/technician/7').click(); });
    await act(async () => { screen.getByText('go-/timeline').click(); });
    await act(async () => { screen.getByText('go-/dashboard').click(); });

    // Route changes re-render the provider but must not re-subscribe.
    expect(mocks.client.subscribeCalls).toBe(1);
    expect(mocks.client.unsubscribeCalls).toBe(0);
  });
});
