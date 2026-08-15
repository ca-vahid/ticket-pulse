/** @vitest-environment jsdom */
// Phase 2 (QA 08-07 #14) — SSE auth resilience: refresh an expired JWT before
// reconnecting, and stop the eternal "connecting" spinner after the retry
// budget is spent (surface 'disconnected' + manual retry instead).
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getEventSource: vi.fn(),
  isAuthTokenExpiring: vi.fn(() => false),
  refreshAuthToken: vi.fn(() => Promise.resolve('fresh-token')),
  getWorkspaceId: vi.fn(() => 1),
}));

vi.mock('../services/api', () => ({
  sseAPI: { getEventSource: mocks.getEventSource },
  isAuthTokenExpiring: mocks.isAuthTokenExpiring,
  refreshAuthToken: mocks.refreshAuthToken,
  getWorkspaceId: mocks.getWorkspaceId,
}));

import { useSSE } from './useSSE';

class FakeEventSource {
  static instances = [];

  constructor() {
    this.listeners = {};
    this.readyState = FakeEventSource.CONNECTING;
    this.onopen = null;
    this.onerror = null;
    this.onmessage = null;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }

  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }

  fail() {
    // Mirrors a fatal HTTP failure (e.g. 401): readyState CLOSED + error event.
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }

  networkError() {
    // Mirrors a network-level failure (backend down): the browser keeps the
    // source in CONNECTING and auto-retries internally — no CLOSED state.
    this.readyState = FakeEventSource.CONNECTING;
    this.onerror?.();
  }

  emit(type, data) {
    (this.listeners[type] || []).forEach((fn) => fn({ data }));
  }
}
FakeEventSource.CONNECTING = 0;
FakeEventSource.OPEN = 1;
FakeEventSource.CLOSED = 2;

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource);
  FakeEventSource.instances = [];
  mocks.getEventSource.mockReset().mockImplementation(() => new FakeEventSource());
  mocks.isAuthTokenExpiring.mockReset().mockReturnValue(false);
  mocks.refreshAuthToken.mockReset().mockResolvedValue('fresh-token');
  mocks.getWorkspaceId.mockReset().mockReturnValue(1);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useSSE token refresh before (re)connect', () => {
  test('refreshes an expired/near-expiry JWT before opening the EventSource', async () => {
    mocks.isAuthTokenExpiring.mockReturnValue(true);

    renderHook(() => useSSE({ enabled: true }));
    await act(async () => {});

    expect(mocks.refreshAuthToken).toHaveBeenCalledTimes(1);
    expect(mocks.getEventSource).toHaveBeenCalledTimes(1);
    // Refresh happens BEFORE the stream opens — otherwise the dead token
    // would just 401 again.
    expect(mocks.refreshAuthToken.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.getEventSource.mock.invocationCallOrder[0]);
  });

  test('skips the refresh when the token is still healthy', async () => {
    renderHook(() => useSSE({ enabled: true }));
    await act(async () => {});

    expect(mocks.refreshAuthToken).not.toHaveBeenCalled();
    expect(mocks.getEventSource).toHaveBeenCalledTimes(1);
  });

  test('checks token freshness again on every reconnect attempt', async () => {
    vi.useFakeTimers();
    renderHook(() => useSSE({ enabled: true }));
    await act(async () => {});
    expect(mocks.isAuthTokenExpiring).toHaveBeenCalledTimes(1);

    // Token expires while the stream dies → the reconnect must refresh first.
    mocks.isAuthTokenExpiring.mockReturnValue(true);
    await act(async () => { FakeEventSource.instances.at(-1).fail(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    expect(mocks.refreshAuthToken).toHaveBeenCalledTimes(1);
    expect(mocks.getEventSource).toHaveBeenCalledTimes(2);
  });
});

describe('useSSE retry budget + manual retry', () => {
  test("transitions to 'disconnected' after 8 consecutive failures instead of connecting forever", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSSE({ enabled: true }));
    await act(async () => {});

    // Initial attempt + 8 budgeted retries all fail.
    for (let attempt = 0; attempt < 9; attempt++) {
      expect(result.current.connectionStatus).toBe('connecting');
      await act(async () => { FakeEventSource.instances.at(-1).fail(); });
      // Backoff: 1s, 2s, 4s ... capped at 15s — advance far enough for any.
      await act(async () => { await vi.advanceTimersByTimeAsync(16000); });
    }

    expect(result.current.connectionStatus).toBe('disconnected');
    // The budget stops new attempts: 1 initial + 8 retries.
    expect(mocks.getEventSource).toHaveBeenCalledTimes(9);
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(mocks.getEventSource).toHaveBeenCalledTimes(9);
  });

  test("network-level failures (browser-internal retry, readyState CONNECTING) also spend the budget and reach 'disconnected'", async () => {
    const { result } = renderHook(() => useSSE({ enabled: true }));
    await act(async () => {});
    const source = FakeEventSource.instances.at(-1);

    for (let attempt = 0; attempt < 7; attempt++) {
      await act(async () => { source.networkError(); });
      expect(result.current.connectionStatus).toBe('connecting');
    }
    await act(async () => { source.networkError(); });
    expect(result.current.connectionStatus).toBe('disconnected');
    // The dead source was closed so the browser stops its internal retry loop.
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
  });

  test('retry() resets the budget, reconnects, and can succeed', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSSE({ enabled: true }));
    await act(async () => {});

    for (let attempt = 0; attempt < 9; attempt++) {
      await act(async () => { FakeEventSource.instances.at(-1).fail(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(16000); });
    }
    expect(result.current.connectionStatus).toBe('disconnected');
    const attemptsBeforeRetry = mocks.getEventSource.mock.calls.length;

    await act(async () => { result.current.retry(); });
    expect(mocks.getEventSource).toHaveBeenCalledTimes(attemptsBeforeRetry + 1);
    expect(result.current.connectionStatus).toBe('connecting');

    await act(async () => { FakeEventSource.instances.at(-1).open(); });
    expect(result.current.connectionStatus).toBe('connected');
  });
});

