import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Calendar,
  Clock,
  LayoutDashboard,
  Map,
  RefreshCw,
  Settings,
  Sparkles,
  Wifi,
  WifiOff,
  XCircle,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useDashboard } from '../contexts/DashboardContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import {
  scrubFreeText as scrubDemoText,
  useDemoLabel,
  useDemoMode,
} from '../utils/demoMode';
import { APP_VERSION } from '../data/changelog';
import ChangelogModal from './ChangelogModal';

export default function AppHeader({
  activePage = 'dashboard',
  dashboardActions = null,
  extraActions = null,
  backgroundSyncRunning = false,
  backgroundSyncStep = null,
  killingSync = false,
  onKillSync,
  clearCacheOnLogout,
  isColdLoading = false,
}) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { currentWorkspace, availableWorkspaces, switchWorkspace } = useWorkspace();
  const { isRefreshing, lastUpdated, sseConnectionStatus } = useDashboard();
  const [showChangelog, setShowChangelog] = useState(false);

  const demoMode = useDemoMode();
  const displayUserName = useDemoLabel('name', user?.name || user?.username || 'User');
  const userInitials = String(displayUserName || 'U')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || 'U';
  const isGlobalAdmin = user?.role === 'admin';
  const wsRole = (() => {
    if (isGlobalAdmin) return 'admin';
    const ws = availableWorkspaces?.find(w => w.id === currentWorkspace?.id);
    return ws?.role || 'viewer';
  })();
  const canReview = wsRole === 'admin' || wsRole === 'reviewer';

  const handleLogout = async () => {
    clearCacheOnLogout?.();
    await logout();
    navigate('/login');
  };

  const primaryNavItems = [
    {
      id: 'dashboard',
      label: 'Dashboard',
      path: '/dashboard',
      Icon: LayoutDashboard,
      inactiveClass: 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 hover:border-blue-300',
    },
    {
      id: 'timeline',
      label: 'Timeline',
      path: '/timeline',
      Icon: Clock,
      inactiveClass: 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 hover:border-indigo-300',
    },
    ...(canReview || activePage === 'assignments' ? [{
      id: 'assignments',
      label: 'Assignment',
      path: '/assignments',
      Icon: Sparkles,
      inactiveClass: 'border-purple-200 bg-purple-50 text-purple-700 hover:bg-purple-100 hover:border-purple-300',
    }] : []),
  ];

  const renderPrimaryNav = (compact = false, options = {}) => {
    const visibleItems = options.hideActive
      ? primaryNavItems.filter(({ id }) => activePage !== id)
      : primaryNavItems;

    return (
      <div className={`inline-flex flex-none items-center ${compact ? 'gap-1' : 'gap-1.5'}`} aria-label="Primary navigation">
        {visibleItems.map(({ id, label, path, Icon, inactiveClass }) => {
          const isActive = activePage === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => {
                if (!isActive) navigate(path);
              }}
              aria-current={isActive ? 'page' : undefined}
              aria-disabled={isActive ? 'true' : undefined}
              className={`${compact ? 'h-8 w-8 rounded-lg' : 'h-10 w-10 rounded-xl'} inline-flex flex-none items-center justify-center border transition-colors ${
                isActive
                  ? 'cursor-default border-slate-200 bg-slate-100 text-slate-400'
                  : `${inactiveClass} hover:shadow-sm`
              }`}
              title={isActive ? `${label} (current page)` : label}
            >
              <Icon className={compact ? 'h-4 w-4' : 'h-5 w-5'} />
            </button>
          );
        })}
      </div>
    );
  };

  const renderWorkspaceControl = (compact = false) => {
    if (!currentWorkspace) return null;

    if (availableWorkspaces.length > 1) {
      return (
        <select
          value={currentWorkspace.id}
          onChange={(e) => {
            const newId = Number(e.target.value);
            if (newId === currentWorkspace.id) return;
            switchWorkspace(newId);
            window.location.reload();
          }}
          className={`min-w-0 bg-blue-50 text-blue-700 border border-blue-200 rounded font-medium cursor-pointer hover:bg-blue-100 ${
            compact ? 'max-w-[9rem] px-1 py-0.5 text-[10px]' : 'max-w-[14rem] px-1.5 py-0.5 text-xs'
          }`}
          title="Switch workspace"
        >
          {availableWorkspaces.map(ws => (
            <option key={ws.id} value={ws.id}>{demoMode ? scrubDemoText(ws.name) : ws.name}{ws.role ? ` [${ws.role}]` : ''}</option>
          ))}
        </select>
      );
    }

    return (
      <span className={`min-w-0 truncate bg-blue-50 text-blue-700 border border-blue-200 rounded font-medium ${
        compact ? 'max-w-[9rem] px-1 py-0.5 text-[10px]' : 'max-w-[14rem] px-1.5 py-0.5 text-xs'
      }`}>
        {demoMode ? scrubDemoText(currentWorkspace.name) : currentWorkspace.name}
      </span>
    );
  };

  return (
    <>
      <header className="sticky top-0 z-40 bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-3 sm:px-4 py-2">
          <div className="flex items-center justify-between gap-2 md:hidden">
            <div className="flex-1 min-w-0">
              <div className="flex min-w-0 items-center gap-1.5">
                <div className="relative h-9 w-[112px] overflow-hidden flex items-center justify-start flex-shrink-0">
                  <button type="button" onClick={() => navigate('/dashboard')} title="Dashboard">
                    <img
                      src="/brand/logo-wordmark.png"
                      alt="Ticket Pulse"
                      className="h-24 w-auto"
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowChangelog(true)}
                    className="absolute bottom-0 right-0 rounded border border-blue-200 bg-white/95 px-1 py-px text-[8px] font-semibold leading-none text-blue-600 shadow-sm"
                    title="View changelog"
                  >
                    v{APP_VERSION}
                  </button>
                </div>
                {renderWorkspaceControl(true)}
              </div>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {extraActions}
              {backgroundSyncRunning && (
                <button
                  onClick={onKillSync}
                  disabled={killingSync || !onKillSync}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-blue-200 bg-blue-50 text-blue-700 touch-manipulation disabled:opacity-50"
                  title={backgroundSyncStep ? `Syncing: ${backgroundSyncStep} (tap to stop)` : 'Syncing... (tap to stop)'}
                >
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                </button>
              )}
              {renderPrimaryNav(true, { hideActive: true })}
              <button onClick={() => navigate('/settings')} className="inline-flex h-8 w-8 items-center justify-center rounded-lg hover:bg-gray-100 touch-manipulation" title="Settings"><Settings className="w-4 h-4" /></button>
              <button
                onClick={handleLogout}
                className="h-8 w-8 rounded-full border border-slate-200 bg-slate-100 text-slate-700 text-[11px] font-bold hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-colors touch-manipulation"
                title={`Sign out ${displayUserName}`}
              >
                {userInitials}
              </button>
            </div>
          </div>

          <div className="hidden md:grid grid-cols-12 gap-4 items-center">
            <div className="col-span-4">
              <div className="flex min-w-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => navigate('/dashboard')}
                  className="h-10 w-[150px] overflow-hidden flex items-center justify-start flex-shrink-0"
                  title="Dashboard"
                >
                  <img
                    src="/brand/logo-wordmark.png"
                    alt="Ticket Pulse"
                    className="h-28 w-auto"
                  />
                </button>
                <button
                  onClick={() => setShowChangelog(true)}
                  className="text-[10px] font-semibold text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded hover:bg-blue-100 border border-blue-200 transition-colors flex-shrink-0"
                  title="View changelog"
                >
                  v{APP_VERSION}
                </button>
                {renderWorkspaceControl(false)}
              </div>
            </div>

            <div className="col-span-4 flex items-center justify-center gap-3 min-w-0">
              <div className="flex items-center gap-1.5 text-xs flex-shrink-0">
                {sseConnectionStatus === 'connected' ? (
                  <>
                    <Wifi className="w-3.5 h-3.5 text-green-600" />
                    <span className="text-green-600 font-medium">Live</span>
                  </>
                ) : sseConnectionStatus === 'connecting' ? (
                  <>
                    <Wifi className="w-3.5 h-3.5 text-amber-500 animate-pulse" />
                    <span className="text-amber-500 font-medium">Connecting...</span>
                  </>
                ) : (
                  <>
                    <WifiOff className="w-3.5 h-3.5 text-red-600" />
                    <span className="text-red-600 font-medium">Offline</span>
                  </>
                )}
              </div>

              {backgroundSyncRunning && (() => {
                const progressMatch = backgroundSyncStep && backgroundSyncStep.match(/(\d+)\s*\/\s*(\d+)/);
                const pct = progressMatch
                  ? Math.min(100, Math.max(0, (parseInt(progressMatch[1], 10) / Math.max(1, parseInt(progressMatch[2], 10))) * 100))
                  : null;
                const tooltip = backgroundSyncStep
                  ? `Syncing: ${backgroundSyncStep}\n(click X to stop)`
                  : 'Syncing... (click X to stop)';
                return (
                  <div
                    className="flex items-center gap-1 bg-blue-50 border border-blue-200 rounded-full px-1.5 py-0.5 flex-shrink-0"
                    title={tooltip}
                  >
                    <div className="relative flex items-center justify-center w-5 h-5">
                      <RefreshCw className="w-3.5 h-3.5 text-blue-500 animate-spin" />
                      {pct !== null && (
                        <svg className="absolute inset-0 w-5 h-5 -rotate-90" viewBox="0 0 20 20">
                          <circle cx="10" cy="10" r="8" fill="none" stroke="#bfdbfe" strokeWidth="2" />
                          <circle
                            cx="10" cy="10" r="8" fill="none"
                            stroke="#2563eb" strokeWidth="2"
                            strokeDasharray={`${(pct / 100) * 2 * Math.PI * 8} ${2 * Math.PI * 8}`}
                            strokeLinecap="round"
                          />
                        </svg>
                      )}
                    </div>
                    <button
                      onClick={onKillSync}
                      disabled={killingSync || !onKillSync}
                      className="flex-none p-0.5 rounded-full hover:bg-red-100 text-slate-400 hover:text-red-600 transition-colors"
                      title="Force-stop stuck sync"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })()}

              {isRefreshing && !isColdLoading ? (
                <span className="text-xs text-blue-500 flex items-center gap-1 flex-shrink-0">
                  <RefreshCw className="w-3 h-3 animate-spin" />
                  Refreshing
                </span>
              ) : lastUpdated ? (
                <span
                  className="text-xs text-gray-500 flex items-center gap-1 flex-shrink-0"
                  title={`Last updated: ${new Date(lastUpdated).toLocaleString()}`}
                >
                  <Clock className="w-3 h-3" />
                  {new Date(lastUpdated).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                </span>
              ) : null}
            </div>

            <div className="col-span-4 flex items-center justify-end gap-2">
              {dashboardActions && (
                <div className="flex items-center">
                  <button
                    onClick={dashboardActions.onRefresh}
                    disabled={dashboardActions.refreshing || backgroundSyncRunning}
                    className={`p-1.5 rounded-l-lg border border-r-0 border-gray-300 transition-colors ${
                      dashboardActions.refreshing || backgroundSyncRunning
                        ? 'opacity-40 cursor-not-allowed'
                        : 'hover:bg-gray-100'
                    }`}
                    title="Sync dashboard tickets"
                  >
                    <RefreshCw className="w-4 h-4" />
                  </button>
                  <button
                    onClick={dashboardActions.onSyncWeek}
                    disabled={dashboardActions.refreshing || backgroundSyncRunning}
                    className={`p-1.5 rounded-r-lg border border-gray-300 transition-colors ${
                      dashboardActions.refreshing || backgroundSyncRunning
                        ? 'opacity-40 cursor-not-allowed'
                        : 'hover:bg-blue-50 hover:border-blue-300'
                    }`}
                    title="Sync week (full detail sync for current week)"
                  >
                    <Calendar className="w-4 h-4" />
                  </button>
                </div>
              )}

              {extraActions}

              {renderPrimaryNav(false)}

              <button
                onClick={() => navigate('/visuals')}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                title="Visuals"
              >
                <Map className="w-6 h-6" />
              </button>

              <button
                onClick={() => navigate('/settings')}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                title="Settings"
              >
                <Settings className="w-6 h-6" />
              </button>

              <button
                onClick={handleLogout}
                className="h-9 w-9 rounded-full border border-slate-200 bg-slate-100 text-slate-700 text-xs font-bold hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-colors"
                title={`Sign out ${displayUserName}`}
              >
                {userInitials}
              </button>
            </div>
          </div>
        </div>
      </header>
      <ChangelogModal isOpen={showChangelog} onClose={() => setShowChangelog(false)} />
    </>
  );
}
