/** @vitest-environment jsdom */
// Realtime plan Phase 1+2 — deterministic SSE re-key on workspace switch.
// DashboardContext must derive its reconnectKey from the CONTEXT-subscribed
// workspace (useWorkspace().currentWorkspace?.id), so a switch always updates
// the shared realtime client's subscription (which re-keys the connection).
// Reading the module getter at render time only re-keyed on incidental
// re-renders (App.jsx children-bailout meant the provider often did not
// re-render on switch → wrong-channel zombie).
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createContext, useContext, useState } from 'react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  client: null,
}));

vi.mock('../services/api', () => ({
  dashboardAPI: {
    getDashboard: vi.fn(() => Promise.resolve({ success: true, data: {} })),
    getWeeklyDashboard: vi.fn(() => Promise.resolve({ success: true, data: {} })),
    getMonthlyDashboard: vi.fn(() => Promise.resolve({ success: true, data: {} })),
    getWeeklyStats: vi.fn(() => Promise.resolve({ success: true, data: {} })),
  },
  getWorkspaceId: vi.fn(() => 1),
}));

class FakeRealtimeClient {
  constructor() {
    this.subs = [];
  }

  subscribe(sub) {
    const rec = { ...sub, updates: [], unsubscribed: false };
    this.subs.push(rec);
    if (sub.onStatus) sub.onStatus({ state: 'connecting', transport: null });
    return {
      update: (fields) => {
        Object.assign(rec, fields);
        rec.updates.push({ ...fields });
      },
      unsubscribe: () => { rec.unsubscribed = true; },
    };
  }

  retry() {}

  getDiagnostics() {
    return { state: 'connecting', transport: null, lastEventAt: null, churn: 0, workspaceId: 1 };
  }
}

vi.mock('../services/realtimeClient', () => ({
  getSharedRealtimeClient: () => mocks.client,
}));

// Substitute WorkspaceContext with a controllable test context so we can flip
// currentWorkspace without dragging in Auth/MSAL.
const TestWorkspaceContext = createContext(null);
vi.mock('./WorkspaceContext', () => ({
  useWorkspaceOptional: () => useContext(TestWorkspaceContext),
  useWorkspace: () => useContext(TestWorkspaceContext),
}));

import { DashboardProvider } from './DashboardContext';

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
  mocks.client = new FakeRealtimeClient();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('DashboardContext SSE re-key on workspace switch', () => {
  test('switching currentWorkspace re-keys the shared subscription; same id does not', async () => {
    render(<Harness />);
    await act(async () => {});
    const sub = mocks.client.subs.at(-1);
    expect(sub.expectedWorkspaceId).toBe(1);
    const updatesBefore = sub.updates.length;

    // Same id (new object identity) → NO re-key (expectedWorkspaceId stays 1).
    await act(async () => { setWorkspaceExternal({ id: 1, name: 'IT (renamed)' }); });
    expect(sub.expectedWorkspaceId).toBe(1);
    // No update carried a DIFFERENT workspace id.
    expect(sub.updates.slice(updatesBefore).every((u) => u.expectedWorkspaceId === undefined || u.expectedWorkspaceId === 1)).toBe(true);

    // Different workspace → deterministic re-key with the new key.
    await act(async () => { setWorkspaceExternal({ id: 2, name: 'Accounting' }); });
    expect(sub.expectedWorkspaceId).toBe(2);
    expect(sub.unsubscribed).toBe(false);
  });
});
