/** @vitest-environment jsdom */
// Realtime plan Phase 1 — deterministic SSE re-key on workspace switch.
// DashboardContext must derive its reconnectKey from the CONTEXT-subscribed
// workspace (useWorkspace().currentWorkspace?.id), so a switch always tears
// down and rebuilds the stream. Reading the module getter at render time only
// re-keyed on incidental re-renders (App.jsx children-bailout meant the
// provider often did not re-render on switch → wrong-channel zombie).
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createContext, useContext, useState } from 'react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  getEventSource: vi.fn(),
}));

vi.mock('../services/api', () => ({
  dashboardAPI: {
    getDashboard: vi.fn(() => Promise.resolve({ success: true, data: {} })),
    getWeeklyDashboard: vi.fn(() => Promise.resolve({ success: true, data: {} })),
    getMonthlyDashboard: vi.fn(() => Promise.resolve({ success: true, data: {} })),
    getWeeklyStats: vi.fn(() => Promise.resolve({ success: true, data: {} })),
  },
  getWorkspaceId: vi.fn(() => 1),
  sseAPI: { getEventSource: mocks.getEventSource },
  isAuthTokenExpiring: vi.fn(() => false),
  refreshAuthToken: vi.fn(() => Promise.resolve(null)),
}));

// Substitute WorkspaceContext with a controllable test context so we can flip
// currentWorkspace without dragging in Auth/MSAL.
const TestWorkspaceContext = createContext(null);
vi.mock('./WorkspaceContext', () => ({
  useWorkspaceOptional: () => useContext(TestWorkspaceContext),
  useWorkspace: () => useContext(TestWorkspaceContext),
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

let setWorkspaceExternal;

function Harness() {
  const [ws, setWs] = useState({ id: 1, name: 'IT' });
  setWorkspaceExternal = setWs;
  return (
    <TestWorkspaceContext.Provider value={{ currentWorkspace: ws }}>
      <MemoryRouter initialEntries={['/dashboard']}>
        <DashboardProvider>
          <div>child</div>
        </DashboardProvider>
      </MemoryRouter>
    </TestWorkspaceContext.Provider>
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

describe('DashboardContext SSE re-key on workspace switch', () => {
  test('switching currentWorkspace rebuilds the EventSource; same id does not', async () => {
    render(<Harness />);
    await act(async () => {});
    expect(mocks.getEventSource).toHaveBeenCalledTimes(1);

    // Same id (new object identity) → NO rebuild.
    await act(async () => { setWorkspaceExternal({ id: 1, name: 'IT (renamed)' }); });
    expect(mocks.getEventSource).toHaveBeenCalledTimes(1);

    // Different workspace → deterministic rebuild with the new key.
    await act(async () => { setWorkspaceExternal({ id: 2, name: 'Accounting' }); });
    expect(mocks.getEventSource).toHaveBeenCalledTimes(2);
  });
});
