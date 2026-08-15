// Shared realtime client (realtime plan Phase 2): ONE connection per tab with
// internal fan-out to every consumer (DashboardContext, useApprovalCount,
// Tickets, TicketDetail, ApprovalsInbox), replacing the 2-4 parallel
// EventSources that starved HTTP/1.1's 6-connections-per-origin budget behind
// corporate proxies — and multiplied every reliability bug by five.
//
// Transport ladder (docs/research/REALTIME_RELIABILITY_NOTES.md §4):
//
//   SSE (fetch, Authorization header)
//    └─ 3 failures in ~90s → LONG-POLL (25s holds, same cursor scheme)
//        └─ 3 failures → SHORT-POLL (30s jittered)
//            └─ 3 failures → OFFLINE (manual retry / `online` event)
//
// Degrades are STICKY (sessionStorage remembers the last-good transport so a
// Zscaler user's next load starts on polling instantly) with background SSE
// re-probes at 1 / 5 / 15 min. All transports share the server's per-workspace
// cursor (`epoch:n`), so demotion/promotion never loses or duplicates events.

import {
  API_BASE_URL,
  getAuthToken,
  refreshAuthToken,
  isAuthTokenExpiring,
  getWorkspaceId,
} from './api';
import { openFetchSse, fetchPollOnce } from './sseTransport';
import { isDemoMode, maybeScrub } from '../utils/demoMode';

export const SSE_FAILURE_BUDGET = 3;
export const SSE_FAILURE_WINDOW_MS = 90000;
export const REPROBE_DELAYS_MS = [60000, 300000, 900000];
export const LONGPOLL_WAIT_MS = 25000;
export const SHORTPOLL_INTERVAL_MS = 30000;
export const STALE_MS = 90000;
// Mirrors the server's ring-buffer age bound (RING_MAX_AGE_MS): any silence
// gap longer than this can never be replayed — force a full resync.
export const BUFFER_HORIZON_MS = 10 * 60 * 1000;
export const WAKE_JUMP_MS = 60000;

const POLL_FAILURE_BUDGET = 3;
const POLL_FAILURE_WINDOW_MS = 90000;
const SSE_RETRY_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
const POLL_RETRY_DELAY_MS = 3000;
const TOKEN_EXPIRY_SLACK_MS = 60000;
const WATCHDOG_TICK_MS = 15000;
// Grace before tearing down a subscriber-less connection: route transitions
// unmount one page's hook before the next page's mounts.
const STOP_GRACE_MS = 1000;
const TRANSPORT_MEMORY_KEY = 'tp_rt_transport';

function safeStorage() {
  return {
    get(key) {
      try {
        return typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(key) : null;
      } catch { return null; }
    },
    set(key, value) {
      try {
        if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(key, value);
      } catch { /* unavailable */ }
    },
  };
}

function parseCursor(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  const sep = raw.lastIndexOf(':');
  if (sep <= 0) return null;
  const n = Number(raw.slice(sep + 1));
  if (!Number.isInteger(n) || n < 0) return null;
  return { epoch: raw.slice(0, sep), n };
}

export class RealtimeClient {
  constructor(deps = {}) {
    this.deps = {
      openSse: openFetchSse,
      pollOnce: fetchPollOnce,
      getToken: getAuthToken,
      refreshToken: refreshAuthToken,
      isTokenExpiring: isAuthTokenExpiring,
      getWorkspaceId,
      baseUrl: API_BASE_URL,
      scrub: (data) => maybeScrub(data, isDemoMode()),
      storage: safeStorage(),
      random: Math.random,
      ...deps,
    };

    this.subscribers = new Map();
    this._subSeq = 0;

    // One user-visible state machine: connecting → live-sse | live-poll → offline
    this.state = 'idle';
    this.transport = null; // 'sse' | 'longpoll' | 'shortpoll' | null
    this.targetWorkspaceId = null;
    this.connectedWorkspaceId = null; // proven by server events
    this.cursor = null; // 'epoch:n' — shared across all transports
    this.epoch = null;
    this.lastEventAt = 0;
    this.churn = 0;

    this._session = 0; // bumped on every teardown/re-key; async paths compare
    this._running = false;
    this._sse = null; // active { close, finished } handle
    this._probe = null; // background SSE re-probe handle while polling
    this._pollAbort = null;
    this._sseFailures = [];
    this._pollFailures = [];
    this._sseAttempt = 0; // backoff ladder index within SSE mode
    this._reprobeIndex = 0;
    this._wrongChannelWarned = false;
    this._offlineTerminal = false; // 4xx — don't auto-recover

    this._timers = { sseRetry: null, reprobe: null, stopGrace: null, watchdog: null };
    this._lastTickWall = Date.now();
    this._lastTickPerf = this._perfNow();
    this._listenersBound = false;
    this._boundCheck = () => this._checkDeadlines('event');
    this._boundOnline = () => this._onOnline();
  }

