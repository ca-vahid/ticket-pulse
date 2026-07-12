import { useCallback, useEffect, useState } from 'react';
import { settingsAPI } from '../services/api';
import { useWorkspace } from '../contexts/WorkspaceContext';

// Module-level cache so every TypePill / select / filter in a render tree
// shares one fetch per workspace (5-min TTL; invalidated by Settings saves).
const cache = new Map(); // workspaceId -> { at, types }
const inflight = new Map(); // workspaceId -> Promise
const TTL_MS = 5 * 60 * 1000;

export function invalidateTicketTypesCache(workspaceId) {
  if (workspaceId === undefined) { cache.clear(); return; }
  cache.delete(workspaceId);
}

async function fetchTypes(workspaceId) {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.types;
  if (inflight.has(workspaceId)) return inflight.get(workspaceId);
  const promise = settingsAPI.getTicketTypes()
    .then((resp) => {
      const types = resp?.data || resp || [];
      cache.set(workspaceId, { at: Date.now(), types });
      return types;
    })
    .finally(() => inflight.delete(workspaceId));
  inflight.set(workspaceId, promise);
  return promise;
}

/**
 * The workspace's ticket-type registry (per-workspace vocabulary: names,
 * colors, abbreviations, default, FS mapping). Returns:
 *   { types, activeTypes, defaultType, typeByName(name), loading, refresh }
 */
export function useTicketTypes() {
  const { currentWorkspace, isWorkspaceSelected } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const [types, setTypes] = useState(() => cache.get(workspaceId)?.types || []);
  const [loading, setLoading] = useState(!cache.get(workspaceId));

  const refresh = useCallback(async ({ force = false } = {}) => {
    if (!workspaceId) return;
    if (force) invalidateTicketTypesCache(workspaceId);
    try {
      setTypes(await fetchTypes(workspaceId));
    } catch {
      /* silent — surfaces as empty registry; callers keep legacy fallbacks */
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (!isWorkspaceSelected || !workspaceId) { setTypes([]); return; }
    const hit = cache.get(workspaceId);
    if (hit && Date.now() - hit.at < TTL_MS) { setTypes(hit.types); setLoading(false); return; }
    setLoading(true);
    refresh();
  }, [isWorkspaceSelected, workspaceId, refresh]);

  const activeTypes = types.filter((t) => t.isActive);
  const defaultType = activeTypes.find((t) => t.isDefault) || activeTypes[0] || null;
  const typeByName = useCallback((name) => {
    if (!name) return null;
    const key = String(name).toLowerCase();
    return types.find((t) => t.name.toLowerCase() === key) || null;
  }, [types]);

  return { types, activeTypes, defaultType, typeByName, loading, refresh };
}
