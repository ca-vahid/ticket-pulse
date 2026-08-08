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
}));

vi.mock('../services/api', () => ({
  sseAPI: { getEventSource: mocks.getEventSource },
  isAuthTokenExpiring: mocks.isAuthTokenExpiring,
  refreshAuthToken: mocks.refreshAuthToken,
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
