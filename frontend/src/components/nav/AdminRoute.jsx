import { Navigate, useLocation } from 'react-router-dom';
import { Activity } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { ACCESS_BOUNCE_KEY, canViewOps, isWorkspaceAdmin, useWorkspaceRole } from './navDestinations';

export function LoadingScreen({ label = 'Loading...' }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center">
        <Activity className="w-12 h-12 animate-spin mx-auto mb-4 text-blue-600" />
        <p className="text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

/**
 * AdminRoute (v3.7.02 role lockdown, QA 08-24 #3): ProtectedRoute semantics —
 * signed in, workspace list hydrated, a workspace selected — PLUS a workspace-
 * admin (or global-admin) check. Everyone else is sent to /tickets.
 *
 * Waits on `isHydrated` before deciding so a workspace admin never sees a
 * flash-bounce while the role is still unknown (useWorkspaceRole fails
 * CLOSED to null until then). Wraps Dashboard, Technician detail, Timeline,
 * Analytics, Agent Maps, Assignment Review, Mail Workflows, Summit, Settings.
 */
export default function AdminRoute({ children }) {
  const { user, isAuthenticated, isLoading } = useAuth();
  const { isWorkspaceSelected, availableWorkspaces, isHydrated } = useWorkspace();
  const wsRole = useWorkspaceRole();
  const location = useLocation();

  if (isLoading || !isHydrated) return <LoadingScreen />;

  if (!isAuthenticated) return <Navigate to="/login" replace />;

  if (user?.role === 'agent') return <Navigate to="/tickets" replace />;

  if (!isWorkspaceSelected && availableWorkspaces.length !== 1) {
    return <Navigate to="/workspace" replace />;
  }

  if (!isWorkspaceAdmin(user, wsRole)) {
    try { sessionStorage.setItem(ACCESS_BOUNCE_KEY, location.pathname); } catch { /* no-op */ }
    return <Navigate to="/tickets" replace />;
  }

  return children;
}

/**
 * ViewRoute (Sep 2026): AdminRoute semantics, but the read-only observer role
 * passes too. Wraps the watch-don't-touch pages — Dashboard, Technician
 * detail, Timeline, Analytics — where a 'readonly' grant may look while the
 * server blocks every mutation. Everything operational (Assignment Review,
 * Mail Workflows, Agent Maps, Settings, Summit) stays behind AdminRoute.
 */
export function ViewRoute({ children }) {
  const { user, isAuthenticated, isLoading } = useAuth();
  const { isWorkspaceSelected, availableWorkspaces, isHydrated } = useWorkspace();
  const wsRole = useWorkspaceRole();
  const location = useLocation();

  if (isLoading || !isHydrated) return <LoadingScreen />;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (user?.role === 'agent') return <Navigate to="/tickets" replace />;
  if (!isWorkspaceSelected && availableWorkspaces.length !== 1) {
    return <Navigate to="/workspace" replace />;
  }
  if (!canViewOps(user, wsRole)) {
    try { sessionStorage.setItem(ACCESS_BOUNCE_KEY, location.pathname); } catch { /* no-op */ }
    return <Navigate to="/tickets" replace />;
  }
  return children;
}
