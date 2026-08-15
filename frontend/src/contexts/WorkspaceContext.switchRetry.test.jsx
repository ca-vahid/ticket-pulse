/** @vitest-environment jsdom */
// Realtime plan Phase 1 — switchWorkspace local/server divergence guard.
// The server-session select used to be fire-and-forget with a swallowed error;
// a failed call left the SESSION on the old workspace (the wrong-SSE-channel
// zombie root). Now: one retry, then a persistent user-visible error.
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  getAll: vi.fn(),
  useAuth: vi.fn(),
}));

vi.mock('../services/api', () => ({
  workspaceAPI: { select: mocks.select, getAll: mocks.getAll },
  setWorkspaceId: vi.fn(),
  setAuthToken: vi.fn(),
}));
vi.mock('./AuthContext', () => ({ useAuth: mocks.useAuth }));

import { WorkspaceProvider, useWorkspace } from './WorkspaceContext';

let ctx;
function Probe() {
  ctx = useWorkspace();
  return null;
}

const workspaces = [
  { id: 1, name: 'IT', slug: 'it', role: 'admin', nativeTicketingEnabled: true },
  { id: 2, name: 'Accounting', slug: 'ap', role: 'admin', nativeTicketingEnabled: true },
];

function renderProvider() {
  mocks.useAuth.mockReturnValue({
    workspaceData: { availableWorkspaces: workspaces, selectedWorkspaceId: 1 },
    isAuthenticated: true,
    isLoading: false,
  });
  return render(
    <WorkspaceProvider>
      <Probe />
    </WorkspaceProvider>,
  );
}

const okSelect = (id) => ({
  authToken: null,
  data: { workspace: workspaces.find((w) => w.id === id) },
});

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  mocks.select.mockReset();
  mocks.getAll.mockReset().mockResolvedValue({ data: workspaces });
  ctx = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('switchWorkspace server-select retry + visible error', () => {
  test('a transient failure is retried once and succeeds silently', async () => {
    mocks.select
      .mockRejectedValueOnce(new Error('network blip'))
      .mockImplementation(async (id) => okSelect(id));
    renderProvider();
    await act(async () => {});

    await act(async () => { ctx.switchWorkspace(2); });
    // First attempt failed → retry is scheduled after a short delay.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    expect(mocks.select).toHaveBeenCalledTimes(2);
    expect(ctx.switchError).toBeNull();
    // Local state switched immediately regardless (persisted for the reload).
    expect(ctx.currentWorkspace?.id).toBe(2);
  });

  test('persistent failure surfaces a visible, reload-surviving error', async () => {
    mocks.select.mockRejectedValue(new Error('server down'));
    renderProvider();
    await act(async () => {});

    await act(async () => { ctx.switchWorkspace(2); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    expect(mocks.select).toHaveBeenCalledTimes(2); // original + one retry
    expect(ctx.switchError).toMatch(/did not reach the server/i);
    // Persisted so the error survives the page reload that follows a switch.
    expect(sessionStorage.getItem('tp_wsSwitchError')).toMatch(/did not reach the server/i);
  });

  test('retryWorkspaceSync clears the error once the server catches up', async () => {
    mocks.select.mockRejectedValue(new Error('server down'));
    renderProvider();
    await act(async () => {});
    await act(async () => { ctx.switchWorkspace(2); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(ctx.switchError).not.toBeNull();

    mocks.select.mockImplementation(async (id) => okSelect(id));
    await act(async () => { await ctx.retryWorkspaceSync(); });

    expect(ctx.switchError).toBeNull();
    expect(sessionStorage.getItem('tp_wsSwitchError')).toBeNull();
  });
});
