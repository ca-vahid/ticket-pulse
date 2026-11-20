import { useEffect, useState } from 'react';
import { useWorkspace } from '../contexts/WorkspaceContext';

/**
 * Dashboard view grant (QA 11-19 item 2): may the signed-in person open the
 * Dashboard here even though their role does not cover it? An admin turns it
 * on per agent in Settings → Members ("Can see the Dashboard").
 *
 * Only asked for people whose role does not already include the Dashboard
 * (callers pass enabled=false for admins and Read-only observers). One request
 * per workspace per page load, shared by every caller (route gate, rail, tab
 * bar). Fails closed: any error = no Dashboard.
 *
 * `loading` is derived at render, not kept in state: the route gate reads it
 * on the very render where `enabled` first turns true, and must wait instead
 * of bouncing.
 */
const NONE = { viewer: false };
const cache = new Map(); // workspaceId -> { viewer }
const inflight = new Map();

async function load(workspaceId) {
  if (cache.has(workspaceId)) return cache.get(workspaceId);
  if (!inflight.has(workspaceId)) {
    inflight.set(workspaceId, (async () => {
      let value = NONE;
      try {
        const { dashboardViewersAPI } = await import('../services/api');
        const res = await dashboardViewersAPI.mine();
        value = { viewer: res?.data?.viaGrant === true && res?.data?.dashboard === true };
      } catch { /* no Dashboard */ }
      cache.set(workspaceId, value);
      inflight.delete(workspaceId);
      return value;
    })());
  }
  return inflight.get(workspaceId);
}

/** Test helper. */
export function resetDashboardViewAccess() {
  cache.clear();
  inflight.clear();
}

/**
 * @param {{ enabled?: boolean }} opts
 * @returns {{ viewer: boolean, loading: boolean }}
 */
export function useDashboardViewAccess({ enabled = true } = {}) {
  const { currentWorkspace } = useWorkspace();
  const wsId = currentWorkspace?.id || null;
  const [, bump] = useState(0);

  useEffect(() => {
    if (!enabled || !wsId || cache.has(wsId)) return undefined;
    let cancelled = false;
    load(wsId).then(() => { if (!cancelled) bump((n) => n + 1); });
    return () => { cancelled = true; };
  }, [enabled, wsId]);

  if (!enabled || !wsId) return { viewer: false, loading: false };
  const hit = cache.get(wsId);
  return hit ? { viewer: hit.viewer, loading: false } : { viewer: false, loading: true };
}
