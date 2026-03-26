import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { workspaceAPI, setWorkspaceId } from '../services/api';
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
      setWorkspaceId(null);
      persistWorkspace(null);
      setIsHydrated(true);
      return;
    }

    if (workspaceData && !hasHydratedRef.current) {
      hasHydratedRef.current = true;
      const workspaces = workspaceData.availableWorkspaces || [];
      setAvailableWorkspaces(workspaces);

      const serverSelectedId = workspaceData.selectedWorkspaceId;
      const localWs = loadPersistedWorkspace();

      if (serverSelectedId) {
        const ws = workspaces.find(w => w.id === serverSelectedId) || {
          id: serverSelectedId,
          name: workspaceData.selectedWorkspaceName || 'Workspace',
          slug: workspaceData.selectedWorkspaceSlug || '',
        };
        setCurrentWorkspace(ws);
        setWorkspaceId(ws.id);
        persistWorkspace(ws);
      } else if (localWs && workspaces.some(w => w.id === localWs.id)) {
        setCurrentWorkspace(localWs);
        setWorkspaceId(localWs.id);
        workspaceAPI.select(localWs.id).catch(() => {});
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

  const switchWorkspace = useCallback(async (workspaceId) => {
    sessionStorage.clear();
    const ws = await selectWorkspace(workspaceId);
    return ws;
  }, [selectWorkspace]);

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
