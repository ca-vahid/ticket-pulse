import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { workspaceAPI, setWorkspaceId, setAuthToken } from '../services/api';
import { useAuth } from './AuthContext';

const WorkspaceContext = createContext(null);

const LS_KEY = 'tp_selectedWorkspace';
// Sticky flag for "the server never learned about the last workspace switch".
// sessionStorage because switchWorkspace() is usually followed by a full page
// reload — a plain state flag would die with the old document.
const SWITCH_ERR_KEY = 'tp_wsSwitchError';

function loadPersistedWorkspace() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const ws = JSON.parse(raw);
      if (ws?.id) {
        setWorkspaceId(ws.id);
        return ws;
      }
    }
  } catch { /* ignore */ }
  return null;
}

function persistWorkspace(ws) {
  try {
    if (ws) {
      localStorage.setItem(LS_KEY, JSON.stringify({ id: ws.id, name: ws.name, slug: ws.slug }));
    } else {
      localStorage.removeItem(LS_KEY);
    }
  } catch { /* ignore */ }
}

export function WorkspaceProvider({ children }) {
  const { workspaceData, isAuthenticated, isLoading: isAuthLoading } = useAuth();
  const [currentWorkspace, setCurrentWorkspace] = useState(() => loadPersistedWorkspace());
  const [availableWorkspaces, setAvailableWorkspaces] = useState([]);
  const [isHydrated, setIsHydrated] = useState(false);
  const hasHydratedRef = useRef(false);

  const isWorkspaceSelected = Boolean(currentWorkspace);

  useEffect(() => {
    if (isAuthLoading) return;

    if (!isAuthenticated) {
      setCurrentWorkspace(null);
      setAvailableWorkspaces([]);
      // Keep _workspaceId and localStorage intact during transient auth
      // states (session check → token exchange). They're only cleared
      // on explicit logout via clearWorkspace().
      setIsHydrated(true);
      return;
    }

    if (workspaceData && !hasHydratedRef.current) {
      hasHydratedRef.current = true;
      let workspaces = workspaceData.availableWorkspaces || [];

      // Sessions minted before nativeTicketingEnabled rode along lack the flag
      // (and would hide the Tickets nav tile) — enrich them from the API once.
      if (workspaces.length > 0 && workspaces.every((ws) => ws.nativeTicketingEnabled === undefined)) {
        workspaceAPI.getAll().then((res) => {
          const flags = new Map((res?.data || res || []).map((ws) => [ws.id, ws.nativeTicketingEnabled === true]));
          setAvailableWorkspaces((prev) => prev.map((ws) => ({
            ...ws,
            nativeTicketingEnabled: flags.get(ws.id) ?? false,
          })));
        }).catch(() => {});
      }

      if (workspaces.length === 0) {
        workspaceAPI.getAll().then(res => {
          const fetched = (res?.data || res || []).map(ws => ({
            id: ws.id, name: ws.name, slug: ws.slug, role: ws.role || 'viewer',
            nativeTicketingEnabled: ws.nativeTicketingEnabled === true,
          }));
          if (fetched.length > 0) {
            setAvailableWorkspaces(fetched);
            if (fetched.length === 1) {
              const ws = fetched[0];
              setCurrentWorkspace(ws);
              setWorkspaceId(ws.id);
              persistWorkspace(ws);
              workspaceAPI.select(ws.id).catch(() => {});
            }
          }
        }).catch(() => {});
      }

      setAvailableWorkspaces(workspaces);

      const serverSelectedId = workspaceData.selectedWorkspaceId;
      const localWs = loadPersistedWorkspace();
      const serverWorkspace = workspaces.find(w => w.id === serverSelectedId);

      // localStorage takes priority — it's updated synchronously during
      // switchWorkspace() before the page reload, while the server session
      // may lag behind due to cookie propagation timing.
      if (localWs && workspaces.some(w => w.id === localWs.id)) {
        setCurrentWorkspace(localWs);
        setWorkspaceId(localWs.id);
        if (localWs.id !== serverSelectedId) {
          workspaceAPI.select(localWs.id).catch(() => {});
        }
      } else if (serverWorkspace) {
        setCurrentWorkspace(serverWorkspace);
        setWorkspaceId(serverWorkspace.id);
        persistWorkspace(serverWorkspace);
      } else if (workspaces.length > 0) {
        // After a dev DB refresh, the session/localStorage can point at a
        // workspace ID that no longer exists. Fall back to a real workspace
        // instead of fabricating the stale ID and breaking workspace-scoped APIs.
        const ws = workspaces[0];
        setCurrentWorkspace(ws);
        setWorkspaceId(ws.id);
        persistWorkspace(ws);
        workspaceAPI.select(ws.id).catch(() => {});
      } else {
        setCurrentWorkspace(null);
        setWorkspaceId(null);
        persistWorkspace(null);
      }
    }

    setIsHydrated(true);
  }, [workspaceData, isAuthenticated, isAuthLoading]);

  const selectWorkspace = useCallback(async (workspaceId) => {
    const response = await workspaceAPI.select(workspaceId);
    if (response.authToken) {
      setAuthToken(response.authToken);
    }
    const ws = response.data?.workspace;
    if (ws) {
      const selected = { id: ws.id, name: ws.name, slug: ws.slug };
      setCurrentWorkspace(selected);
      setWorkspaceId(selected.id);
      persistWorkspace(selected);
      return selected;
    }
    return null;
  }, []);

  // ------------------------------------------------------------------
  // Local/server workspace divergence guard (realtime plan Phase 1).
  // switchWorkspace() updates localStorage + module state synchronously, but
  // the server-session select used to be fire-and-forget with a swallowed
  // error — a failed call left the SESSION on the old workspace, which is the
  // root of the wrong-SSE-channel zombie class. Now: one retry, then a
  // user-visible error (surfaced by AppHeader) that survives the reload.
  // ------------------------------------------------------------------
  const [switchError, setSwitchError] = useState(() => {
    try { return sessionStorage.getItem(SWITCH_ERR_KEY) || null; } catch { return null; }
  });

  const clearSwitchError = useCallback(() => {
    setSwitchError(null);
    try { sessionStorage.removeItem(SWITCH_ERR_KEY); } catch { /* ignore */ }
  }, []);

  const selectWorkspaceWithRetry = useCallback(async (targetId) => {
    const attempt = async () => { await selectWorkspace(targetId); };
    try {
      await attempt();
      clearSwitchError();
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      try {
        await attempt();
        clearSwitchError();
        return true;
      } catch {
        const message = 'Workspace switch did not reach the server — live updates and data may still show the previous workspace.';
        setSwitchError(message);
        try { sessionStorage.setItem(SWITCH_ERR_KEY, message); } catch { /* ignore */ }
        return false;
      }
    }
  }, [selectWorkspace, clearSwitchError]);

  // Re-attempt the server-side select for the locally selected workspace
  // (AppHeader's error banner "Retry" affordance).
  const retryWorkspaceSync = useCallback(async () => {
    const target = currentWorkspace?.id;
    if (!target) { clearSwitchError(); return false; }
    return selectWorkspaceWithRetry(target);
  }, [currentWorkspace?.id, selectWorkspaceWithRetry, clearSwitchError]);

  const switchWorkspace = useCallback((targetId) => {
    const ws = availableWorkspaces.find(w => w.id === targetId);
    const selected = ws
      ? { id: ws.id, name: ws.name, slug: ws.slug }
      : { id: targetId, name: '', slug: '' };

    setWorkspaceId(selected.id);
    persistWorkspace(selected);
    setCurrentWorkspace(selected);

    // Do NOT nuke the SWR dataCache on switch. Every cache key is workspace-
    // prefixed (`ws<id>:…`), so a workspace's entries can never bleed into
    // another's — keeping them means switching back to a workspace you already
    // viewed renders instantly from cache (stale-while-revalidate), instead of
    // sitting on a cold loading screen for a minute (QA 07-23 #6). The next
    // fetch for the target workspace revalidates in the background.

    // Clear only the LEGACY, non-workspace-scoped app keys. Preserve `tp_cache:`
    // (the workspace-prefixed SWR store) so revisits stay instant. Do NOT call
    // sessionStorage.clear() — that wipes MSAL's token cache (logout in incognito).
    const appKeys = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && (k.startsWith('dashboard_') || k.startsWith('techDetail') || k.startsWith('tl_'))) {
        appKeys.push(k);
      }
    }
    appKeys.forEach(k => sessionStorage.removeItem(k));

    // Fire-and-forget from the caller's perspective (callers may reload the
    // page immediately), but WITH retry + persistent visible error — see
    // selectWorkspaceWithRetry above.
    selectWorkspaceWithRetry(targetId);
  }, [availableWorkspaces, selectWorkspaceWithRetry]);

  const refreshWorkspaces = useCallback(async () => {
    try {
      const res = await workspaceAPI.getAll();
      const list = (res.data || []).map(ws => ({
        id: ws.id, name: ws.name, slug: ws.slug, role: ws.role,
        nativeTicketingEnabled: ws.nativeTicketingEnabled === true,
      }));
      setAvailableWorkspaces(list);
      return list;
    } catch { return availableWorkspaces; }
  }, [availableWorkspaces]);

  const clearWorkspace = useCallback(() => {
    setCurrentWorkspace(null);
    setAvailableWorkspaces([]);
    setWorkspaceId(null);
    persistWorkspace(null);
    hasHydratedRef.current = false;
  }, []);

  return (
    <WorkspaceContext.Provider
      value={{
        currentWorkspace,
        availableWorkspaces,
        isWorkspaceSelected,
        isHydrated,
        selectWorkspace,
        switchWorkspace,
        refreshWorkspaces,
        clearWorkspace,
        switchError,
        clearSwitchError,
        retryWorkspaceSync,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider');
  }
  return context;
}

/**
 * Tolerant variant for components that also render outside a
 * WorkspaceProvider (unit tests, embeddable widgets): returns null instead
 * of throwing.
 */
export function useWorkspaceOptional() {
  return useContext(WorkspaceContext);
}
