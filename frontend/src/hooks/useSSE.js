import { useCallback, useEffect, useRef, useState } from 'react';
import { getSharedRealtimeClient } from '../services/realtimeClient';
import { useLegacySSE } from './useSSE.legacy';

/**
 * Subscription facade over the SHARED realtime client (realtime plan Phase 2).
 *
 * Every consumer of this hook now shares ONE connection per tab (fetch-based
 * SSE with a long-poll → short-poll fallback ladder) with internal event
 * fan-out, instead of opening its own EventSource. The external API is
 * unchanged from the v3.4.00 hook — `{ connectionStatus, lastEvent, retry,
 * getReconnectChurn, ... }` — plus transport diagnostics for the status pill.
 *
 * Callback identity changes only update the fan-out table; they never tear
 * down the connection (the old hook rebuilt the EventSource on any identity
 * change, which is why consumers pin their callbacks with refs — still good
 * practice, no longer load-bearing).
 *
 * Rollback lever: VITE_REALTIME_TRANSPORT=eventsource aliases useSSE to the
 * legacy per-hook native-EventSource implementation (useSSE.legacy.js).
 */
function statusFromState(state) {
  if (state === 'live-sse' || state === 'live-poll') return 'connected';
  if (state === 'offline') return 'disconnected';
  // 'connecting' and 'idle' (client not yet started for this workspace).
  return 'connecting';
}

function useSharedSSE(options = {}) {
  const {
    onMessage,
    onSyncCompleted,
    onTicketChange,
    onSyncSkipped,
    onPresence,
    onConnected,
    onError,
    onResync,
    enabled = true,
    reconnectKey = null,
  } = options;

  const client = getSharedRealtimeClient();
  const [connectionStatus, setConnectionStatus] = useState(enabled ? 'connecting' : 'disconnected');
  const [transportState, setTransportState] = useState({ state: 'idle', transport: null });
  const [lastEvent, setLastEvent] = useState(null);

  // Latest callbacks behind refs: the fan-out wrappers stay identity-stable
  // so churny consumer callbacks never resubscribe (let alone reconnect).
  const callbacksRef = useRef({});
  callbacksRef.current = { onMessage, onSyncCompleted, onTicketChange, onSyncSkipped, onPresence, onConnected, onError, onResync };
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const subRef = useRef(null);

  useEffect(() => {
    const forward = (name) => (payload) => {
      const cb = callbacksRef.current[name];
      if (cb) cb(payload);
    };
    // Only register onResync when the consumer supplied one — the client
    // falls back to the synthetic connected+sync-completed pair otherwise.
    const callbacks = {
      onMessage: forward('onMessage'),
      onSyncCompleted: forward('onSyncCompleted'),
      onTicketChange: forward('onTicketChange'),
      onSyncSkipped: forward('onSyncSkipped'),
      onPresence: forward('onPresence'),
      onConnected: forward('onConnected'),
      onError: forward('onError'),
    };
    if (callbacksRef.current.onResync) callbacks.onResync = forward('onResync');

    const sub = client.subscribe({
      enabled: enabledRef.current,
      expectedWorkspaceId: reconnectKey,
      callbacks,
      onEvent: (evt) => setLastEvent(evt),
      onStatus: ({ state, transport }) => {
        setTransportState({ state, transport });
        setConnectionStatus(enabledRef.current ? statusFromState(state) : 'disconnected');
      },
    });
    subRef.current = sub;
    return () => {
      subRef.current = null;
      sub.unsubscribe();
    };
    // The subscription lives for the hook's lifetime; enabled/reconnectKey
    // changes flow through update() below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  useEffect(() => {
    if (!subRef.current) return;
    subRef.current.update({ enabled, expectedWorkspaceId: reconnectKey });
    if (!enabled) setConnectionStatus('disconnected');
  }, [enabled, reconnectKey]);

  const disconnect = useCallback(() => {
    if (subRef.current) subRef.current.update({ enabled: false });
    setConnectionStatus('disconnected');
  }, []);

  // Manual reconnect (header "Reconnect"): resets the ladder's budgets and
  // starts over at SSE.
  const retry = useCallback(() => {
    client.retry();
  }, [client]);

  // Diagnostics: total connection attempts across the SHARED client (ref-style
  // read so churn never causes renders by itself).
  const getReconnectChurn = useCallback(() => client.getDiagnostics().churn, [client]);

  const getDiagnostics = useCallback(() => client.getDiagnostics(), [client]);

  return {
    isConnected: connectionStatus === 'connected',
    connectionStatus,
    // Ladder-aware status for the pill: 'idle'|'connecting'|'live-sse'|'live-poll'|'offline'
    transportStatus: enabled ? transportState.state : 'idle',
    transport: transportState.transport,
    lastEvent,
    disconnect,
    retry,
    getReconnectChurn,
    getDiagnostics,
  };
}

// Legacy rollback lever: force the pre-ladder native-EventSource path.
const USE_LEGACY_TRANSPORT = import.meta.env.VITE_REALTIME_TRANSPORT === 'eventsource';

export const useSSE = USE_LEGACY_TRANSPORT ? useLegacySSE : useSharedSSE;