// Realtime plan Phase 1 — retry-budget honesty: a bare onopen proves nothing
// (an inspecting proxy can forward headers then stall). Success is credited
// only by a real server event or 10s of stability.
describe('useSSE retry budget honesty (no reset on bare onopen)', () => {
  test("an open→error flap loop still reaches 'disconnected' within the budget", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSSE({ enabled: true }));
    await act(async () => {});

    // Each cycle: the connection OPENS (which used to reset the budget and
    // made Offline unreachable) then dies before proving itself.
    for (let attempt = 0; attempt < 9; attempt++) {
      const source = FakeEventSource.instances.at(-1);
      await act(async () => { source.open(); });
      await act(async () => { source.fail(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(16000); });
    }

    expect(result.current.connectionStatus).toBe('disconnected');
  });

  test('a real server event (connected) credits success and restores the full budget', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSSE({ enabled: true }));
    await act(async () => {});

    // Burn most of the budget…
    for (let attempt = 0; attempt < 6; attempt++) {
      await act(async () => { FakeEventSource.instances.at(-1).fail(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(16000); });
    }
    expect(result.current.connectionStatus).toBe('connecting');

    // …then a PROVEN connection (server event, not just onopen)…
    const source = FakeEventSource.instances.at(-1);
    await act(async () => { source.open(); });
    await act(async () => {
      source.emit('connected', JSON.stringify({ message: 'ok', workspaceId: 1 }));
    });
    expect(result.current.connectionStatus).toBe('connected');

    // …restores the FULL budget: 8 more failures before disconnected.
    for (let attempt = 0; attempt < 8; attempt++) {
      await act(async () => { FakeEventSource.instances.at(-1).fail(); });
      expect(result.current.connectionStatus).toBe('connecting');
      await act(async () => { await vi.advanceTimersByTimeAsync(16000); });
    }
    await act(async () => { FakeEventSource.instances.at(-1).fail(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(16000); });
    expect(result.current.connectionStatus).toBe('disconnected');
  });

  test('10 seconds of stability also credits success', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSSE({ enabled: true }));
    await act(async () => {});

    for (let attempt = 0; attempt < 6; attempt++) {
      await act(async () => { FakeEventSource.instances.at(-1).fail(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(16000); });
    }

    const source = FakeEventSource.instances.at(-1);
    await act(async () => { source.open(); });
    // Stays open 10s with zero events — that is stability, credit it.
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });

    for (let attempt = 0; attempt < 8; attempt++) {
      await act(async () => { FakeEventSource.instances.at(-1).fail(); });
      expect(result.current.connectionStatus).toBe('connecting');
      await act(async () => { await vi.advanceTimersByTimeAsync(16000); });
    }
    await act(async () => { FakeEventSource.instances.at(-1).fail(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(16000); });
    expect(result.current.connectionStatus).toBe('disconnected');
  });

  test('exposes the reconnect-churn counter for diagnostics', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSSE({ enabled: true }));
    await act(async () => {});
    expect(result.current.getReconnectChurn()).toBe(1); // initial attempt

    await act(async () => { FakeEventSource.instances.at(-1).fail(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(16000); });
    expect(result.current.getReconnectChurn()).toBeGreaterThanOrEqual(2);
  });
});