  _perfNow() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }

  // ------------------------------------------------------------------ subs

  /**
   * Register a consumer. `callbacks` mirror useSSE's options (onSyncCompleted,
   * onTicketChange, onPresence, onConnected, onMessage, onSyncSkipped,
   * onError, onResync); `onStatus({state, transport})` feeds the hook's
   * status state; `onEvent` feeds its `lastEvent`.
   */
  subscribe({ enabled = true, expectedWorkspaceId = null, callbacks = {}, onStatus = null, onEvent = null }) {
    const id = ++this._subSeq;
    const sub = { id, enabled, expectedWorkspaceId, callbacks, onStatus, onEvent };
    this.subscribers.set(id, sub);
    this._evaluate();
    if (onStatus) onStatus(this._statusSnapshot());
    if (enabled) this._synthesizeConnectedFor(sub);
    return {
      update: (fields) => {
        const wasEnabled = sub.enabled;
        Object.assign(sub, fields);
        this._evaluate();
        if (sub.onStatus) sub.onStatus(this._statusSnapshot());
        if (!wasEnabled && sub.enabled) this._synthesizeConnectedFor(sub);
      },
      unsubscribe: () => {
        this.subscribers.delete(id);
        this._evaluate();
      },
    };
  }

  /**
   * A consumer joining an ALREADY-LIVE shared connection missed the server's
   * `connected` event. Synthesize one so per-consumer "first connected =
   * mount, later = reconnect" bookkeeping (Tickets' catch-up refetch counter)
   * keeps its pre-shared-client semantics.
   */
  _synthesizeConnectedFor(sub) {
    if (this.state !== 'live-sse' && this.state !== 'live-poll') return;
    const workspaceId = this.connectedWorkspaceId;
    queueMicrotask(() => {
      if (!this.subscribers.has(sub.id) || !sub.enabled) return;
      if (this.state !== 'live-sse' && this.state !== 'live-poll') return;
      try {
        if (sub.callbacks?.onConnected) sub.callbacks.onConnected({ message: 'joined live stream', workspaceId });
      } catch { /* ignore */ }
    });
  }

  _anyEnabled() {
    for (const sub of this.subscribers.values()) {
      if (sub.enabled) return true;
    }
    return false;
  }

  _statusSnapshot() {
    return { state: this.state, transport: this.transport };
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this._notifyStatus();
  }

  _notifyStatus() {
    const snapshot = this._statusSnapshot();
    for (const sub of this.subscribers.values()) {
      if (sub.onStatus) {
        try { sub.onStatus(snapshot); } catch { /* consumer error */ }
      }
    }
  }

  // ------------------------------------------------------------- lifecycle

  _evaluate() {
    const ws = this.deps.getWorkspaceId();
    const wantRunning = this._anyEnabled() && ws !== null && ws !== undefined;

    if (!wantRunning) {
      if (this._running && !this._timers.stopGrace) {
        this._timers.stopGrace = setTimeout(() => {
          this._timers.stopGrace = null;
          if (!this._anyEnabled() || this.deps.getWorkspaceId() == null) this._stop();
        }, STOP_GRACE_MS);
      }
      return;
    }

    if (this._timers.stopGrace) {
      clearTimeout(this._timers.stopGrace);
      this._timers.stopGrace = null;
    }

    if (!this._running) {
      this._start(ws);
    } else if (ws !== this.targetWorkspaceId) {
      // Deterministic re-key on workspace switch (v3.4.00 semantics): tear
      // everything down and rebuild against the new channel with a fresh
      // budget. The cursor is per-workspace — it does not carry over.
      this._rekey(ws);
    }
  }

  _start(ws) {
    this._running = true;
    this._offlineTerminal = false;
    this.targetWorkspaceId = ws;
    this.connectedWorkspaceId = null;
    this._wrongChannelWarned = false;
    this._bindListeners();
    this._startWatchdog();
    this._setState('connecting');

    const remembered = this.deps.storage.get(TRANSPORT_MEMORY_KEY);
    if (remembered === 'longpoll' || remembered === 'shortpoll') {
      // Sticky degrade memory: start on the transport that worked last time
      // instead of re-suffering the 3-failure dance on a hostile network.
      this._enterPolling(remembered);
    } else {
      this._connectSse();
    }
  }

  _stop(finalState = 'idle') {
    this._session += 1;
    this._running = false;
    this._closeSse();
    this._closeProbe();
    this._abortPoll();
    this._clearTimer('sseRetry');
    this._clearTimer('reprobe');
    this._clearTimer('stopGrace');
    this._stopWatchdog();
    this.transport = null;
    this.connectedWorkspaceId = null;
    this._setState(finalState);
  }

  _rekey(ws) {
    this._session += 1;
    this._closeSse();
    this._closeProbe();
    this._abortPoll();
    this._clearTimer('sseRetry');
    this._clearTimer('reprobe');
    this.targetWorkspaceId = ws;
    this.connectedWorkspaceId = null;
    this.cursor = null;
    this._sseFailures = [];
    this._pollFailures = [];
    this._sseAttempt = 0;
    this._reprobeIndex = 0;
    this._wrongChannelWarned = false;
    this._offlineTerminal = false;
    this._setState('connecting');

    const remembered = this.deps.storage.get(TRANSPORT_MEMORY_KEY);
    if (remembered === 'longpoll' || remembered === 'shortpoll') {
      this._enterPolling(remembered);
    } else {
      this._connectSse();
    }
  }

  /** Manual reconnect (header pill): full reset, ladder restarts at SSE. */
  retry() {
    if (!this._anyEnabled()) return;
    this._session += 1;
    this._closeSse();
    this._closeProbe();
    this._abortPoll();
    this._clearTimer('sseRetry');
    this._clearTimer('reprobe');
    this._sseFailures = [];
    this._pollFailures = [];
    this._sseAttempt = 0;
    this._reprobeIndex = 0;
    this._offlineTerminal = false;
    this.deps.storage.set(TRANSPORT_MEMORY_KEY, 'sse');
    this._running = true;
    this.targetWorkspaceId = this.deps.getWorkspaceId();
    this._bindListeners();
    this._startWatchdog();
    this._setState('connecting');
    this._connectSse();
  }

  getDiagnostics() {
    return {
      state: this.state,
      transport: this.transport,
      lastEventAt: this.lastEventAt || null,
      churn: this.churn,
      workspaceId: this.connectedWorkspaceId ?? this.targetWorkspaceId,
      cursor: this.cursor,
      epoch: this.epoch,
    };
  }

  // ------------------------------------------------------------------- SSE

  async _connectSse({ probe = false } = {}) {
    const session = this._session;
    if (!probe) {
      this.transport = 'sse';
      if (this.state !== 'live-poll') this._setState('connecting');
    }

    // Pre-connect token refresh (timeboxed upstream in api.js): reconnecting
    // with a dead token just burns a failure on a guaranteed 401.
    if (this.deps.isTokenExpiring(TOKEN_EXPIRY_SLACK_MS)) {
      try { await this.deps.refreshToken(); } catch { /* connect may still work */ }
      if (session !== this._session) return;
    }

    this.churn += 1;
    const ws = this.targetWorkspaceId;
    const url = `${this.deps.baseUrl}/sse/events?workspaceId=${encodeURIComponent(ws)}`;
    const box = {};
    box.handle = this.deps.openSse({
      url,
      getToken: this.deps.getToken,
      refreshToken: this.deps.refreshToken,
      lastEventId: this.cursor,
      onEvent: (evt) => this._onSseEvent(evt, session, box),
    });
    if (probe) this._probe = box.handle;
    else this._sse = box.handle;

    box.handle.finished.catch((err) => {
      if (session !== this._session) return;
      this._onSseEnd(err, box);
    });
  }

  _closeSse() {
    if (this._sse) {
      const handle = this._sse;
      this._sse = null;
      try { handle.close(); } catch { /* already closed */ }
    }
  }

  _closeProbe() {
    if (this._probe) {
      const handle = this._probe;
      this._probe = null;
      try { handle.close(); } catch { /* already closed */ }
    }
  }

  _onSseEvent(evt, session, box) {
    if (session !== this._session) return;
    const isProbe = this._probe === box.handle;
    if (!isProbe && this._sse !== box.handle) return; // orphaned handle

    let data = null;
    try {
      data = evt.data ? JSON.parse(evt.data) : null;
    } catch { /* malformed payload */ }

    switch (evt.event) {
    case 'hello': {
      if (this._isWrongChannel(data?.workspaceId)) return;
      const serverEpoch = data?.epoch || null;
      if (this.epoch && serverEpoch && serverEpoch !== this.epoch) {
        // Backend restarted: the old cursor belongs to a dead epoch —
        // adopt the new baseline and force a full refetch.
        this.epoch = serverEpoch;
        this.cursor = data?.lastEventId || null;
        this._emitResync('server-restart');
      } else {
        if (serverEpoch) this.epoch = serverEpoch;
        if (!this.cursor && data?.lastEventId) this.cursor = data.lastEventId;
      }
      this.lastEventAt = Date.now();
      if (isProbe) this._promoteProbe(box.handle);
      else this._markSseLive();
      break;
    }
    case 'connected': {
      if (this._isWrongChannel(data?.workspaceId)) return;
      this.lastEventAt = Date.now();
      if (isProbe) this._promoteProbe(box.handle);
      else this._markSseLive();
      this._fanoutConnected(this.deps.scrub(data));
      break;
    }
    case 'heartbeat': {
      // A wrong-channel heartbeat must NOT feed the watchdog — that is
      // exactly how zombies stayed "Live" with frozen data.
      if (data && typeof data === 'object' && this._isWrongChannel(data.workspaceId)) return;
      this.lastEventAt = Date.now();
      if (!isProbe) this._markSseLive();
      break;
    }
    case 'resync': {
      this.lastEventAt = Date.now();
      if (data?.epoch) this.epoch = data.epoch;
      if (data?.cursor) this.cursor = data.cursor;
      this._emitResync('server-resync');
      break;
    }
    default: {
      this.lastEventAt = Date.now();
      if (!isProbe) this._markSseLive();
      // Dedupe across transport overlap (poll + probe replay): cursor ids
      // are monotonic per workspace within an epoch.
      if (evt.id && !this._advanceCursor(evt.id)) return;
      this._dispatchData(evt.event, this.deps.scrub(data));
      break;
    }
    }
  }

  _markSseLive() {
    if (this.state === 'live-sse' && this.transport === 'sse') return;
    this.transport = 'sse';
    this.connectedWorkspaceId = this.targetWorkspaceId;
    this._sseFailures = [];
    this._sseAttempt = 0;
    this._reprobeIndex = 0;
    this.deps.storage.set(TRANSPORT_MEMORY_KEY, 'sse');
    this._setState('live-sse');
  }

  _promoteProbe(handle) {
    // The background probe proved SSE works again — promote it to the live
    // stream and retire the poll loop. Cursor-id dedupe makes the overlap
    // window safe.
    this._probe = null;
    this._closeSse();
    this._sse = handle;
    this._abortPoll();
    this._clearTimer('reprobe');
    this._markSseLive();
  }

  _onSseEnd(err, box) {
    const wasProbe = this._probe === box.handle;
    if (err?.type === 'aborted') return;

    if (wasProbe) {
      this._probe = null;
      this._reprobeIndex = Math.min(this._reprobeIndex + 1, REPROBE_DELAYS_MS.length - 1);
      this._scheduleReprobe();
      return;
    }
    if (this._sse !== box.handle) return; // superseded
    this._sse = null;

    if (err?.type === 'terminal' || err?.type === 'auth') {
      // 4xx (or credentials dead even after a refresh): polling would fail
      // identically — do not hammer. Offline with a manual Reconnect.
      this._goOffline({ terminal: true });
      return;
    }

    this._recordSseFailure();
    if (this._sseFailuresInWindow() >= SSE_FAILURE_BUDGET) {
      this._degradeToPolling();
    } else {
      this._scheduleSseRetry();
    }
  }

  _recordSseFailure() {
    const now = Date.now();
    this._sseFailures.push(now);
    this._sseFailures = this._sseFailures.filter((t) => now - t <= SSE_FAILURE_WINDOW_MS);
  }

  _sseFailuresInWindow() {
    const now = Date.now();
    return this._sseFailures.filter((t) => now - t <= SSE_FAILURE_WINDOW_MS).length;
  }

  _scheduleSseRetry() {
    if (!this._running) return;
    this._clearTimer('sseRetry');
    this._setState('connecting');
    const delay = SSE_RETRY_BACKOFF_MS[Math.min(this._sseAttempt, SSE_RETRY_BACKOFF_MS.length - 1)];
    this._sseAttempt += 1;
    this._timers.sseRetry = setTimeout(() => {
      this._timers.sseRetry = null;
      this._connectSse();
    }, delay);
  }

  _isWrongChannel(serverWorkspaceId) {
    const expected = this.deps.getWorkspaceId();
    if (expected === null || expected === undefined) return false;
    if (serverWorkspaceId === null || serverWorkspaceId === undefined) return false;
    if (Number(serverWorkspaceId) === Number(expected)) return false;
    if (!this._wrongChannelWarned) {
      this._wrongChannelWarned = true;
      // eslint-disable-next-line no-console
      console.warn(`[realtime] Stream is on workspace channel ${serverWorkspaceId} but this tab expects ${expected} — reconnecting with corrected URL`);
    }
    // The corrected URL re-reads getWorkspaceId() via targetWorkspaceId.
    this.targetWorkspaceId = expected;
    this.cursor = null;
    this._closeSse();
    this._closeProbe();
    this._recordSseFailure();
    this._scheduleSseRetry();
    return true;
  }

  // --------------------------------------------------------------- polling

  _degradeToPolling() {
    // Sticky degrade: remember it so the next page load starts here.
    this.deps.storage.set(TRANSPORT_MEMORY_KEY, 'longpoll');
    this._reprobeIndex = 0;
    this._enterPolling('longpoll');
  }

  _enterPolling(mode) {
    this._closeSse();
    this.transport = mode;
    if (this.state !== 'live-poll') this._setState('connecting');
    this._scheduleReprobe();
    this._pollLoop();
  }

  _abortPoll() {
    if (this._pollAbort) {
      const controller = this._pollAbort;
      this._pollAbort = null;
      try { controller.abort(); } catch { /* already aborted */ }
    }
  }

  async _pollLoop() {
    const session = this._session;
    // Generation guard: entering polling again (wake recovery, mode change)
    // must retire any previous loop even if it was between requests.
    this._pollGen = (this._pollGen || 0) + 1;
    const gen = this._pollGen;
    this._abortPoll();
    const controller = new AbortController();
    this._pollAbort = controller;

    // The FIRST request is a wait=0 baseline probe: it proves the transport
    // (state flips to live-poll within ~1 RTT of degrading) instead of hiding
    // behind a silent 25s hold while the pill says "Connecting".
    let firstRequest = true;

    while (
      session === this._session
      && gen === this._pollGen
      && this._running
      && (this.transport === 'longpoll' || this.transport === 'shortpoll')
    ) {
      const mode = this.transport;
      const waitMs = mode === 'longpoll' && !firstRequest ? LONGPOLL_WAIT_MS : 0;
      firstRequest = false;
      try {
        if (this.deps.isTokenExpiring(TOKEN_EXPIRY_SLACK_MS)) {
          try { await this.deps.refreshToken(); } catch { /* poll may still work */ }
          if (session !== this._session || gen !== this._pollGen) return;
        }
        const params = new URLSearchParams();
        params.set('workspaceId', String(this.targetWorkspaceId));
        params.set('wait', String(waitMs));
        if (this.cursor) params.set('cursor', this.cursor);
        const resp = await this.deps.pollOnce({
          url: `${this.deps.baseUrl}/sse/poll?${params.toString()}`,
          getToken: this.deps.getToken,
          refreshToken: this.deps.refreshToken,
          signal: controller.signal,
          timeoutMs: waitMs + 15000,
        });
        if (session !== this._session || gen !== this._pollGen) return;

        this.lastEventAt = Date.now();
        this._pollFailures = [];
        this.connectedWorkspaceId = this.targetWorkspaceId;
        this._setState('live-poll');

        if (resp?.epoch && this.epoch && resp.epoch !== this.epoch) {
          this.epoch = resp.epoch;
          this.cursor = resp.cursor || null;
          this._emitResync('server-restart');
        } else {
          if (resp?.epoch && !this.epoch) this.epoch = resp.epoch;
          if (resp?.resync) {
            if (resp.cursor) this.cursor = resp.cursor;
            this._emitResync('poll-resync');
          } else {
            for (const e of resp?.events || []) {
              if (e.id && !this._advanceCursor(e.id)) continue;
              this._dispatchData(e.event, this.deps.scrub(e.data));
            }
            if (resp?.cursor) this._adoptCursor(resp.cursor);
          }
        }

        if (mode === 'shortpoll') {
          const jitter = 0.8 + this.deps.random() * 0.4; // ±20%
          await this._sleep(SHORTPOLL_INTERVAL_MS * jitter);
        }
      } catch (err) {
        if (session !== this._session || err?.type === 'aborted') return;
        if (err?.type === 'terminal' || err?.type === 'auth') {
          this._goOffline({ terminal: true });
          return;
        }
        const now = Date.now();
        this._pollFailures.push(now);
        this._pollFailures = this._pollFailures.filter((t) => now - t <= POLL_FAILURE_WINDOW_MS);
        if (this._pollFailures.length >= POLL_FAILURE_BUDGET) {
          if (mode === 'longpoll') {
            this.transport = 'shortpoll';
            this.deps.storage.set(TRANSPORT_MEMORY_KEY, 'shortpoll');
            this._pollFailures = [];
            this._notifyStatus();
          } else {
            this._goOffline();
            return;
          }
        }
        await this._sleep(POLL_RETRY_DELAY_MS);
      }
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  _scheduleReprobe() {
    if (!this._running) return;
    if (this.transport !== 'longpoll' && this.transport !== 'shortpoll') return;
    this._clearTimer('reprobe');
    const delay = REPROBE_DELAYS_MS[Math.min(this._reprobeIndex, REPROBE_DELAYS_MS.length - 1)];
    this._timers.reprobe = setTimeout(() => {
      this._timers.reprobe = null;
      if (this.transport !== 'longpoll' && this.transport !== 'shortpoll') return;
      this._connectSse({ probe: true });
    }, delay);
  }

  // ---------------------------------------------------------------- offline

  _goOffline({ terminal = false } = {}) {
    this._offlineTerminal = terminal;
    this._session += 1;
    this._closeSse();
    this._closeProbe();
    this._abortPoll();
    this._clearTimer('sseRetry');
    this._clearTimer('reprobe');
    this._setState('offline');
    this._fanoutError(new Error('Realtime connection lost'));
  }

  _onOnline() {
    if (!this._running || this.state !== 'offline' || this._offlineTerminal) {
      this._checkDeadlines('event');
      return;
    }
    // Network came back: restart the ladder at the remembered transport.
    this._sseFailures = [];
    this._pollFailures = [];
    this._sseAttempt = 0;
    this._session += 1;
    this._setState('connecting');
    const remembered = this.deps.storage.get(TRANSPORT_MEMORY_KEY);
    if (remembered === 'longpoll' || remembered === 'shortpoll') {
      this._enterPolling(remembered);
    } else {
      this._connectSse();
    }
  }

  // --------------------------------------------- watchdog / wake detection

  _bindListeners() {
    if (this._listenersBound || typeof document === 'undefined') return;
    this._listenersBound = true;
    document.addEventListener('visibilitychange', this._boundCheck);
    window.addEventListener('focus', this._boundCheck);
    window.addEventListener('online', this._boundOnline);
  }

  _startWatchdog() {
    if (this._timers.watchdog) return;
    this._lastTickWall = Date.now();
    this._lastTickPerf = this._perfNow();
    this._timers.watchdog = setInterval(() => this._checkDeadlines('tick'), WATCHDOG_TICK_MS);
  }

  _stopWatchdog() {
    if (this._timers.watchdog) {
      clearInterval(this._timers.watchdog);
      this._timers.watchdog = null;
    }
  }

  /**
   * Deadline-based staleness evaluation — runs on the interval tick AND on
   * visibilitychange/focus/online, because background tabs throttle timers to
   * ≥1min and suspend them during sleep (a bare setInterval is exactly how
   * the old hours-long zombies survived).
   */
  _checkDeadlines(origin) {
    if (!this._running) return;
    const nowWall = Date.now();
    const nowPerf = this._perfNow();
    const wallDelta = nowWall - this._lastTickWall;
    const perfDelta = nowPerf - this._lastTickPerf;
    this._lastTickWall = nowWall;
    this._lastTickPerf = nowPerf;

    // Wake detection: during system sleep the wall clock keeps running while
    // the performance clock (mostly) pauses — a >60s divergence means the
    // machine slept. Event-origin checks with big wall gaps count too.
    const slept = wallDelta - perfDelta > WAKE_JUMP_MS
      || (origin === 'event' && wallDelta > BUFFER_HORIZON_MS);
    if (slept) {
      this._onWake();
      return;
    }

    const silence = this.lastEventAt ? nowWall - this.lastEventAt : 0;

    if (this.state === 'live-sse' && silence > STALE_MS) {
      // Half-dead stream (silent past 3× heartbeat): a real failure.
      this.lastEventAt = nowWall; // avoid re-firing during backoff
      this._closeSse();
      this._recordSseFailure();
      if (this._sseFailuresInWindow() >= SSE_FAILURE_BUDGET) this._degradeToPolling();
      else this._scheduleSseRetry();
      return;
    }

    // Stuck 'connecting' with nothing in flight and no timer to wake it —
    // the terminal-deadlock class from Phase 1. Kick the ladder.
    if (
      this.state === 'connecting'
      && !this._sse
      && !this._timers.sseRetry
      && this.transport === 'sse'
      && silence > STALE_MS
    ) {
      this.lastEventAt = nowWall;
      this._scheduleSseRetry();
    }
  }

  _onWake() {
    const session = this._session;
    const silence = this.lastEventAt ? Date.now() - this.lastEventAt : 0;
    const finish = () => {
      if (session !== this._session || !this._running) return;
      // Any silence gap beyond the server's ring-buffer horizon can never be
      // replayed — force a full refetch, then reconnect the transport.
      if (silence > BUFFER_HORIZON_MS) this._emitResync('wake-gap');
      if (silence > STALE_MS) {
        this.lastEventAt = Date.now();
        if (this.transport === 'sse') {
          this._closeSse();
          this._sseAttempt = 0;
          this._connectSse();
        } else if (this.transport === 'longpoll' || this.transport === 'shortpoll') {
          this._enterPolling(this.transport);
        } else if (this.state === 'offline' && !this._offlineTerminal) {
          this._onOnline();
        }
      }
    };
    // Refresh the token BEFORE the post-wake reconnect: reconnecting with an
    // expired token burns retries and delays recovery.
    if (this.deps.isTokenExpiring(TOKEN_EXPIRY_SLACK_MS)) {
      Promise.resolve()
        .then(() => this.deps.refreshToken())
        .catch(() => null)
        .then(finish);
    } else {
      finish();
    }
  }

  // ------------------------------------------------------- cursor plumbing

  _advanceCursor(id) {
    const next = parseCursor(id);
    if (!next) return true; // unparseable — pass through, no dedupe possible
    const current = parseCursor(this.cursor);
    if (current && current.epoch === next.epoch && next.n <= current.n) return false; // duplicate
    this.cursor = id;
    if (!this.epoch) this.epoch = next.epoch;
    return true;
  }

  _adoptCursor(id) {
    const next = parseCursor(id);
    if (!next) return;
    const current = parseCursor(this.cursor);
    if (current && current.epoch === next.epoch && next.n <= current.n) return;
    this.cursor = id;
  }

  // --------------------------------------------------------------- fan-out

  _dispatchData(event, data) {
    for (const sub of this.subscribers.values()) {
      if (!sub.enabled) continue;
      const cb = sub.callbacks || {};
      try {
        switch (event) {
        case 'sync-completed': if (cb.onSyncCompleted) cb.onSyncCompleted(data); break;
        case 'sync-skipped': if (cb.onSyncSkipped) cb.onSyncSkipped(data); break;
        case 'ticket-change': if (cb.onTicketChange) cb.onTicketChange(data); break;
        case 'presence': if (cb.onPresence) cb.onPresence(data); break;
        default: if (cb.onMessage) cb.onMessage(data); break;
        }
      } catch { /* one consumer's error must not break the fan-out */ }
      // Presence churns and shouldn't rerender consumers that only care
      // about data changes — it never feeds lastEvent.
      if (event !== 'presence' && sub.onEvent) {
        try {
          sub.onEvent({ type: event === 'sync-completed' || event === 'sync-skipped' || event === 'ticket-change' ? event : 'message', data, timestamp: Date.now() });
        } catch { /* ignore */ }
      }
    }
  }

  _fanoutConnected(data) {
    for (const sub of this.subscribers.values()) {
      if (!sub.enabled) continue;
      try {
        if (sub.callbacks?.onConnected) sub.callbacks.onConnected(data);
      } catch { /* ignore */ }
    }
  }

  _fanoutError(error) {
    for (const sub of this.subscribers.values()) {
      if (!sub.enabled) continue;
      try {
        if (sub.callbacks?.onError) sub.callbacks.onError(error);
      } catch { /* ignore */ }
    }
  }

  /**
   * The replay gap is unbridgeable (epoch change / cursor out of buffer /
   * post-sleep silence): every consumer must treat this like sync-completed
   * and full-refetch. Consumers with an explicit onResync get that; others
   * get the synthetic connected + sync-completed pair their existing
   * catch-up paths already handle.
   */
  _emitResync(reason) {
    const payload = { resync: true, reason };
    for (const sub of this.subscribers.values()) {
      if (!sub.enabled) continue;
      const cb = sub.callbacks || {};
      try {
        if (cb.onResync) {
          cb.onResync(payload);
        } else {
          if (cb.onConnected) cb.onConnected(payload);
          if (cb.onSyncCompleted) cb.onSyncCompleted(payload);
        }
      } catch { /* ignore */ }
    }
  }

  _clearTimer(name) {
    if (this._timers[name]) {
      clearTimeout(this._timers[name]);
      this._timers[name] = null;
    }
  }
}

// ------------------------------------------------------------- shared instance

let _shared = null;

export function getSharedRealtimeClient() {
  if (!_shared) _shared = new RealtimeClient();
  return _shared;
}

/** Test-only: drop the shared instance so each test gets a clean client. */
export function _resetSharedRealtimeClient() {
  if (_shared) _shared._stop();
  _shared = null;
}
