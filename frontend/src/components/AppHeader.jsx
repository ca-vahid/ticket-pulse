import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Award,
  Boxes,
  Calendar,
  Check,
  ChevronDown,
  LogOut,
  RefreshCw,
  Settings,
  Sparkles,
  Wifi,
  WifiOff,
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
import { NAV_DESTINATIONS, NAV_ACTIVE_TILE, useNavDestinations } from './nav/navDestinations';
import { useApprovalCount } from '../hooks/useApprovalCount';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui';
import { cn } from '../lib/utils';
import ChangelogModal from './ChangelogModal';

// Desktop top bar. Primary navigation is the row of accent-tinted icon tiles
// (the original pre-side-rail design, restored on request): workspace, page
// title, then the destination tiles, page actions, one consolidated status
// pill, and the account menu. On phones the bar disappears entirely — the
// bottom MobileTabBar is the chrome — except for a slim inline row when a
// page passes extraActions (or a background sync needs a stop affordance).
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
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);

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
  const canManageWorkspace = wsRole === 'admin';
  const showAdminSummitLink = canManageWorkspace && (Number(currentWorkspace?.id) === 1 || currentWorkspace?.slug === 'it');

  // One outside-click/Escape closer for all three header popups.
  const anyPopupOpen = userMenuOpen || workspaceMenuOpen || statusOpen;
  useEffect(() => {
    if (!anyPopupOpen) return undefined;

    const closeAll = () => {
      setUserMenuOpen(false);
      setWorkspaceMenuOpen(false);
      setStatusOpen(false);
    };
    const handlePointerDown = (event) => {
      if (!event.target.closest('[data-tp-header-popup]')) closeAll();
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') closeAll();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [anyPopupOpen]);

  const handleLogout = async () => {
    clearCacheOnLogout?.();
    await logout();
    navigate('/login');
  };

  const navigateFromMenu = (path) => {
    setUserMenuOpen(false);
    navigate(path);
  };

  const navDestinations = useNavDestinations(activePage);
  const approvalCount = useApprovalCount();

  // One destination tile in the desktop nav row. Inactive = accent-tinted with
  // a lift+glow hover; active = greyed glyph + a 2px "you are here" bar.
  const renderNavTile = (dest) => {
    const isActive = activePage === dest.id;
    const { Icon } = dest;
    return (
      <Tooltip key={dest.id}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => { if (!isActive) navigate(dest.path); }}
            aria-current={isActive ? 'page' : undefined}
            aria-disabled={isActive ? 'true' : undefined}
            aria-label={dest.label}
            className={cn(
              'relative inline-flex h-10 w-10 flex-none touch-manipulation items-center justify-center rounded-xl border transition-all duration-200 ease-out tp-focus-ring',
              isActive
                ? `${NAV_ACTIVE_TILE} cursor-default`
                : `${dest.tile} ${dest.hover} hover:-translate-y-0.5 hover:shadow-soft motion-reduce:transition-none motion-reduce:hover:translate-y-0`,
            )}
          >
            <Icon className="h-[22px] w-[22px]" />
            {isActive && (
              <span className={cn('absolute bottom-[5px] left-1/2 h-0.5 w-4 -translate-x-1/2 rounded-full', dest.bar)} />
            )}
            {dest.badgeKey === 'approvals' && approvalCount > 0 && (
              <span className="absolute -top-1 -right-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold shadow-sm ring-2 ring-white">
                {approvalCount > 99 ? '99+' : approvalCount}
              </span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>{dest.label}</TooltipContent>
      </Tooltip>
    );
  };

  // Neutral utility tile (Settings) — same shape/hover as the row, no accent.
  const renderSettingsTile = () => (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => navigate('/settings')}
          aria-label="Settings"
          className="relative inline-flex h-10 w-10 flex-none touch-manipulation items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition-all duration-200 ease-out tp-focus-ring hover:-translate-y-0.5 hover:bg-slate-50 hover:text-slate-700 hover:shadow-soft motion-reduce:transition-none motion-reduce:hover:translate-y-0"
        >
          <Settings className="h-[22px] w-[22px]" />
        </button>
      </TooltipTrigger>
      <TooltipContent>Settings</TooltipContent>
    </Tooltip>
  );

  const renderNavRail = () => (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-none items-center gap-2">
        <div
          className="flex items-center gap-1 rounded-2xl border border-slate-200/70 bg-white/60 p-1 shadow-subtle"
          aria-label="Primary navigation"
        >
          {navDestinations.map(renderNavTile)}
        </div>
        <div className="h-6 w-px bg-slate-200" />
        {renderSettingsTile()}
      </div>
    </TooltipProvider>
  );

  const pageTitle = activePage === 'settings'
    ? 'Settings'
    : NAV_DESTINATIONS.find((d) => d.id === activePage)?.label
      || (activePage ? activePage.charAt(0).toUpperCase() + activePage.slice(1) : '');

  const workspaceName = currentWorkspace
    ? (demoMode ? scrubDemoText(currentWorkspace.name) : currentWorkspace.name)
    : '';

  const renderWorkspaceControl = () => {
    if (!currentWorkspace) return null;
    const multi = availableWorkspaces.length > 1;

    const pillInner = (
      <>
        <span className="truncate">{workspaceName}</span>
        {wsRole && (
          <span className="flex-none rounded bg-blue-100 px-1 py-px text-[9px] font-bold uppercase tracking-wide">
            {wsRole}
          </span>
        )}
        {multi && <ChevronDown className={`h-3.5 w-3.5 flex-none text-blue-500 transition-transform ${workspaceMenuOpen ? 'rotate-180' : ''}`} />}
      </>
    );

    if (!multi) {
      return (
        <span className="inline-flex min-w-0 max-w-[15rem] items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700">
          {pillInner}
        </span>
      );
    }

    return (
      <div className="relative flex-shrink-0" data-tp-header-popup>
        <button
          type="button"
          onClick={() => { setWorkspaceMenuOpen((o) => !o); setUserMenuOpen(false); setStatusOpen(false); }}
          aria-haspopup="menu"
          aria-expanded={workspaceMenuOpen}
          title="Switch workspace"
          className="inline-flex min-w-0 max-w-[15rem] items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700 transition-colors hover:bg-blue-100 tp-focus-ring"
        >
          {pillInner}
        </button>
        {workspaceMenuOpen && (
          <div
            role="menu"
            className="absolute left-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-xl shadow-slate-900/10"
          >
            <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">Workspace</p>
            {availableWorkspaces.map((ws) => {
              const isCurrent = ws.id === currentWorkspace.id;
              return (
                <button
                  key={ws.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setWorkspaceMenuOpen(false);
                    if (isCurrent) return;
                    switchWorkspace(ws.id);
                    window.location.reload();
                  }}
                  aria-current={isCurrent ? 'true' : undefined}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-slate-50 ${isCurrent ? 'font-semibold text-slate-900' : 'text-slate-700'}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{demoMode ? scrubDemoText(ws.name) : ws.name}</span>
                    {ws.role && <span className="block text-[10px] uppercase tracking-wide text-slate-400">{ws.role}</span>}
                  </span>
                  {isCurrent && <Check className="h-3.5 w-3.5 flex-none text-blue-600" />}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  // ---- consolidated status pill -------------------------------------------
  const syncing = backgroundSyncRunning || (isRefreshing && !isColdLoading);
  const progressMatch = backgroundSyncStep && backgroundSyncStep.match(/(\d+)\s*\/\s*(\d+)/);
  const syncPct = progressMatch
    ? Math.min(100, Math.max(0, (parseInt(progressMatch[1], 10) / Math.max(1, parseInt(progressMatch[2], 10))) * 100))
    : null;

  const statusTone = sseConnectionStatus === 'connected'
    ? (syncing ? 'sync' : 'live')
    : sseConnectionStatus === 'connecting' ? 'connecting' : 'offline';

  const STATUS_PILL = {
    live: 'border-emerald-200 bg-emerald-50/80 text-emerald-700 hover:bg-emerald-100/80',
    sync: 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100',
    connecting: 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100',
    offline: 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100',
  };

  const timeLabel = lastUpdated
    ? new Date(lastUpdated).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : null;

  const renderStatusPill = () => (
    <div className="relative flex-shrink-0" data-tp-header-popup>
      <button
        type="button"
        onClick={() => { setStatusOpen((o) => !o); setUserMenuOpen(false); setWorkspaceMenuOpen(false); }}
        aria-haspopup="dialog"
        aria-expanded={statusOpen}
        title="Data status & sync"
        className={`inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors tp-focus-ring ${STATUS_PILL[statusTone]}`}
      >
        {statusTone === 'sync' ? (
          <span className="relative flex h-4 w-4 items-center justify-center">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            {syncPct !== null && (
              <svg className="absolute inset-0 h-4 w-4 -rotate-90" viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="10" cy="10" r="8" fill="none" stroke="#bfdbfe" strokeWidth="2.5" />
                <circle
                  cx="10" cy="10" r="8" fill="none"
                  stroke="#2563eb" strokeWidth="2.5"
                  strokeDasharray={`${(syncPct / 100) * 2 * Math.PI * 8} ${2 * Math.PI * 8}`}
                  strokeLinecap="round"
                />
              </svg>
            )}
          </span>
        ) : statusTone === 'offline' ? (
          <WifiOff className="h-3.5 w-3.5" />
        ) : (
          <span className={`h-2 w-2 rounded-full ${statusTone === 'live' ? 'bg-emerald-500 shadow-[0_0_0_3px_rgb(16_185_129/0.18)]' : 'bg-amber-400 animate-pulse'}`} />
        )}
        <span>
          {statusTone === 'sync' ? 'Syncing' : statusTone === 'live' ? 'Live' : statusTone === 'connecting' ? 'Connecting' : 'Offline'}
        </span>
        {timeLabel && statusTone !== 'offline' && (
          <span className="hidden font-medium opacity-70 lg:inline">· {timeLabel}</span>
        )}
      </button>

      {statusOpen && (
        <div className="absolute right-0 top-full z-50 mt-2 w-72 rounded-lg border border-slate-200 bg-white p-3.5 text-xs text-slate-700 shadow-xl shadow-slate-900/10">
          <div className="flex items-center justify-between py-1">
            <span className="text-slate-400">Realtime feed</span>
            <span className={`inline-flex items-center gap-1.5 font-semibold ${
              sseConnectionStatus === 'connected' ? 'text-emerald-600' : sseConnectionStatus === 'connecting' ? 'text-amber-600' : 'text-red-600'
            }`}>
              {sseConnectionStatus === 'connected' ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
              {sseConnectionStatus === 'connected' ? 'Connected' : sseConnectionStatus === 'connecting' ? 'Connecting…' : 'Disconnected'}
            </span>
          </div>
          <div className="flex items-center justify-between py-1">
            <span className="text-slate-400">Last updated</span>
            <span className="font-medium">{lastUpdated ? new Date(lastUpdated).toLocaleString() : '—'}</span>
          </div>
          <div className="flex items-center justify-between gap-3 py-1">
            <span className="flex-none text-slate-400">Background sync</span>
            {backgroundSyncRunning ? (
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium text-blue-700">{backgroundSyncStep || 'Running…'}</span>
                <button
                  type="button"
                  onClick={onKillSync}
                  disabled={killingSync || !onKillSync}
                  className="flex-none rounded border border-red-200 bg-red-50 px-1.5 py-0.5 font-semibold text-red-600 hover:bg-red-100 disabled:opacity-50"
                >
                  Stop
                </button>
              </span>
            ) : (
              <span className="font-medium text-slate-500">Idle</span>
            )}
          </div>

          {dashboardActions && (
            <div className="mt-2 flex gap-2 border-t border-slate-100 pt-2.5">
              <button
                type="button"
                onClick={() => { setStatusOpen(false); dashboardActions.onRefresh(); }}
                disabled={dashboardActions.refreshing || backgroundSyncRunning}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2 py-1.5 font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Sync now
              </button>
              <button
                type="button"
                onClick={() => { setStatusOpen(false); dashboardActions.onSyncWeek(); }}
                disabled={dashboardActions.refreshing || backgroundSyncRunning}
                title="Full detail sync for the current week"
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2 py-1.5 font-semibold text-slate-700 transition-colors hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Calendar className="h-3.5 w-3.5" /> Full week
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );

  // ---- account menu ---------------------------------------------------------
  const renderUserMenu = () => {
    const menuItems = [
      ...(showAdminSummitLink ? [{
        id: 'summit',
        label: 'Summit',
        description: 'Category workshop',
        path: '/summit-taxonomy',
        Icon: Boxes,
      }] : []),
      {
        id: 'my-skills',
        label: 'My Skills',
        description: 'My competencies',
        path: '/my-competencies',
        Icon: Award,
      },
      ...(canManageWorkspace ? [{
        id: 'skill-matrix',
        label: 'Skill Matrix',
        description: 'Admin competency matrix',
        path: '/assignments/competencies',
        Icon: Award,
      }] : []),
    ];

    return (
      <div className="relative flex-shrink-0" data-tp-header-popup>
        <button
          type="button"
          onClick={() => { setUserMenuOpen((open) => !open); setWorkspaceMenuOpen(false); setStatusOpen(false); }}
          aria-haspopup="menu"
          aria-expanded={userMenuOpen}
          className="inline-flex h-9 items-center gap-1 rounded-full border border-slate-200 bg-slate-100 pl-2.5 pr-2 text-xs font-bold text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-200 touch-manipulation tp-focus-ring"
          title={displayUserName}
        >
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-white text-slate-700 shadow-sm">
            {userInitials}
          </span>
          <ChevronDown className={`h-4 w-4 text-slate-500 transition-transform ${userMenuOpen ? 'rotate-180' : ''}`} />
        </button>

        {userMenuOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full z-50 mt-2 w-60 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-xl shadow-slate-900/10"
          >
            <div className="border-b border-slate-100 px-3 py-2">
              <p className="truncate text-sm font-semibold text-slate-900">{displayUserName}</p>
              <p className="truncate text-xs text-slate-500">{user?.email || user?.username || wsRole}</p>
            </div>

            {menuItems.map(({ id, label, description, path, Icon }) => (
              <button
                key={id}
                type="button"
                role="menuitem"
                onClick={() => navigateFromMenu(path)}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
              >
                <Icon className="h-4 w-4 text-slate-500" />
                <span className="min-w-0">
                  <span className="block font-semibold">{label}</span>
                  <span className="block truncate text-xs text-slate-500">{description}</span>
                </span>
              </button>
            ))}

            <button
              type="button"
              role="menuitem"
              onClick={() => navigateFromMenu('/settings')}
              className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
            >
              <Settings className="h-4 w-4 text-slate-500" />
              <span className="font-semibold">Settings</span>
            </button>

            <button
              type="button"
              role="menuitem"
              onClick={() => { setUserMenuOpen(false); setShowChangelog(true); }}
              className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
            >
              <Sparkles className="h-4 w-4 text-slate-500" />
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">What&rsquo;s new</span>
                <span className="block truncate text-xs text-slate-500">Changelog</span>
              </span>
              <span className="flex-none rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-600">
                v{APP_VERSION}
              </span>
            </button>

            <div className="my-1 border-t border-slate-100" />

            <button
              type="button"
              role="menuitem"
              onClick={handleLogout}
              className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm font-semibold text-red-600 hover:bg-red-50"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {/* Desktop bar — phones get no top chrome (MobileTabBar is the nav). */}
      <header className="sticky top-0 z-40 hidden border-b border-gray-200 bg-white shadow-sm md:block">
        <div className="flex items-center gap-3 px-4 py-2 lg:px-6">
          <div className="flex min-w-0 items-center gap-3">
            {renderWorkspaceControl()}
            <button
              type="button"
              onClick={() => setShowChangelog(true)}
              title="What's new — view changelog"
              className="flex-none rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-600 transition-colors hover:bg-blue-100 tp-focus-ring"
            >
              v{APP_VERSION}
            </button>
            {pageTitle && (
              <h1 className="hidden truncate text-sm font-bold tracking-tight text-slate-900 xl:block">{pageTitle}</h1>
            )}
          </div>

          <div className="min-w-0 flex-1" />

          {renderNavRail()}
          {extraActions && <div className="flex min-w-0 items-center gap-2">{extraActions}</div>}
          {renderStatusPill()}
          {renderUserMenu()}
        </div>
      </header>

      {/* Mobile: page-specific actions only, inline (non-sticky) so content
          keeps the room the old header bar occupied. */}
      {(extraActions || backgroundSyncRunning) && (
        <div className="md:hidden">
          <div className="flex min-w-0 touch-pan-x items-center gap-1.5 overflow-x-auto px-3 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {extraActions}
            {backgroundSyncRunning && (
              <button
                onClick={onKillSync}
                disabled={killingSync || !onKillSync}
                className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-blue-200 bg-blue-50 text-blue-700 touch-manipulation disabled:opacity-50"
                title={backgroundSyncStep ? `Syncing: ${backgroundSyncStep} (tap to stop)` : 'Syncing... (tap to stop)'}
              >
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              </button>
            )}
          </div>
        </div>
      )}

      <ChangelogModal isOpen={showChangelog} onClose={() => setShowChangelog(false)} />
    </>
  );
}