// Realtime plan Phase 1 — channel membership proof: heartbeats carry the
// server channel's workspaceId; a mismatch means this tab is a wrong-channel
// zombie ("Live" pill, frozen data) and must reconnect with a corrected URL.
describe('useSSE wrong-channel detection', () => {
  test('heartbeat for another workspace closes the stream and reconnects', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderHook(() => useSSE({ enabled: true }));
    await act(async () => {});

    const source = FakeEventSource.instances.at(-1);
    await act(async () => { source.open(); });
    expect(mocks.getEventSource).toHaveBeenCalledTimes(1);

    // Server says channel workspace 2; this tab expects 1.
    await act(async () => {
      source.emit('heartbeat', JSON.stringify({ ts: Date.now(), workspaceId: 2 }));
    });

    expect(source.readyState).toBe(FakeEventSource.CLOSED);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(16000); });
    // Reconnected — getEventSource re-reads the current workspace, so the
    // new stream URL is corrected.
    expect(mocks.getEventSource).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  test('matching heartbeats keep the stream (and still feed the watchdog)', async () => {
    renderHook(() => useSSE({ enabled: true }));
    await act(async () => {});
    const source = FakeEventSource.instances.at(-1);
    await act(async () => { source.open(); });
    await act(async () => {
      source.emit('heartbeat', JSON.stringify({ ts: Date.now(), workspaceId: 1 }));
    });
    expect(source.readyState).toBe(FakeEventSource.OPEN);
    expect(mocks.getEventSource).toHaveBeenCalledTimes(1);
  });

  test('connected event with a mismatched workspace also forces the reconnect', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onConnected = vi.fn();
    renderHook(() => useSSE({ enabled: true, onConnected }));
    await act(async () => {});

    const source = FakeEventSource.instances.at(-1);
    await act(async () => {
      source.emit('connected', JSON.stringify({ message: 'ok', workspaceId: 9 }));
    });

    expect(source.readyState).toBe(FakeEventSource.CLOSED);
    // Consumers must NOT run their catch-up refetch against the wrong channel.
    expect(onConnected).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(16000); });
    expect(mocks.getEventSource).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });
});

// Realtime plan Phase 1 — the terminal "stuck connect": a connect() parked on
// a never-settling token refresh left status 'connecting' with no
// EventSource, no timer, and a watchdog that early-returned on the null
// source. The watchdog must detect that shape and force the reconnect ladder.
describe('useSSE watchdog stuck-connect recovery', () => {
  test('a connect() hung on token refresh is rescued by the watchdog', async () => {
    vi.useFakeTimers();
    // First connect: token "expiring", refresh never settles (the MSAL
    // deadlock class). Subsequent attempts: token healthy.
    mocks.isAuthTokenExpiring.mockReturnValueOnce(true).mockReturnValue(false);
    mocks.refreshAuthToken.mockImplementationOnce(() => new Promise(() => {}));

    const { result } = renderHook(() => useSSE({ enabled: true }));
    await act(async () => {});

    // Parked: no EventSource was ever created.
    expect(mocks.getEventSource).not.toHaveBeenCalled();
    expect(result.current.connectionStatus).toBe('connecting');

    // Watchdog ticks every 15s; the connect counts as stuck after 30s.
    await act(async () => { await vi.advanceTimersByTimeAsync(46000); });
    // Rescue scheduled with backoff — let it fire.
    await act(async () => { await vi.advanceTimersByTimeAsync(16000); });

    expect(mocks.getEventSource).toHaveBeenCalledTimes(1);
    await act(async () => { FakeEventSource.instances.at(-1).open(); });
    expect(result.current.connectionStatus).toBe('connected');
  });
});
