/** @vitest-environment jsdom */
// Realtime plan Phase 2 — useSSE as a subscription facade over the SHARED
// realtime client: unchanged external API, one subscription per hook
// instance, callback churn never resubscribes, status mapping preserves the
// v3.4.00 three-state vocabulary.
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ client: null }));

class FakeRealtimeClient {
  constructor() {
    this.subs = [];
    this.retryCalls = 0;
    this.diag = { state: 'live-sse', transport: 'sse', lastEventAt: 123, churn: 4, workspaceId: 1 };
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

  setStatus(state, transport) {
    for (const rec of this.subs) {
      if (rec.onStatus && !rec.unsubscribed) rec.onStatus({ state, transport });
    }
  }

  emit(name, data) {
    for (const rec of this.subs) {
      if (rec.unsubscribed || rec.enabled === false) continue;
      const cb = rec.callbacks || {};
      const map = {
        'sync-completed': cb.onSyncCompleted,
        'ticket-change': cb.onTicketChange,
        presence: cb.onPresence,
        connected: cb.onConnected,
      };
      if (map[name]) map[name](data);
      if (rec.onEvent && name !== 'presence' && name !== 'connected') {
        rec.onEvent({ type: name, data, timestamp: Date.now() });
      }
    }
  }

  emitResync(payload = { resync: true, reason: 'test' }) {
    for (const rec of this.subs) {
      if (rec.unsubscribed || rec.enabled === false) continue;
      const cb = rec.callbacks || {};
      if (cb.onResync) cb.onResync(payload);
      else {
        if (cb.onConnected) cb.onConnected(payload);
        if (cb.onSyncCompleted) cb.onSyncCompleted(payload);
      }
    }
  }

  retry() { this.retryCalls += 1; }

  getDiagnostics() { return this.diag; }
}

vi.mock('../services/realtimeClient', () => ({
  getSharedRealtimeClient: () => mocks.client,
}));

import { useSSE } from './useSSE';

beforeEach(() => {
  mocks.client = new FakeRealtimeClient();
});

afterEach(() => {
  cleanup();
});

describe('useSSE facade — subscription lifecycle', () => {
  test('subscribes once and unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useSSE({ enabled: true, reconnectKey: 1 }));
    expect(mocks.client.subs).toHaveLength(1);
    unmount();
    expect(mocks.client.subs[0].unsubscribed).toBe(true);
  });

  test('callback identity churn does NOT resubscribe (and events reach the LATEST callback)', () => {
    let received = [];
    const { rerender } = renderHook(
      ({ tag }) => useSSE({ enabled: true, onTicketChange: (d) => received.push([tag, d]) }),
      { initialProps: { tag: 'v1' } },
    );
    rerender({ tag: 'v2' });
    rerender({ tag: 'v3' });
    expect(mocks.client.subs).toHaveLength(1);

    act(() => { mocks.client.emit('ticket-change', { ticketId: 9 }); });
    expect(received).toEqual([['v3', { ticketId: 9 }]]);
  });

  test('enabled/reconnectKey changes flow through update()', () => {
    const { rerender } = renderHook(
      ({ enabled, key }) => useSSE({ enabled, reconnectKey: key }),
      { initialProps: { enabled: true, key: 1 } },
    );
    rerender({ enabled: true, key: 2 });
    const rec = mocks.client.subs[0];
    expect(rec.expectedWorkspaceId).toBe(2);
    rerender({ enabled: false, key: 2 });
    expect(rec.enabled).toBe(false);
  });
});

describe('useSSE facade — status mapping', () => {
  test('live-sse and live-poll both read as connected; offline as disconnected', () => {
    const { result } = renderHook(() => useSSE({ enabled: true }));
    expect(result.current.connectionStatus).toBe('connecting');

    act(() => { mocks.client.setStatus('live-sse', 'sse'); });
    expect(result.current.connectionStatus).toBe('connected');
    expect(result.current.isConnected).toBe(true);
    expect(result.current.transportStatus).toBe('live-sse');
    expect(result.current.transport).toBe('sse');

    act(() => { mocks.client.setStatus('live-poll', 'longpoll'); });
    expect(result.current.connectionStatus).toBe('connected');
    expect(result.current.transportStatus).toBe('live-poll');

    act(() => { mocks.client.setStatus('offline', null); });
    expect(result.current.connectionStatus).toBe('disconnected');
  });

  test('a disabled hook reports disconnected regardless of the shared state', () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useSSE({ enabled }),
      { initialProps: { enabled: true } },
    );
    act(() => { mocks.client.setStatus('live-sse', 'sse'); });
    expect(result.current.connectionStatus).toBe('connected');
    rerender({ enabled: false });
    expect(result.current.connectionStatus).toBe('disconnected');
  });
});

describe('useSSE facade — events + controls', () => {
  test('data events populate lastEvent', () => {
    const { result } = renderHook(() => useSSE({ enabled: true }));
    act(() => { mocks.client.emit('sync-completed', { syncType: 'full' }); });
    expect(result.current.lastEvent).toMatchObject({ type: 'sync-completed', data: { syncType: 'full' } });
  });

  test('onResync consumers receive resync; others get the synthetic pair', () => {
    const onResync = vi.fn();
    const onConnected = vi.fn();
    const onSyncCompleted = vi.fn();
    renderHook(() => useSSE({ enabled: true, onResync }));
    renderHook(() => useSSE({ enabled: true, onConnected, onSyncCompleted }));
    act(() => { mocks.client.emitResync(); });
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(onConnected).toHaveBeenCalledWith(expect.objectContaining({ resync: true }));
    expect(onSyncCompleted).toHaveBeenCalledWith(expect.objectContaining({ resync: true }));
  });

  test('retry() delegates to the shared client; churn/diagnostics read through', () => {
    const { result } = renderHook(() => useSSE({ enabled: true }));
    act(() => { result.current.retry(); });
    expect(mocks.client.retryCalls).toBe(1);
    expect(result.current.getReconnectChurn()).toBe(4);
    expect(result.current.getDiagnostics()).toMatchObject({ transport: 'sse', workspaceId: 1 });
  });
});
