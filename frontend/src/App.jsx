import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { WorkspaceProvider, useWorkspace } from './contexts/WorkspaceContext';
import { DashboardProvider } from './contexts/DashboardContext';
import { SettingsProvider } from './contexts/SettingsContext';
import { ThemeProvider } from './contexts/ThemeContext';
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
import AdminRoute, { LoadingScreen } from './components/nav/AdminRoute';
import AccessBounceToast from './components/nav/AccessBounceToast';
import { homePathFor, useWorkspaceRole } from './components/nav/navDestinations';

/*
 * Role model (v3.7.02, QA 08-24 #3): the former ProtectedRoute (any member)
 * is gone — every page beyond Tickets/Approvals is workspace-admin only and
 * sits behind AdminRoute (components/nav/AdminRoute.jsx). Viewers, reviewers
 * and agents share the ticket surface via TicketsRoute.
 */

/**
 * Tickets Route wrapper — like ProtectedRoute but agents are first-class:
 * they reach /tickets with a workspace resolved from their technician profile.
 */
function TicketsRoute({ children }) {
  const { isAuthenticated, isLoading } = useAuth();
  const { isWorkspaceSelected, availableWorkspaces, isHydrated } = useWorkspace();

  if (isLoading || !isHydrated) return <LoadingScreen />;

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (!isWorkspaceSelected && availableWorkspaces.length !== 1) {
    return <Navigate to="/workspace" replace />;
  }

  return children;
}

/**
 * Public Route wrapper — sends an already signed-in user home. Home is role
 * aware (homePathFor): admins → /dashboard, everyone else → /tickets, and it
 * waits for workspace hydration so the role is known rather than guessed.
 */
function PublicRoute({ children }) {
  const { user, isAuthenticated, isLoading } = useAuth();
  const { isHydrated } = useWorkspace();
  const wsRole = useWorkspaceRole();

  if (isLoading || (isAuthenticated && !isHydrated)) return <LoadingScreen />;

  if (isAuthenticated) {
    return <Navigate to={homePathFor(user, wsRole)} replace />;
  }

  return children;
}

function AgentRoute({ children }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) return <LoadingScreen />;

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return children;
}

function HomeRedirect() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const { isHydrated } = useWorkspace();
  const wsRole = useWorkspaceRole();

  if (isLoading || (isAuthenticated && !isHydrated)) return <LoadingScreen />;

  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <Navigate to={homePathFor(user, wsRole)} replace />;
}

function AuthCallback() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const { isHydrated } = useWorkspace();
  const wsRole = useWorkspaceRole();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isLoading && isAuthenticated && isHydrated) {
      navigate(homePathFor(user, wsRole), { replace: true });
    }
    if (!isLoading && !isAuthenticated) {
      const timer = setTimeout(() => {
        navigate('/login', { replace: true });
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [isAuthenticated, isLoading, isHydrated, navigate, user, wsRole]);

  return <LoadingScreen label="Completing sign-in..." />;
}

function App() {
  return (
    <ThemeProvider>
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

                    {/* Admin-only routes (v3.7.02 role lockdown) */}
                    <Route
                      path="/dashboard"
                      element={
                        <AdminRoute>
                          <Dashboard />
                        </AdminRoute>
                      }
                    />

                    <Route
                      path="/technician/:id"
                      element={
                        <AdminRoute>
                          <TechnicianDetailNew />
                        </AdminRoute>
                      }
                    />

                    <Route
                      path="/settings"
                      element={
                        <AdminRoute>
                          <Settings />
                        </AdminRoute>
                      }
                    />

                    <Route
                      path="/visuals"
                      element={
                        <AdminRoute>
                          <Visuals />
                        </AdminRoute>
                      }
                    />

                    <Route
                      path="/timeline"
                      element={
                        <AdminRoute>
                          <TimelineExplorer />
                        </AdminRoute>
                      }
                    />

                    <Route
                      path="/analytics"
                      element={
                        <AdminRoute>
                          <Analytics />
                        </AdminRoute>
                      }
                    />

                    <Route
                      path="/analytics/category-map"
                      element={
                        <AdminRoute>
                          <Analytics view="category-map" />
                        </AdminRoute>
                      }
                    />

                    <Route
                      path="/workflows"
                      element={
                        <AdminRoute>
                          <WorkflowsPage />
                        </AdminRoute>
                      }
                    />
                    <Route
                      path="/workflows/:tab"
                      element={
                        <AdminRoute>
                          <WorkflowsPage />
                        </AdminRoute>
                      }
                    />

                    <Route
                      path="/summit-taxonomy"
                      element={
                        <AdminRoute>
                          <SummitTaxonomyWorkshop />
                        </AdminRoute>
                      }
                    />

                    <Route
                      path="/assignments"
                      element={
                        <AdminRoute>
                          <AssignmentReview />
                        </AdminRoute>
                      }
                    />
                    <Route
                      path="/assignments/:tab"
                      element={
                        <AdminRoute>
                          <AssignmentReview />
                        </AdminRoute>
                      }
                    />
                    <Route
                      path="/assignments/run/:runId"
                      element={
                        <AdminRoute>
                          <AssignmentReview />
                        </AdminRoute>
                      }
                    />
                    <Route
                      path="/assignments/history/:historyRunId"
                      element={
                        <AdminRoute>
                          <AssignmentReview />
                        </AdminRoute>
                      }
                    />
                    <Route
                      path="/assignments/live/:ticketId"
                      element={
                        <AdminRoute>
                          <AssignmentReview />
                        </AdminRoute>
                      }
                    />
                    <Route
                      path="/assignments/competency-run/:competencyRunId"
                      element={
                        <AdminRoute>
                          <AssignmentReview />
                        </AdminRoute>
                      }
                    />
                    <Route
                      path="/assignments/competency-live/:analyzeTechId"
                      element={
                        <AdminRoute>
                          <AssignmentReview />
                        </AdminRoute>
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
                <AccessBounceToast />
                <CommandPalette />
              </SettingsProvider>
            </DashboardProvider>
          </WorkspaceProvider>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default App;
