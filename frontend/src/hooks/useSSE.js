import { useCallback, useEffect, useRef, useState } from 'react';
import { sseAPI, isAuthTokenExpiring, refreshAuthToken, getWorkspaceId } from '../services/api';
import { isDemoMode, maybeScrub } from '../utils/demoMode';

// Scrubs SSE event payloads through the demo-mode anonymizer when active so
// live push updates stay consistent with the rest of the (axios-scrubbed) UI.
function parseAndScrub(rawData) {
  const parsed = JSON.parse(rawData);
  return maybeScrub(parsed, isDemoMode());
}

/**
 * Custom hook for Server-Sent Events
 * @param {Object} options - Configuration options
 * @param {Function} options.onMessage - Callback for general messages
 * @param {Function} options.onSyncCompleted - Callback for sync completion
 * @param {Function} options.onConnected - Callback when connected
 * @param {Function} options.onError - Callback for errors
 * @param {boolean} options.enabled - Enable/disable SSE connection
 * @returns {Object} SSE status and controls
 */
export function useSSE(options = {}) {
  const {
    onMessage,
    onSyncCompleted,
    onTicketChange,
    onSyncSkipped,
    onPresence,
    onConnected,
    onError,
    enabled = true,
    reconnectKey = null,
  } = options;

  // Three-state: 'connecting', 'connected', 'disconnected'
  const [connectionStatus, setConnectionStatus] = useState(enabled ? 'connecting' : 'disconnected');
  const [lastEvent, setLastEvent] = useState(null);
  const eventSourceRef = useRef(null);
  const retryTimerRef = useRef(null);
  const retryAttemptRef = useRef(0);
  const unmountedRef = useRef(false);
  // Mirror of connectionStatus for timer callbacks (the staleness watchdog
  // must see the CURRENT status, not the one captured at effect setup).
  const statusRef = useRef(enabled ? 'connecting' : 'disconnected');
  // Diagnostics: total (re)connection attempts made by this hook instance.
  // A high churn count with a "connected" pill is the flapping-proxy signature
  // (realtime plan Phase 1 — there was previously no way to even see it).
  const churnRef = useRef(0);
  // connect() is async (it may await a token refresh) — while it's in flight
  // there is legitimately no EventSource and no retry timer. Tracked so the
  // watchdog doesn't race a healthy in-flight connect, but CAN rescue one
  // that never settled (the un-timeboxed-MSAL deadlock class).
  const connectInFlightRef = useRef(false);
  const connectStartedAtRef = useRef(0);
  // Credit a connection as successful (budget reset) only after it PROVES
  // itself: one real server event, or 10s of stability. A bare onopen no
  // longer resets the budget — flapping proxies that forward headers then
  // stall produced open→error loops where the budget never accumulated and
  // the "Offline — Reconnect" state was unreachable.
  const stabilityTimerRef = useRef(null);
  const wrongChannelWarnedRef = useRef(false);
  // Staleness watchdog: the server heartbeats every 30s, so >90s of total
  // silence means the connection is half-dead — the classic case is a backend
  // restart behind a proxy/LB that keeps the client socket open, which fires
  // NO error event. Without this, the page silently stops receiving updates
  // until a manual refresh.
  const lastEventAtRef = useRef(Date.now());
  const STALE_MS = 90000;
  // A connect() awaiting a token refresh that outlives this is presumed stuck
  // (refreshAuthToken is timeboxed upstream; this is the belt to that brace).
  const CONNECT_STUCK_MS = 30000;
  // After this many consecutive failed connection attempts, stop the eternal
  // "connecting" spinner and surface 'disconnected' with a manual retry
  // affordance (QA 08-07 #14 — Marcus/Adrian pinned at "Connecting").
  const MAX_RECONNECT_ATTEMPTS = 8;
  // Refresh the JWT before reconnecting when it expires within this window —
  // an expired token would just 401-loop the EventSource.
  const TOKEN_EXPIRY_SLACK_MS = 60000;
  // How long a connection must stay open before it counts as a success.
  const STABILITY_CREDIT_MS = 10000;
  // Lets retry() reach the connect closure defined inside the effect.
  const connectRef = useRef(null);
  // Tracks reconnectKey across effect re-runs: a DELIBERATE re-key (workspace
  // switch) is a new connection context and deserves a fresh retry budget —
  // but incidental effect re-runs (callback identity changes) must not grant
  // free budget resets.
  const prevReconnectKeyRef = useRef(reconnectKey);

  useEffect(() => {
    unmountedRef.current = false;
    if (prevReconnectKeyRef.current !== reconnectKey) {
      prevReconnectKeyRef.current = reconnectKey;
      retryAttemptRef.current = 0;
    }

    const setStatus = (status) => {
      statusRef.current = status;
      setConnectionStatus(status);
    };

    const clearRetryTimer = () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };

    const clearStabilityTimer = () => {
      if (stabilityTimerRef.current) {
        clearTimeout(stabilityTimerRef.current);
        stabilityTimerRef.current = null;
      }
    };

    const closeCurrentSource = () => {
      clearStabilityTimer();
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };

    // The connection proved itself (server event, or 10s stable) — reset the
    // retry budget so future outages get the full backoff ladder.
    const creditSuccess = () => {
      clearStabilityTimer();
      retryAttemptRef.current = 0;
    };

    const scheduleReconnect = () => {
      if (!enabled || unmountedRef.current) return;
      clearRetryTimer();

      // Give up after the budget is spent: an eternal amber "Connecting" hides
      // real outages. 'disconnected' + the header's Reconnect affordance is
      // honest and actionable; retry() resets the budget.
      if (retryAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
        closeCurrentSource();
        setStatus('disconnected');
        return;
      }

      // Exponential backoff (1s -> 2s -> 4s ... max 15s)
      const delay = Math.min(1000 * (2 ** retryAttemptRef.current), 15000);
      retryAttemptRef.current += 1;
      setStatus('connecting');

      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        connect();
      }, delay);
    };

    // Channel membership check (realtime plan Phase 1 — Kirsten's zombie):
    // heartbeat/connected events carry the server channel's workspaceId. If it
    // isn't the workspace this tab expects, the stream is a wrong-channel
    // zombie — close it and reconnect (getEventSource re-reads the current
    // workspace, so the new URL is corrected). Returns true on mismatch.
    const isWrongChannel = (serverWorkspaceId) => {
      const expected = getWorkspaceId ? getWorkspaceId() : null;
      if (expected === null || expected === undefined) return false;
      if (serverWorkspaceId === null || serverWorkspaceId === undefined) return false;
      if (Number(serverWorkspaceId) === Number(expected)) return false;
      if (!wrongChannelWarnedRef.current) {
        wrongChannelWarnedRef.current = true;
        console.warn(`[SSE] Stream is on workspace channel ${serverWorkspaceId} but this tab expects ${expected} — reconnecting with corrected URL`);
      }
      closeCurrentSource();
      scheduleReconnect();
      return true;
    };

    const connect = async () => {
      if (!enabled || unmountedRef.current) return;

      clearRetryTimer();
      closeCurrentSource();
      setStatus('connecting');
      connectInFlightRef.current = true;
      connectStartedAtRef.current = Date.now();
      churnRef.current += 1;

      // EventSource can't use the axios auth interceptors, so an expired JWT
      // would 401 every reconnect forever. Mint a fresh one via the silent
      // recovery path (AuthContext → MSAL acquireTokenSilent → /auth/sso)
      // before opening the stream (refreshAuthToken is timeboxed upstream).
      // Failure falls through: the connection attempt itself will error and
      // consume a retry from the budget (a 401-shaped failure closes the
      // source, which lands in the onerror CLOSED branch below).
      if (isAuthTokenExpiring(TOKEN_EXPIRY_SLACK_MS)) {
        try {
          await refreshAuthToken();
        } catch { /* handled by the connection error path */ }
        if (!enabled || unmountedRef.current) {
          connectInFlightRef.current = false;
          return;
        }
      }

      try {
        const eventSource = sseAPI.getEventSource();
        eventSourceRef.current = eventSource;
        lastEventAtRef.current = Date.now();

        eventSource.onopen = () => {
          // NOTE: deliberately does NOT reset the retry budget — an open
          // socket from an inspecting proxy proves nothing. Success is
          // credited by creditSuccess() on the first server event, or after
          // 10s of stability.
          lastEventAtRef.current = Date.now();
          setStatus('connected');
          clearStabilityTimer();
          stabilityTimerRef.current = setTimeout(() => {
            stabilityTimerRef.current = null;
            creditSuccess();
          }, STABILITY_CREDIT_MS);
        };

        eventSource.addEventListener('connected', (event) => {
          // SSE connection established — a real server event, so credit it.
          creditSuccess();
          lastEventAtRef.current = Date.now();
          setStatus('connected');
          let data = null;
          try {
            data = event.data ? parseAndScrub(event.data) : null;
          } catch { /* malformed payload — treat as a bare connect */ }
          // Membership proof: the server tells us which channel we joined.
          if (isWrongChannel(data?.workspaceId)) return;
          if (onConnected) {
            onConnected(data);
          }
        });

        // Server liveness ping (every 30s) — feeds the staleness watchdog and
        // carries the channel's workspaceId as a membership proof.
        eventSource.addEventListener('heartbeat', (event) => {
          let payload = null;
          try {
            payload = JSON.parse(event.data);
          } catch { /* legacy numeric heartbeat — liveness only */ }
          if (payload && typeof payload === 'object' && isWrongChannel(payload.workspaceId)) {
            // A wrong-channel heartbeat must NOT feed the watchdog — that is
            // exactly how zombies stayed "Live" with frozen data.
            return;
          }
          lastEventAtRef.current = Date.now();
          creditSuccess();
        });

        eventSource.addEventListener('sync-completed', (event) => {
          // Sync completed event received
          lastEventAtRef.current = Date.now();
          creditSuccess();
          const data = parseAndScrub(event.data);
          setLastEvent({ type: 'sync-completed', data, timestamp: Date.now() });
          if (onSyncCompleted) {
            onSyncCompleted(data);
          }
        });

        // A manual "Sync now" found a sync already running (server-side skip).
        eventSource.addEventListener('sync-skipped', (event) => {
          lastEventAtRef.current = Date.now();
          const data = parseAndScrub(event.data);
          setLastEvent({ type: 'sync-skipped', data, timestamp: Date.now() });
          if (onSyncSkipped) {
            onSyncSkipped(data);
          }
        });

        // Native ticketing mutations (create/update/reply/status/assignment)
        eventSource.addEventListener('ticket-change', (event) => {
          lastEventAtRef.current = Date.now();
          creditSuccess();
          const data = parseAndScrub(event.data);
          setLastEvent({ type: 'ticket-change', data, timestamp: Date.now() });
          if (onTicketChange) {
            onTicketChange(data);
          }
        });

        // Ticket presence ("also viewing" — gap plan 2 P4.1). Not routed
        // through lastEvent: presence churns and shouldn't rerender consumers
        // that only care about data changes. It IS server traffic though, so
        // it refreshes the staleness watchdog.
        eventSource.addEventListener('presence', (event) => {
          lastEventAtRef.current = Date.now();
          if (onPresence) {
            onPresence(parseAndScrub(event.data));
          }
        });

        eventSource.onmessage = (event) => {
          // SSE message received
          lastEventAtRef.current = Date.now();
          creditSuccess();
          const data = parseAndScrub(event.data);
          setLastEvent({ type: 'message', data, timestamp: Date.now() });
          if (onMessage) {
            onMessage(data);
          }
        };

        eventSource.onerror = () => {
          clearStabilityTimer();
          if (eventSource.readyState === EventSource.CLOSED) {
            // Fatal (e.g. non-200 like an auth 401): the browser won't retry —
            // our backoff ladder does, against the budget.
            scheduleReconnect();
          } else {
            // Network-level failure (backend down/unreachable): the browser
            // auto-retries internally with readyState CONNECTING and never
            // closes — count those attempts against the SAME budget, or a
            // dead backend pins the pill at "Connecting" forever.
            retryAttemptRef.current += 1;
            churnRef.current += 1;
            if (retryAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
              closeCurrentSource();
              setStatus('disconnected');
            } else {
              setStatus('connecting');
            }
          }

          if (onError) {
            onError(new Error('SSE connection interrupted'));
          }
        };
      } catch (error) {
        scheduleReconnect();
        if (onError) {
          onError(error);
        }
      } finally {
        connectInFlightRef.current = false;
      }
    };

    connectRef.current = connect;

    if (!enabled) {
      clearRetryTimer();
      closeCurrentSource();
      setStatus('disconnected');
      return;
    }

    connect();

    // Staleness watchdog: if the stream has been silent past the threshold,
    // the connection is half-dead — tear it down and reconnect (which fires
    // 'connected', letting consumers run their catch-up refetch). Also check
    // immediately when a background tab becomes visible again, so a stale tab
    // heals the moment the user returns instead of on the next interval tick.
    const checkStale = () => {
      if (unmountedRef.current) return;
      if (!eventSourceRef.current) {
        // No source. Previously this early-returned unconditionally, which
        // made the "stuck connect" state terminal: status 'connecting' with
        // no EventSource, no pending retry timer, and a connect() parked on a
        // never-settling await had NOTHING left to wake it up. Detect that
        // exact shape and force the reconnect ladder.
        const connectLooksStuck = connectInFlightRef.current
          && Date.now() - connectStartedAtRef.current > CONNECT_STUCK_MS;
        if (
          statusRef.current === 'connecting'
          && !retryTimerRef.current
          && (!connectInFlightRef.current || connectLooksStuck)
        ) {
          connectInFlightRef.current = false;
          scheduleReconnect();
        }
        return;
      }
      if (Date.now() - lastEventAtRef.current <= STALE_MS) return;
      lastEventAtRef.current = Date.now(); // avoid re-firing during the retry backoff
      closeCurrentSource();
      scheduleReconnect();
    };
    const staleTimer = setInterval(checkStale, 15000);
    const onVisible = () => { if (document.visibilityState === 'visible') checkStale(); };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      unmountedRef.current = true;
      connectRef.current = null;
      clearInterval(staleTimer);
      document.removeEventListener('visibilitychange', onVisible);
      clearRetryTimer();
      closeCurrentSource();
      setConnectionStatus('disconnected');
      statusRef.current = 'disconnected';
    };
  }, [enabled, onMessage, onSyncCompleted, onSyncSkipped, onTicketChange, onPresence, onConnected, onError, reconnectKey]);

  const disconnect = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
      statusRef.current = 'disconnected';
      setConnectionStatus('disconnected');
    }
  };

  // Manual reconnect after the retry budget is exhausted (header "Reconnect").
  // Resets the budget so the backoff ladder starts over.
  const retry = useCallback(() => {
    retryAttemptRef.current = 0;
    if (connectRef.current) connectRef.current();
  }, []);

  // Diagnostics: how many connection attempts this hook instance has made.
  // Read lazily (ref, not state) so churn never causes renders by itself.
  const getReconnectChurn = useCallback(() => churnRef.current, []);

  return {
    isConnected: connectionStatus === 'connected',
    connectionStatus,
    lastEvent,
    disconnect,
    retry,
    getReconnectChurn,
  };
}
