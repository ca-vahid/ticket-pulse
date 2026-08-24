/** @vitest-environment jsdom */
// Honest pill (QA 08-19 #3): useRealtimeStatus is a status-only, ALWAYS-ON
// subscription to the shared realtime client — it mirrors {state, transport}
// snapshots, keeps the client (and its manual Retry) alive wherever the
// header renders, and registers no data callbacks.
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ client: null }));

class FakeRealtimeClient {
  constructor() {
    this.state = 'connecting';
    this.transport = null;
    this.subs = [];
    this.retryCalls = 0;
    this.updates = [];
  }

  subscribe(sub) {
    this.subs.push(sub);
    if (sub.onStatus) sub.onStatus({ state: this.state, transport: this.transport });
    return {
      update: (fields) => this.updates.push(fields),
      unsubscribe: () => { this.subs = this.subs.filter((s) => s !== sub); },
    };
  }

  push(state, transport) {
    this.state = state;
    this.transport = transport;
    for (const sub of this.subs) sub.onStatus?.({ state, transport });
  }

  retry() { this.retryCalls += 1; }

  getDiagnostics() {
    return { state: this.state, transport: this.transport, lastEventAt: 123, churn: 4, workspaceId: 1, reason: null };
  }
}

vi.mock('../services/realtimeClient', () => ({
  getSharedRealtimeClient: () => mocks.client,
}));

import { useRealtimeStatus } from './useRealtimeStatus';

function Probe({ workspaceId }) {
  const rt = useRealtimeStatus(workspaceId);
  return (
    <div>
      <span data-testid="state">{String(rt.state)}</span>
      <span data-testid="transport">{String(rt.transport)}</span>
      <span data-testid="active">{String(rt.active)}</span>
      <button type="button" onClick={rt.retry}>retry</button>
      <span data-testid="churn">{rt.getReconnectChurn()}</span>
    </div>
  );
}

beforeEach(() => { mocks.client = new FakeRealtimeClient(); });
afterEach(() => cleanup());

describe('useRealtimeStatus', () => {
  test('subscribes enabled with NO data callbacks and mirrors status pushes', () => {
    render(<Probe workspaceId={1} />);
    expect(mocks.client.subs.length).toBe(1);
    expect(mocks.client.subs[0].enabled).toBe(true);
    expect(Object.keys(mocks.client.subs[0].callbacks || {})).toEqual([]);
    expect(screen.getByTestId('state')).toHaveTextContent('connecting');

    act(() => mocks.client.push('live-sse', 'sse'));
    expect(screen.getByTestId('state')).toHaveTextContent('live-sse');
    expect(screen.getByTestId('transport')).toHaveTextContent('sse');

    act(() => mocks.client.push('offline', null));
    expect(screen.getByTestId('state')).toHaveTextContent('offline');
    expect(screen.getByTestId('active')).toHaveTextContent('true');
  });

  test('retry proxies to the shared client and diagnostics read through', () => {
    render(<Probe workspaceId={1} />);
    screen.getByText('retry').click();
    expect(mocks.client.retryCalls).toBe(1);
    expect(screen.getByTestId('churn')).toHaveTextContent('4');
  });

  test('workspace change nudges the subscription (re-evaluate) without resubscribing', () => {
    const { rerender } = render(<Probe workspaceId={1} />);
    rerender(<Probe workspaceId={2} />);
    expect(mocks.client.subs.length).toBe(1); // still ONE subscription
    expect(mocks.client.updates.at(-1)).toEqual({ expectedWorkspaceId: 2 });
  });

  test('unsubscribes on unmount', () => {
    const { unmount } = render(<Probe workspaceId={1} />);
    unmount();
    expect(mocks.client.subs.length).toBe(0);
  });
});
