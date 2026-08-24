import { useCallback, useEffect, useRef, useState } from 'react';
import { getSharedRealtimeClient } from '../services/realtimeClient';

/**
 * Status-only view of the SHARED realtime client for the header pill
 * (QA 08-19 #3 "honest pill"). The tab holds ONE realtime connection shared by
 * every consumer (useApprovalCount keeps it alive on every AppHeader page), so
 * the pill must report THAT connection's ladder state — not DashboardContext's
 * route-gated subscription, which reads 'disconnected' on any route outside
 * APP_LIVE_SSE_ROUTES (/approvals was the reported case) while the tab is
 * genuinely live.
 *
 * The subscription registers no data callbacks — it only mirrors the client's
 * {state, transport} snapshots — but it IS an enabled subscriber, which keeps
 * the connection running (and the manual Retry actionable) wherever the header
 * renders.
 *
 * Legacy rollback lever (VITE_REALTIME_TRANSPORT=eventsource): there is no
 * shared client on that path — `active` is false and callers fall back to the
 * DashboardContext-derived pill state.
 */
function useSharedRealtimeStatus(workspaceId = null) {
  const client = getSharedRealtimeClient();
  const [snapshot, setSnapshot] = useState(() => ({ state: client.state, transport: client.transport }));
  const subRef = useRef(null);

  useEffect(() => {
    const sub = client.subscribe({
      enabled: true,
      callbacks: {},
      onStatus: ({ state, transport }) => setSnapshot({ state, transport }),
    });
    subRef.current = sub;
    return () => {
      subRef.current = null;
      sub.unsubscribe();
    };
  }, [client]);

  // Workspace hydration/switch nudge: update() re-runs the client's evaluate
  // loop, so this status subscription alone can start the connection once the
  // workspace id exists (the client reads the id from its own dep, this value
  // is bookkeeping — same contract as useSSE's reconnectKey).
  useEffect(() => {
    subRef.current?.update({ expectedWorkspaceId: workspaceId ?? null });
  }, [workspaceId]);

  const retry = useCallback(() => client.retry(), [client]);
  const getDiagnostics = useCallback(() => client.getDiagnostics(), [client]);
  const getReconnectChurn = useCallback(() => client.getDiagnostics().churn, [client]);

  return {
    active: true,
    // 'idle' | 'connecting' | 'live-sse' | 'live-poll' | 'offline'
    state: snapshot.state,
    // 'sse' | 'longpoll' | 'shortpoll' | null
    transport: snapshot.transport,
    retry,
    getDiagnostics,
    getReconnectChurn,
  };
}

function useLegacyRealtimeStatus() {
  return { active: false, state: null, transport: null, retry: null, getDiagnostics: null, getReconnectChurn: null };
}

const USE_LEGACY_TRANSPORT = import.meta.env.VITE_REALTIME_TRANSPORT === 'eventsource';

export const useRealtimeStatus = USE_LEGACY_TRANSPORT ? useLegacyRealtimeStatus : useSharedRealtimeStatus;
