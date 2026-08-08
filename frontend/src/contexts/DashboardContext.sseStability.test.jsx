/** @vitest-environment jsdom */
// Phase 2 (QA 08-07 #14) — DashboardContext must NOT tear down and rebuild
// the SSE EventSource on route changes. The old handleSyncCompleted closed
// over location.pathname, so every navigation changed a callback identity and
// useSSE re-subscribed (one cause of the perpetual "Connecting" flicker).
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  getEventSource: vi.fn(),
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
  sseAPI: { getEventSource: mocks.getEventSource },
  isAuthTokenExpiring: vi.fn(() => false),
  refreshAuthToken: vi.fn(() => Promise.resolve(null)),
}));

import { DashboardProvider } from './DashboardContext';

class FakeEventSource {
  constructor() {
    this.readyState = 0;
    this.onopen = null;
    this.onerror = null;
    this.onmessage = null;
  }

  addEventListener() {}

  close() { this.readyState = 2; }
}
FakeEventSource.CONNECTING = 0;
FakeEventSource.OPEN = 1;
FakeEventSource.CLOSED = 2;

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
  vi.stubGlobal('EventSource', FakeEventSource);
  mocks.getEventSource.mockReset().mockImplementation(() => new FakeEventSource());
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DashboardContext SSE stability across route changes', () => {
  test('navigating between live routes keeps ONE EventSource (no rebuild thrash)', async () => {
    renderAt('/dashboard');
    await act(async () => {});
    expect(mocks.getEventSource).toHaveBeenCalledTimes(1);

    await act(async () => { screen.getByText('go-/technician/7').click(); });
    await act(async () => { screen.getByText('go-/timeline').click(); });
    await act(async () => { screen.getByText('go-/dashboard').click(); });

    // Route changes re-render the provider but must not re-subscribe SSE.
    expect(mocks.getEventSource).toHaveBeenCalledTimes(1);
  });
});
