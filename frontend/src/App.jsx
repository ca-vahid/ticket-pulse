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
import SummitTaxonomyWorkshop from './pages/SummitTaxonomyWorkshop';
import SummitVote from './pages/SummitVote';
import MyCompetencies from './pages/MyCompetencies';
import DemoModeBanner from './components/DemoModeBanner';
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
    return <Navigate to="/my-competencies" replace />;
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
      return <Navigate to="/my-competencies" replace />;
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
  return <Navigate to={user?.role === 'agent' ? '/my-competencies' : '/dashboard'} replace />;
}

function AuthCallback() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      navigate(user?.role === 'agent' ? '/my-competencies' : '/dashboard', { replace: true });
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
                  path="/my-competencies"
                  element={
                    <AgentRoute>
                      <MyCompetencies />
                    </AgentRoute>
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
              <DemoModeBanner />
            </SettingsProvider>
          </DashboardProvider>
        </WorkspaceProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
