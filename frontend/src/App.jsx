import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { WorkspaceProvider, useWorkspace } from './contexts/WorkspaceContext';
import { DashboardProvider } from './contexts/DashboardContext';
import { SettingsProvider } from './contexts/SettingsContext';
import Login from './pages/Login';
import WorkspacePicker from './pages/WorkspacePicker';
import Dashboard from './pages/Dashboard';
import TechnicianDetailNew from './pages/TechnicianDetailNew';
import Settings from './pages/Settings';
import Visuals from './pages/Visuals';
import TimelineExplorer from './pages/TimelineExplorer';
import AssignmentReview from './pages/AssignmentReview';
import Analytics from './pages/Analytics';
import WorkflowsPage from './pages/WorkflowsPage';
import SummitTaxonomyWorkshop from './pages/SummitTaxonomyWorkshop';
import SummitVote from './pages/SummitVote';
import SummitReport from './pages/SummitReport';
import PublicTicketStatus from './pages/PublicTicketStatus';
import PublicTicketEscalation from './pages/PublicTicketEscalation';
import PublicTicketUrgency from './pages/PublicTicketUrgency';
import PublicTicketFeedback from './pages/PublicTicketFeedback';
import MyCompetencies from './pages/MyCompetencies';
import Notifications from './pages/Notifications';
import Tickets from './pages/Tickets';
import TicketCreate from './pages/TicketCreate';
import TicketDetail from './pages/TicketDetail';
import ApprovalsInbox from './pages/ApprovalsInbox';
import PublicApprovalDecision from './pages/PublicApprovalDecision';
import DemoModeBanner from './components/DemoModeBanner';
import ErrorBoundary from './components/ErrorBoundary';
import EmailHealthBanner from './components/EmailHealthBanner';
import SyncHealthBanner from './components/SyncHealthBanner';
import CommandPalette from './components/CommandPalette';
import { Activity } from 'lucide-react';

/**
 * Protected Route wrapper
 * Redirects to login if not authenticated
 */
