import { useEffect, useState } from 'react';
import { useWorkspace } from '../contexts/WorkspaceContext';

/**
 * Is the Onboarding section here (plans/HR_LIFECYCLE_PLAN.md)? The server
 * decides per workspace (HR_LIFECYCLE_WORKSPACE_IDS, IT only for now) and
 * says which mode it runs in. One request per workspace per page load; the
 * answer is shared by every caller (rail, tab bar, the page itself).
 * Fails closed: any error = not available.
 */
const cache = new Map(); // workspaceId -> { available, mode }
const inflight = new Map();
const listeners = new Set();

async function load(workspaceId) {
  if (cache.has(workspaceId)) return cache.get(workspaceId);
  if (!inflight.has(workspaceId)) {
    inflight.set(workspaceId, (async () => {
      let value = { available: false, mode: 'off' };
      try {
        const { hrLifecycleAPI } = await import('../services/api');
        const res = await hrLifecycleAPI.status();
        const data = res?.data || {};
        value = { available: data.available === true, mode: data.mode || 'off' };
      } catch { /* not available */ }
      cache.set(workspaceId, value);
      inflight.delete(workspaceId);
      return value;
    })());
  }
  return inflight.get(workspaceId);
}

/** After a settings save: update the cached mode so every reader follows. */
export function setHrLifecycleStatus(workspaceId, value) {
  if (!workspaceId) return;
  cache.set(workspaceId, { ...(cache.get(workspaceId) || { available: true }), ...value });
  for (const fn of listeners) fn();
}

/** Test helper. */
export function resetHrLifecycleStatus() {
  cache.clear();
  inflight.clear();
}

/**
 * @param {{ enabled?: boolean }} opts  enabled=false skips the request (non-admins).
 * @returns {{ available: boolean, mode: string, loading: boolean }}
 */
export function useHrLifecycleStatus({ enabled = true } = {}) {
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

  const value = (enabled && wsId && cache.get(wsId)) || { available: false, mode: 'off' };
  return { ...value, loading };
}
