/** @vitest-environment jsdom */
// Realtime plan Phase 2 — the shared-client transport ladder:
// SSE → long-poll → short-poll → offline, sticky degrade + re-probe/promote,
// replay-cursor dedupe, resync fan-out, single-connection fan-out to many
// subscribers, workspace re-key, wake detection.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RealtimeClient, REPROBE_DELAYS_MS } from './realtimeClient';

function typedError(type, status = null) {
  const err = new Error(type);
  err.type = type;
  err.status = status;
  return err;
}

function makeHarness({ storage = {}, workspaceId = 1 } = {}) {
  const store = new Map(Object.entries(storage));
  const sseHandles = [];
  const pollCalls = []; // { opts, resolve, reject }
  let currentWorkspace = workspaceId;

  const deps = {
    openSse: vi.fn((opts) => {
      let rejectFinished;
      const handle = {
        opts,
        finished: new Promise((_resolve, reject) => { rejectFinished = reject; }),
        close: vi.fn(() => rejectFinished(typedError('aborted'))),
        emit: (event, data, id = null) => opts.onEvent({
          event,
          data: data === undefined ? '' : JSON.stringify(data),
          id,
          retry: null,
        }),
        fail: (type, status) => rejectFinished(typedError(type, status)),
      };
      sseHandles.push(handle);
      return handle;
    }),
    pollOnce: vi.fn((opts) => new Promise((resolve, reject) => {
      const call = { opts, resolve, reject };
      pollCalls.push(call);
      if (opts.signal) {
        opts.signal.addEventListener('abort', () => reject(typedError('aborted')), { once: true });
      }
    })),
    getToken: () => 'tok',
    refreshToken: vi.fn(async () => 'tok'),
    isTokenExpiring: vi.fn(() => false),
    getWorkspaceId: vi.fn(() => currentWorkspace),
    baseUrl: 'http://api.test/api',
    scrub: (data) => data,
    storage: {
      get: (key) => (store.has(key) ? store.get(key) : null),
      set: (key, value) => store.set(key, value),
    },
    random: () => 0.5,
  };

  const client = new RealtimeClient(deps);
  // Freeze the performance clock so fake-timer wall advances never read as
  // sleep (tests trigger wake explicitly by keeping perf still).
  let perf = 0;
  client._perfNow = () => perf;

  return {
    client,
    deps,
    sseHandles,
    pollCalls,
    setWorkspace: (id) => { currentWorkspace = id; },
    advancePerf: (ms) => { perf += ms; },
    lastSse: () => sseHandles.at(-1),
    lastPoll: () => pollCalls.at(-1),
  };
}