function ProtectedRoute({ children }) {
  const { user, isAuthenticated, isLoading } = useAuth();
  const { isWorkspaceSelected, availableWorkspaces, isHydrated } = useWorkspace();

  if (isLoading || !isHydrated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="text-center">
          <Activity className="w-12 h-12 animate-spin mx-auto mb-4 text-blue-600" />
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (user?.role === 'agent') {
    return <Navigate to="/tickets" replace />;
  }

  if (!isWorkspaceSelected && availableWorkspaces.length !== 1) {
    return <Navigate to="/workspace" replace />;
  }

  return children;
}

/**
 * Tickets Route wrapper — like ProtectedRoute but agents are first-class:
 * they reach /tickets with a workspace resolved from their technician profile.
 */
function TicketsRoute({ children }) {
  const { isAuthenticated, isLoading } = useAuth();
  const { isWorkspaceSelected, availableWorkspaces, isHydrated } = useWorkspace();

  if (isLoading || !isHydrated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="text-center">
          <Activity className="w-12 h-12 animate-spin mx-auto mb-4 text-blue-600" />
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (!isWorkspaceSelected && availableWorkspaces.length !== 1) {
    return <Navigate to="/workspace" replace />;
  }

  return children;
}

/**
 * Public Route wrapper
 * Redirects to dashboard if already authenticated
 */
function PublicRoute({ children }) {
  const { user, isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="text-center">
          <Activity className="w-12 h-12 animate-spin mx-auto mb-4 text-blue-600" />
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (isAuthenticated) {
    if (user?.role === 'agent') {
      return <Navigate to="/tickets" replace />;
    }
    return <Navigate to="/dashboard" replace />;
  }

  return children;
}

function AgentRoute({ children }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="text-center">
          <Activity className="w-12 h-12 animate-spin mx-auto mb-4 text-blue-600" />
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return children;
}

function HomeRedirect() {
  const { user, isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="text-center">
          <Activity className="w-12 h-12 animate-spin mx-auto mb-4 text-blue-600" />
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <Navigate to={user?.role === 'agent' ? '/tickets' : '/dashboard'} replace />;
}

function AuthCallback() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      navigate(user?.role === 'agent' ? '/tickets' : '/dashboard', { replace: true });
    }
    if (!isLoading && !isAuthenticated) {
      const timer = setTimeout(() => {
        navigate('/login', { replace: true });
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [isAuthenticated, isLoading, navigate, user?.role]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="text-center">
        <Activity className="w-12 h-12 animate-spin mx-auto mb-4 text-blue-600" />
        <p className="text-gray-600">Completing sign-in...</p>
      </div>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <WorkspaceProvider>
          <DashboardProvider>
            <SettingsProvider>
              {/* Top-level crash guard (QA 08-07 #10): a render throw anywhere
                  in the routed tree shows a recoverable fallback card instead
                  of white-screening ("the page refreshed itself"). */}
              <ErrorBoundary>
                <Routes>
                  {/* Public Routes */}
                  <Route
                    path="/login"
                    element={
                      <PublicRoute>
                        <Login />
                      </PublicRoute>
                    }
                  />

                  {/* Workspace Selection (authenticated but no workspace yet) */}
                  <Route
                    path="/workspace"
                    element={
                      <WorkspacePicker />
                    }
                  />

                  <Route
                    path="/summit/vote/:token"
                    element={<SummitVote />}
                  />

                  <Route
                    path="/summit/report/:token"
                    element={<SummitReport />}
                  />

                  <Route
                    path="/ticket-status/:token"
                    element={<PublicTicketStatus />}
                  />

                  <Route
                    path="/ticket-escalation/:token"
                    element={<PublicTicketEscalation />}
                  />

                  <Route
                    path="/ticket-urgency/:token"
                    element={<PublicTicketUrgency />}
                  />

                  <Route
                    path="/feedback/:token"
                    element={<PublicTicketFeedback />}
                  />

                  <Route
                    path="/approval/:token"
                    element={<PublicApprovalDecision />}
                  />

                  <Route
                    path="/my-competencies"
                    element={
                      <AgentRoute>
                        <MyCompetencies />
                      </AgentRoute>
                    }
                  />

                  <Route
                    path="/notifications"
                    element={
                      <AgentRoute>
                        <Notifications />
                      </AgentRoute>
                    }
                  />

                  {/* Native ticketing (agents are first-class here) */}
                  <Route
                    path="/tickets"
                    element={
                      <TicketsRoute>
                        <Tickets />
                      </TicketsRoute>
                    }
                  />
                  <Route
                    path="/tickets/new"
                    element={
                      <TicketsRoute>
                        <TicketCreate />
                      </TicketsRoute>
                    }
                  />
                  <Route
                    path="/approvals"
                    element={
                      <TicketsRoute>
                        <ApprovalsInbox />
                      </TicketsRoute>
                    }
                  />
                  <Route
                    path="/tickets/:id"
                    element={
                      <TicketsRoute>
                        <TicketDetail />
                      </TicketsRoute>
                    }
                  />

                  {/* Protected Routes */}
                  <Route
                    path="/dashboard"
                    element={
                      <ProtectedRoute>
                        <Dashboard />
                      </ProtectedRoute>
                    }
                  />

                  <Route
                    path="/technician/:id"
                    element={
                      <ProtectedRoute>
                        <TechnicianDetailNew />
                      </ProtectedRoute>
                    }
                  />

                  <Route
                    path="/settings"
                    element={
                      <ProtectedRoute>
                        <Settings />
                      </ProtectedRoute>
                    }
                  />

                  <Route
                    path="/visuals"
                    element={
                      <ProtectedRoute>
                        <Visuals />
                      </ProtectedRoute>
                    }
                  />

                  <Route
                    path="/timeline"
                    element={
                      <ProtectedRoute>
                        <TimelineExplorer />
                      </ProtectedRoute>
                    }
                  />

                  <Route
                    path="/analytics"
                    element={
                      <ProtectedRoute>
                        <Analytics />
                      </ProtectedRoute>
                    }
                  />

                  <Route
                    path="/analytics/category-map"
                    element={
                      <ProtectedRoute>
                        <Analytics view="category-map" />
                      </ProtectedRoute>
                    }
                  />

                  <Route
                    path="/workflows"
                    element={
                      <ProtectedRoute>
                        <WorkflowsPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/workflows/:tab"
                    element={
                      <ProtectedRoute>
                        <WorkflowsPage />
                      </ProtectedRoute>
                    }
                  />

                  <Route
                    path="/summit-taxonomy"
                    element={
                      <ProtectedRoute>
                        <SummitTaxonomyWorkshop />
                      </ProtectedRoute>
                    }
                  />

                  <Route
                    path="/assignments"
                    element={
                      <ProtectedRoute>
                        <AssignmentReview />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/assignments/:tab"
                    element={
                      <ProtectedRoute>
                        <AssignmentReview />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/assignments/run/:runId"
                    element={
                      <ProtectedRoute>
                        <AssignmentReview />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/assignments/history/:historyRunId"
                    element={
                      <ProtectedRoute>
                        <AssignmentReview />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/assignments/live/:ticketId"
                    element={
                      <ProtectedRoute>
                        <AssignmentReview />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/assignments/competency-run/:competencyRunId"
                    element={
                      <ProtectedRoute>
                        <AssignmentReview />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/assignments/competency-live/:analyzeTechId"
                    element={
                      <ProtectedRoute>
                        <AssignmentReview />
                      </ProtectedRoute>
                    }
                  />

                  {/* Auth callback */}
                  <Route
                    path="/auth/callback"
                    element={<AuthCallback />}
                  />

                  {/* Default Route */}
                  <Route path="/" element={<HomeRedirect />} />

                  {/* 404 Catch-all */}
                  <Route path="*" element={<HomeRedirect />} />
                </Routes>
              </ErrorBoundary>
              <DemoModeBanner />
              {/* Admin health banners share one bottom-left stack so email +
                  stale-sync warnings never overlap each other. */}
              <div className="fixed bottom-3 left-3 z-[9998] flex flex-col gap-2">
                <SyncHealthBanner />
                <EmailHealthBanner />
              </div>
              <CommandPalette />
            </SettingsProvider>
          </DashboardProvider>
        </WorkspaceProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
