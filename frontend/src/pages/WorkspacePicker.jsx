import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useAuth } from '../contexts/AuthContext';
import { LogOut, ArrowRight } from 'lucide-react';
import { useDemoMode, useDemoLabel, scrubFreeText as scrubDemoText } from '../utils/demoMode';

export default function WorkspacePicker() {
  const { availableWorkspaces, selectWorkspace } = useWorkspace();
  const { user, logout } = useAuth();
  const demoMode = useDemoMode();
  const welcomeName = useDemoLabel('name', user?.name || 'User');
  const _navigate = useNavigate();
  const [selecting, setSelecting] = useState(null);
  const [error, setError] = useState(null);

  const handleSelect = async (ws) => {
    setSelecting(ws.id);
    setError(null);
    try {
      await selectWorkspace(ws.id);
      window.location.href = '/dashboard';
    } catch (err) {
      setError(err.message || 'Failed to select workspace');
      setSelecting(null);
    }
  };

  const handleLogout = async () => {
    try {
      await logout();
    } catch {
      // ignore
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-slate-50 to-blue-50 bg-no-repeat bg-cover"
      style={{ backgroundImage: 'url(/brand/dashboard-background.webp)' }}
    >
      <div className="w-full max-w-2xl">
        <div className="text-center mb-8">
          <img
            src="/brand/logo-mark.png"
            alt=""
            className="w-16 h-16 mx-auto mb-4 drop-shadow-md"
          />
          <img
            src="/brand/logo-wordmark.png"
            alt="Ticket Pulse"
            className="h-7 w-auto mx-auto mb-4"
          />
          <h1 className="text-2xl font-bold text-gray-900">Select Workspace</h1>
          <p className="text-gray-500 mt-1">
            Welcome, {welcomeName}. Choose a workspace to continue.
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm text-center">
            {error}
          </div>
        )}

        <div className="grid gap-3">
          {availableWorkspaces.map((ws) => (
            <button
              key={ws.id}
              onClick={() => handleSelect(ws)}
              disabled={selecting !== null}
              className={`
                w-full text-left p-5 bg-white rounded-xl border-2 transition-all
                ${selecting === ws.id
              ? 'border-blue-500 bg-blue-50'
              : 'border-gray-200 hover:border-blue-300 hover:shadow-md'
            }
                ${selecting !== null && selecting !== ws.id ? 'opacity-50' : ''}
                disabled:cursor-not-allowed
              `}
            >
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">{demoMode ? scrubDemoText(ws.name) : ws.name}</h3>
                  <p className="text-sm text-gray-500 mt-0.5">
                    {demoMode ? scrubDemoText(ws.slug) : ws.slug} workspace
                    {ws.role === 'admin' && (
                      <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700">
                        Admin
                      </span>
                    )}
                  </p>
                </div>
                <ArrowRight className={`w-5 h-5 ${selecting === ws.id ? 'text-blue-500 animate-pulse' : 'text-gray-400'}`} />
              </div>
            </button>
          ))}
        </div>

        {availableWorkspaces.length === 0 && (
          <div className="text-center p-8 bg-white rounded-xl border border-gray-200">
            <p className="text-gray-500">No workspaces available.</p>
            <p className="text-sm text-gray-400 mt-1">Contact an administrator to get access.</p>
          </div>
        )}

        <div className="mt-6 text-center">
          <button
            onClick={handleLogout}
            className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