function makeSubscriber(client, overrides = {}) {
  const record = {
    statuses: [],
    events: [],
    calls: { onSyncCompleted: [], onTicketChange: [], onPresence: [], onConnected: [], onResync: [], onError: [] },
  };
  const callbacks = {};
  for (const name of Object.keys(record.calls)) {
    callbacks[name] = (payload) => record.calls[name].push(payload);
  }
  if (overrides.noResync) delete callbacks.onResync;
  const handle = client.subscribe({
    enabled: overrides.enabled ?? true,
    expectedWorkspaceId: overrides.expectedWorkspaceId ?? 1,
    callbacks,
    onStatus: (s) => record.statuses.push(s.state),
    onEvent: (evt) => record.events.push(evt),
  });
  return { record, handle };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RealtimeClient — SSE happy path + fan-out', () => {
  test('one shared connection serves two subscribers; hello goes live; data fans out once each', async () => {
    const h = makeHarness();
    const a = makeSubscriber(h.client);
    const b = makeSubscriber(h.client);

    expect(h.deps.openSse).toHaveBeenCalledTimes(1);
    expect(h.lastSse().opts.url).toContain('workspaceId=1');

    h.lastSse().emit('hello', { epoch: 'e1', workspaceId: 1, lastEventId: 'e1:10' });
    expect(h.client.state).toBe('live-sse');
    expect(h.client.cursor).toBe('e1:10');
    expect(a.record.statuses.at(-1)).toBe('live-sse');
    expect(b.record.statuses.at(-1)).toBe('live-sse');

    h.lastSse().emit('ticket-change', { action: 'created', ticketId: 5 }, 'e1:11');
    expect(a.record.calls.onTicketChange).toHaveLength(1);
    expect(b.record.calls.onTicketChange).toHaveLength(1);
    expect(h.client.cursor).toBe('e1:11');

    // Still ONE connection.
    expect(h.deps.openSse).toHaveBeenCalledTimes(1);
    await flush();
  });

  test('duplicate event ids are deduped (transport-overlap safety)', async () => {
    const h = makeHarness();
    const a = makeSubscriber(h.client);
    h.lastSse().emit('hello', { epoch: 'e1', workspaceId: 1, lastEventId: 'e1:0' });
    h.lastSse().emit('ticket-change', { ticketId: 1 }, 'e1:1');
    h.lastSse().emit('ticket-change', { ticketId: 1 }, 'e1:1'); // replayed duplicate
    h.lastSse().emit('ticket-change', { ticketId: 2 }, 'e1:2');
    expect(a.record.calls.onTicketChange).toHaveLength(2);
  });

  test('a subscriber joining an ALREADY-LIVE connection gets a synthesized connected (Tickets catch-up counter semantics)', async () => {
    const h = makeHarness();
    makeSubscriber(h.client);
    h.lastSse().emit('hello', { epoch: 'e1', workspaceId: 1, lastEventId: 'e1:0' });
    h.lastSse().emit('connected', { message: 'ok', workspaceId: 1 });

    const late = makeSubscriber(h.client);
    await flush();
    expect(late.record.calls.onConnected).toHaveLength(1);
    expect(late.record.calls.onConnected[0].workspaceId).toBe(1);
    // Still one connection — no per-subscriber stream.
    expect(h.deps.openSse).toHaveBeenCalledTimes(1);
  });

  test('a disabled subscriber gets no events; connection persists while another is enabled', async () => {
    const h = makeHarness();
    const a = makeSubscriber(h.client);
    const b = makeSubscriber(h.client);
    b.handle.update({ enabled: false });
    h.lastSse().emit('hello', { epoch: 'e1', workspaceId: 1, lastEventId: 'e1:0' });
    h.lastSse().emit('sync-completed', { ok: 1 }, 'e1:1');
    expect(a.record.calls.onSyncCompleted).toHaveLength(1);
    expect(b.record.calls.onSyncCompleted).toHaveLength(0);
  });

  test('reconnect after a stream failure sends Last-Event-ID', async () => {
    const h = makeHarness();
    makeSubscriber(h.client);
    h.lastSse().emit('hello', { epoch: 'e1', workspaceId: 1, lastEventId: 'e1:0' });
    h.lastSse().emit('ticket-change', {}, 'e1:5');

    h.lastSse().fail('closed');
    await flush();
    await vi.advanceTimersByTimeAsync(1100); // first backoff step
    expect(h.deps.openSse).toHaveBeenCalledTimes(2);
    expect(h.lastSse().opts.lastEventId).toBe('e1:5');
  });

  test('an epoch change in hello (server restart) triggers a resync fan-out', async () => {
    const h = makeHarness();
    const withResync = makeSubscriber(h.client);
    const withoutResync = makeSubscriber(h.client, { noResync: true });
    h.lastSse().emit('hello', { epoch: 'e1', workspaceId: 1, lastEventId: 'e1:4' });

    h.lastSse().fail('closed');
    await flush();
    await vi.advanceTimersByTimeAsync(1100);
    h.lastSse().emit('hello', { epoch: 'e2', workspaceId: 1, lastEventId: 'e2:0' });

    expect(withResync.record.calls.onResync).toHaveLength(1);
    // Consumers without onResync get the synthetic connected+sync-completed
    // pair their existing catch-up paths already handle.
    expect(withoutResync.record.calls.onConnected.some((p) => p?.resync)).toBe(true);
    expect(withoutResync.record.calls.onSyncCompleted.some((p) => p?.resync)).toBe(true);
    expect(h.client.cursor).toBe('e2:0');
  });

  test('a server resync event (gap exceeded buffer) triggers the resync fan-out', async () => {
    const h = makeHarness();
    const a = makeSubscriber(h.client);
    h.lastSse().emit('hello', { epoch: 'e1', workspaceId: 1, lastEventId: 'e1:900' });
    h.lastSse().emit('resync', { reason: 'gap-or-epoch', cursor: 'e1:900', epoch: 'e1' });
    expect(a.record.calls.onResync).toHaveLength(1);
  });

  test('wrong-channel hello forces a corrected reconnect', async () => {
    const h = makeHarness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    makeSubscriber(h.client);
    h.lastSse().emit('hello', { epoch: 'e1', workspaceId: 9, lastEventId: 'e1:0' });
    expect(h.sseHandles[0].close).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    await flush();
    await vi.advanceTimersByTimeAsync(1100);
    expect(h.deps.openSse).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('RealtimeClient — the ladder', () => {
  async function degradeToLongpoll(h) {
    // 3 SSE failures inside the 90s window → sticky degrade to long-poll.
    for (let i = 0; i < 3; i++) {
      h.lastSse().fail('no-hello');
      await flush();
      await vi.advanceTimersByTimeAsync(5000);
    }
  }

  test('3 SSE failures within the window degrade to long-poll (sticky), data flows via poll', async () => {
    const h = makeHarness();
    const a = makeSubscriber(h.client);
    await degradeToLongpoll(h);

    expect(h.client.transport).toBe('longpoll');
    expect(h.deps.storage.get('tp_rt_transport')).toBe('longpoll');
    expect(h.deps.pollOnce).toHaveBeenCalled();
    // First request is a wait=0 baseline probe (fast state flip)…
    expect(h.lastPoll().opts.url).toContain('wait=0');

    h.lastPoll().resolve({
      events: [{ id: 'e1:1', event: 'ticket-change', data: { ticketId: 7 } }],
      cursor: 'e1:1',
      epoch: 'e1',
    });
    await flush();
    expect(h.client.state).toBe('live-poll');
    expect(a.record.statuses.at(-1)).toBe('live-poll');
    expect(a.record.calls.onTicketChange).toHaveLength(1);
    expect(h.client.cursor).toBe('e1:1');
    // …then the steady state is 25s holds carrying the advanced cursor.
    expect(h.lastPoll().opts.url).toContain('wait=25000');
    expect(h.lastPoll().opts.url).toContain(encodeURIComponent('e1:1'));
  });

  test('poll resync response triggers the full-refetch fan-out', async () => {
    const h = makeHarness({ storage: { tp_rt_transport: 'longpoll' } });
    const a = makeSubscriber(h.client);
    h.lastPoll().resolve({ events: [], cursor: 'e2:50', epoch: 'e2', resync: true });
    await flush();
    expect(a.record.calls.onResync).toHaveLength(1);
    expect(h.client.cursor).toBe('e2:50');
  });

  test('re-probe after 1 min; a successful probe promotes back to SSE and stops polling', async () => {
    const h = makeHarness();
    const a = makeSubscriber(h.client);
    await degradeToLongpoll(h);
    h.lastPoll().resolve({ events: [], cursor: 'e1:0', epoch: 'e1' });
    await flush();
    expect(h.client.state).toBe('live-poll');

    const sseCallsBefore = h.deps.openSse.mock.calls.length;
    await vi.advanceTimersByTimeAsync(REPROBE_DELAYS_MS[0] + 100);
    expect(h.deps.openSse.mock.calls.length).toBe(sseCallsBefore + 1);

    // Probe delivers hello → promote.
    h.lastSse().emit('hello', { epoch: 'e1', workspaceId: 1, lastEventId: 'e1:0' });
    expect(h.client.state).toBe('live-sse');
    expect(h.client.transport).toBe('sse');
    expect(h.deps.storage.get('tp_rt_transport')).toBe('sse');
    expect(a.record.statuses.at(-1)).toBe('live-sse');

    // Data continues on the promoted stream.
    h.lastSse().emit('ticket-change', {}, 'e1:1');
    expect(a.record.calls.onTicketChange).toHaveLength(1);
  });

  test('a failed probe backs off 1 → 5 min while polling stays the source of truth', async () => {
    const h = makeHarness();
    makeSubscriber(h.client);
    await degradeToLongpoll(h);
    h.lastPoll().resolve({ events: [], cursor: 'e1:0', epoch: 'e1' });
    await flush();

    const callsBefore = h.deps.openSse.mock.calls.length;
    await vi.advanceTimersByTimeAsync(REPROBE_DELAYS_MS[0] + 100);
    expect(h.deps.openSse.mock.calls.length).toBe(callsBefore + 1);
    h.lastSse().fail('no-hello');
    await flush();

    // Not at +1 min again…
    await vi.advanceTimersByTimeAsync(REPROBE_DELAYS_MS[0] + 100);
    expect(h.deps.openSse.mock.calls.length).toBe(callsBefore + 1);
    // …but at +5 min.
    await vi.advanceTimersByTimeAsync(REPROBE_DELAYS_MS[1] - REPROBE_DELAYS_MS[0] + 100);
    expect(h.deps.openSse.mock.calls.length).toBe(callsBefore + 2);
  });

  test('repeated long-poll failures drop to short-poll, then offline; retry() restarts at SSE', async () => {
    const h = makeHarness({ storage: { tp_rt_transport: 'longpoll' } });
    const a = makeSubscriber(h.client);

    for (let i = 0; i < 3; i++) {
      h.lastPoll().reject(typedError('network'));
      await flush();
      await vi.advanceTimersByTimeAsync(3500);
    }
    expect(h.client.transport).toBe('shortpoll');
    expect(h.deps.storage.get('tp_rt_transport')).toBe('shortpoll');

    for (let i = 0; i < 3; i++) {
      h.lastPoll().reject(typedError('network'));
      await flush();
      await vi.advanceTimersByTimeAsync(3500);
    }
    expect(h.client.state).toBe('offline');
    expect(a.record.statuses.at(-1)).toBe('offline');
    expect(a.record.calls.onError.length).toBeGreaterThan(0);

    const sseCalls = h.deps.openSse.mock.calls.length;
    h.client.retry();
    expect(h.client.state).toBe('connecting');
    expect(h.deps.openSse.mock.calls.length).toBe(sseCalls + 1);
    expect(h.deps.storage.get('tp_rt_transport')).toBe('sse');
  });

  test('remembered last-good transport starts the next load on polling directly', async () => {
    const h = makeHarness({ storage: { tp_rt_transport: 'longpoll' } });
    makeSubscriber(h.client);
    expect(h.deps.openSse).not.toHaveBeenCalled();
    expect(h.deps.pollOnce).toHaveBeenCalledTimes(1);
  });

  test('a terminal 4xx goes offline without hammering (no auto-retry)', async () => {
    const h = makeHarness();
    makeSubscriber(h.client);
    h.lastSse().fail('terminal', 403);
    await flush();
    expect(h.client.state).toBe('offline');
    await vi.advanceTimersByTimeAsync(120000);
    expect(h.deps.openSse).toHaveBeenCalledTimes(1);
    expect(h.deps.pollOnce).not.toHaveBeenCalled();
  });
});

describe('RealtimeClient — workspace re-key + lifecycle', () => {
  test('workspace switch re-keys the connection deterministically and clears the cursor', async () => {
    const h = makeHarness();
    const a = makeSubscriber(h.client);
    h.lastSse().emit('hello', { epoch: 'e1', workspaceId: 1, lastEventId: 'e1:5' });
    expect(h.client.cursor).toBe('e1:5');

    h.setWorkspace(2);
    a.handle.update({ expectedWorkspaceId: 2 });
    await flush();

    expect(h.deps.openSse).toHaveBeenCalledTimes(2);
    expect(h.lastSse().opts.url).toContain('workspaceId=2');
    expect(h.lastSse().opts.lastEventId).toBeNull();
    expect(h.sseHandles[0].close).toHaveBeenCalled();
  });

  test('unsubscribing the last consumer stops the connection after the grace period', async () => {
    const h = makeHarness();
    const a = makeSubscriber(h.client);
    h.lastSse().emit('hello', { epoch: 'e1', workspaceId: 1, lastEventId: 'e1:0' });
    a.handle.unsubscribe();
    // Grace: a route transition's unmount/mount must not flap the connection.
    expect(h.client.state).toBe('live-sse');
    await vi.advanceTimersByTimeAsync(1100);
    expect(h.client.state).toBe('idle');
    expect(h.sseHandles[0].close).toHaveBeenCalled();
  });

  test('a new subscriber inside the grace window keeps the connection alive', async () => {
    const h = makeHarness();
    const a = makeSubscriber(h.client);
    h.lastSse().emit('hello', { epoch: 'e1', workspaceId: 1, lastEventId: 'e1:0' });
    a.handle.unsubscribe();
    await vi.advanceTimersByTimeAsync(500);
    makeSubscriber(h.client);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.client.state).toBe('live-sse');
    expect(h.deps.openSse).toHaveBeenCalledTimes(1);
  });
});

describe('RealtimeClient — wake/sleep + staleness deadlines', () => {
  test('SSE silence past the stale deadline forces a reconnect (deadline check, not timer trust)', async () => {
    const h = makeHarness();
    makeSubscriber(h.client);
    h.lastSse().emit('hello', { epoch: 'e1', workspaceId: 1, lastEventId: 'e1:0' });
    expect(h.client.state).toBe('live-sse');

    // No heartbeats for >90s. Keep the perf clock in step so this reads as
    // throttling/starvation, not sleep.
    h.advancePerf(105000);
    await vi.advanceTimersByTimeAsync(105000);
    expect(h.sseHandles[0].close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1100);
    expect(h.deps.openSse.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test('wake after a sleep longer than the buffer horizon → token refresh, resync, reconnect', async () => {
    const h = makeHarness();
    const a = makeSubscriber(h.client);
    h.lastSse().emit('hello', { epoch: 'e1', workspaceId: 1, lastEventId: 'e1:0' });

    // Sleep: wall clock jumps 11 min, perf clock stands still.
    h.deps.isTokenExpiring.mockReturnValue(true);
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();

    expect(h.deps.refreshToken).toHaveBeenCalled();
    expect(a.record.calls.onResync).toHaveLength(1);
    // Reconnected after the gap (the old stream can't be trusted).
    expect(h.sseHandles[0].close).toHaveBeenCalled();
    expect(h.deps.openSse.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test('a short background-throttle gap with a live stream does NOT churn the connection', async () => {
    const h = makeHarness();
    makeSubscriber(h.client);
    h.lastSse().emit('hello', { epoch: 'e1', workspaceId: 1, lastEventId: 'e1:0' });

    // 40s wall jump with still perf clock (brief suspend) but the stream has
    // recent events — nothing should be torn down.
    h.lastSse().emit('heartbeat', { ts: Date.now(), workspaceId: 1 });
    vi.setSystemTime(Date.now() + 40 * 1000);
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(h.sseHandles[0].close).not.toHaveBeenCalled();
    expect(h.deps.openSse).toHaveBeenCalledTimes(1);
  });

  test('the online event restarts the ladder from offline', async () => {
    const h = makeHarness({ storage: { tp_rt_transport: 'shortpoll' } });
    makeSubscriber(h.client);
    for (let i = 0; i < 3; i++) {
      h.lastPoll().reject(typedError('network'));
      await flush();
      await vi.advanceTimersByTimeAsync(3500);
    }
    expect(h.client.state).toBe('offline');

    const pollCallsBefore = h.deps.pollOnce.mock.calls.length;
    window.dispatchEvent(new Event('online'));
    await flush();
    expect(h.client.state).not.toBe('offline');
    expect(h.deps.pollOnce.mock.calls.length).toBeGreaterThan(pollCallsBefore);
  });
});
