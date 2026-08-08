import { useCallback, useEffect, useRef, useState } from 'react';
import { sseAPI, isAuthTokenExpiring, refreshAuthToken } from '../services/api';
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
  // Staleness watchdog: the server heartbeats every 30s, so >90s of total
  // silence means the connection is half-dead — the classic case is a backend
  // restart behind a proxy/LB that keeps the client socket open, which fires
  // NO error event. Without this, the page silently stops receiving updates
  // until a manual refresh.
  const lastEventAtRef = useRef(Date.now());
  const STALE_MS = 90000;
  // After this many consecutive failed connection attempts, stop the eternal
  // "connecting" spinner and surface 'disconnected' with a manual retry
  // affordance (QA 08-07 #14 — Marcus/Adrian pinned at "Connecting").
  const MAX_RECONNECT_ATTEMPTS = 8;
  // Refresh the JWT before reconnecting when it expires within this window —
  // an expired token would just 401-loop the EventSource.
  const TOKEN_EXPIRY_SLACK_MS = 60000;
  // Lets retry() reach the connect closure defined inside the effect.
  const connectRef = useRef(null);

  useEffect(() => {
    unmountedRef.current = false;

    const clearRetryTimer = () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };

    const closeCurrentSource = () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (!enabled || unmountedRef.current) return;
      clearRetryTimer();

      // Give up after the budget is spent: an eternal amber "Connecting" hides
      // real outages. 'disconnected' + the header's Reconnect affordance is
      // honest and actionable; retry() resets the budget.
      if (retryAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
        closeCurrentSource();
        setConnectionStatus('disconnected');
        return;
      }

      // Exponential backoff (1s -> 2s -> 4s ... max 15s)
      const delay = Math.min(1000 * (2 ** retryAttemptRef.current), 15000);
      retryAttemptRef.current += 1;
      setConnectionStatus('connecting');

      retryTimerRef.current = setTimeout(() => {
        connect();
      }, delay);
    };

    const connect = async () => {
      if (!enabled || unmountedRef.current) return;

      clearRetryTimer();
      closeCurrentSource();
      setConnectionStatus('connecting');

      // EventSource can't use the axios auth interceptors, so an expired JWT
      // would 401 every reconnect forever. Mint a fresh one via the silent
      // recovery path (AuthContext → MSAL acquireTokenSilent → /auth/sso)
      // before opening the stream. Failure falls through: the connection
      // attempt itself will error and consume a retry from the budget.
      if (isAuthTokenExpiring(TOKEN_EXPIRY_SLACK_MS)) {
        try {
          await refreshAuthToken();
        } catch { /* handled by the connection error path */ }
        if (!enabled || unmountedRef.current) return;
      }

      try {
        const eventSource = sseAPI.getEventSource();
        eventSourceRef.current = eventSource;
        lastEventAtRef.current = Date.now();

        eventSource.onopen = () => {
          retryAttemptRef.current = 0;
          lastEventAtRef.current = Date.now();
          setConnectionStatus('connected');
        };

        eventSource.addEventListener('connected', (event) => {
          // SSE connection established
          retryAttemptRef.current = 0;
          lastEventAtRef.current = Date.now();
          setConnectionStatus('connected');
          if (onConnected) {
            onConnected(parseAndScrub(event.data));
          }
        });

        // Server liveness ping (every 30s) — its only job is to feed the
        // staleness watchdog below.
        eventSource.addEventListener('heartbeat', () => {
          lastEventAtRef.current = Date.now();
        });

        eventSource.addEventListener('sync-completed', (event) => {
          // Sync completed event received
          const data = parseAndScrub(event.data);
          setLastEvent({ type: 'sync-completed', data, timestamp: Date.now() });
          if (onSyncCompleted) {
            onSyncCompleted(data);
          }
        });

        // Native ticketing mutations (create/update/reply/status/assignment)
        eventSource.addEventListener('ticket-change', (event) => {
          lastEventAtRef.current = Date.now();
          const data = parseAndScrub(event.data);
          setLastEvent({ type: 'ticket-change', data, timestamp: Date.now() });
          if (onTicketChange) {
            onTicketChange(data);
          }
        });

        // Ticket presence ("also viewing" — gap plan 2 P4.1). Not routed
        // through lastEvent: presence churns and shouldn't rerender consumers
        // that only care about data changes.
        eventSource.addEventListener('presence', (event) => {
          if (onPresence) {
            onPresence(parseAndScrub(event.data));
          }
        });

        eventSource.onmessage = (event) => {
          // SSE message received
          const data = parseAndScrub(event.data);
          setLastEvent({ type: 'message', data, timestamp: Date.now() });
          if (onMessage) {
            onMessage(data);
          }
        };

        eventSource.onerror = () => {
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
            if (retryAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
              closeCurrentSource();
              setConnectionStatus('disconnected');
            } else {
              setConnectionStatus('connecting');
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
      }
    };

    connectRef.current = connect;

    if (!enabled) {
      clearRetryTimer();
      closeCurrentSource();
      setConnectionStatus('disconnected');
      return;
    }

    connect();

    // Staleness watchdog: if the stream has been silent past the threshold,
    // the connection is half-dead — tear it down and reconnect (which fires
    // 'connected', letting consumers run their catch-up refetch). Also check
    // immediately when a background tab becomes visible again, so a stale tab
    // heals the moment the user returns instead of on the next interval tick.
    const checkStale = () => {
      if (unmountedRef.current || !eventSourceRef.current) return;
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
    };
  }, [enabled, onMessage, onSyncCompleted, onTicketChange, onPresence, onConnected, onError, reconnectKey]);

  const disconnect = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
      setConnectionStatus('disconnected');
    }
  };

  // Manual reconnect after the retry budget is exhausted (header "Reconnect").
  // Resets the budget so the backoff ladder starts over.
  const retry = useCallback(() => {
    retryAttemptRef.current = 0;
    if (connectRef.current) connectRef.current();
  }, []);

  return {
    isConnected: connectionStatus === 'connected',
    connectionStatus,
    lastEvent,
    disconnect,
    retry,
  };
}
