import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { workspaceAPI, setWorkspaceId, setAuthToken } from '../services/api';
import { dataCache } from '../services/dataCache';
import { useAuth } from './AuthContext';

const WorkspaceContext = createContext(null);

const LS_KEY = 'tp_selectedWorkspace';

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

      if (workspaces.length === 0) {
        workspaceAPI.getAll().then(res => {
          const fetched = (res?.data || res || []).map(ws => ({
            id: ws.id, name: ws.name, slug: ws.slug, role: ws.role || 'viewer',
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

      // localStorage takes priority — it's updated synchronously during
      // switchWorkspace() before the page reload, while the server session
      // may lag behind due to cookie propagation timing.
      if (localWs && workspaces.some(w => w.id === localWs.id)) {
        setCurrentWorkspace(localWs);
        setWorkspaceId(localWs.id);
        if (localWs.id !== serverSelectedId) {
          workspaceAPI.select(localWs.id).catch(() => {});
        }
      } else if (serverSelectedId) {
        const ws = workspaces.find(w => w.id === serverSelectedId) || {
          id: serverSelectedId,
          name: workspaceData.selectedWorkspaceName || 'Workspace',
          slug: workspaceData.selectedWorkspaceSlug || '',
        };
        setCurrentWorkspace(ws);
        setWorkspaceId(ws.id);
        persistWorkspace(ws);
      } else if (workspaces.length === 1) {
        const ws = workspaces[0];
        setCurrentWorkspace(ws);
        setWorkspaceId(ws.id);
        persistWorkspace(ws);
        workspaceAPI.select(ws.id).catch(() => {});
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

  const switchWorkspace = useCallback((targetId) => {
    const ws = availableWorkspaces.find(w => w.id === targetId);
    const selected = ws
      ? { id: ws.id, name: ws.name, slug: ws.slug }
      : { id: targetId, name: '', slug: '' };

    setWorkspaceId(selected.id);
    persistWorkspace(selected);
    setCurrentWorkspace(selected);

    dataCache.clear();

    // Clear only app-owned sessionStorage keys. Do NOT call sessionStorage.clear()
    // because that wipes MSAL's token cache, causing logout in incognito mode.
    const appKeys = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && (k.startsWith('tp_cache:') || k.startsWith('dashboard_') || k.startsWith('techDetail') || k.startsWith('tl_'))) {
        appKeys.push(k);
      }
    }
    appKeys.forEach(k => sessionStorage.removeItem(k));

    selectWorkspace(targetId).catch(() => {});
  }, [availableWorkspaces, selectWorkspace]);

  const refreshWorkspaces = useCallback(async () => {
    try {
      const res = await workspaceAPI.getAll();
      const list = (res.data || []).map(ws => ({
        id: ws.id, name: ws.name, slug: ws.slug, role: ws.role,
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
