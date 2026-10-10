import { useEffect, useState } from 'react';
import { useWorkspace } from '../contexts/WorkspaceContext';

/**
 * Is there an on-call rotation to show here (plans/URGENT_RESPONSE_PLAN.md)?
 * GET /urgent-response/status answers per workspace. The On-call entry in the
 * navigation shows when the mode is not off, or when an on-call order is set.
 * One request per workspace per page load, shared by every caller (rail, tab
 * bar). Fails closed: any error = nothing to show.
 */
const OFF = { mode: 'off', onCall: false, visible: false };
const cache = new Map(); // workspaceId -> { mode, onCall, visible }
const inflight = new Map();
const listeners = new Set();

function toValue(data) {
  const mode = data?.mode || 'off';
  // `onCall` (an on-call order exists) is optional in the answer; older
  // servers only send the mode.
  const onCall = data?.onCall === true || data?.hasOnCall === true || (Array.isArray(data?.onCallOrder) && data.onCallOrder.length > 0);
  return { mode, onCall, visible: mode !== 'off' || onCall };
}

async function load(workspaceId) {
  if (cache.has(workspaceId)) return cache.get(workspaceId);
  if (!inflight.has(workspaceId)) {
    inflight.set(workspaceId, (async () => {
      let value = OFF;
      try {
        const { urgentResponseAPI } = await import('../services/api');
        const res = await urgentResponseAPI.getStatus();
        value = toValue(res?.data || {});
      } catch { /* nothing to show */ }
      cache.set(workspaceId, value);
      inflight.delete(workspaceId);
      return value;
    })());
  }
  return inflight.get(workspaceId);
}

/** After a settings save: update the cached answer so every reader follows. */
export function setUrgentResponseStatus(workspaceId, data) {
  if (!workspaceId) return;
  cache.set(workspaceId, toValue({ ...(cache.get(workspaceId) || {}), ...data }));
  for (const fn of listeners) fn();
}

/** Test helper. */
export function resetUrgentResponseStatus() {
  cache.clear();
  inflight.clear();
}

/**
 * @param {{ enabled?: boolean }} opts  enabled=false skips the request (signed out).
 * @returns {{ mode: string, onCall: boolean, visible: boolean, loading: boolean }}
 */
export function useUrgentResponseStatus({ enabled = true } = {}) {
  const { currentWorkspace } = useWorkspace();
  const wsId = currentWorkspace?.id || null;
  const [, bump] = useState(0);
  const [loading, setLoading] = useState(() => Boolean(enabled && wsId && !cache.has(wsId)));

  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);

  useEffect(() => {
    if (!enabled || !wsId) { setLoading(false); return undefined; }
    let cancelled = false;
    if (!cache.has(wsId)) setLoading(true);
    load(wsId).then(() => {
      if (!cancelled) { setLoading(false); bump((n) => n + 1); }
    });
    return () => { cancelled = true; };
  }, [enabled, wsId]);

  const value = (enabled && wsId && cache.get(wsId)) || OFF;
  return { ...value, loading };
}
