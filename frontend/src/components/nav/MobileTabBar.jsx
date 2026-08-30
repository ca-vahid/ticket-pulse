import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Bell,
  ChevronRight,
  LogOut,
  MoreHorizontal,
  Settings,
  Sparkles,
  UserCircle2,
  X,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useDashboard } from '../../contexts/DashboardContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { scrubFreeText as scrubDemoText, useDemoMode } from '../../utils/demoMode';
import { cn } from '../../lib/utils';
import { APP_VERSION } from '../../data/changelog';
import ChangelogModal from '../ChangelogModal';
import ThemeControl from './ThemeControl';
import { NAV_DESTINATIONS, useCanAccessSettings, useNavDestinations } from './navDestinations';

// Short labels so the fixed tabs stay legible on narrow phones.
const SHORT_LABEL = {
  dashboard: 'Dashboard',
  timeline: 'Timeline',
  analytics: 'Analytics',
  assignments: 'Assign',
  workflows: 'Workflows',
  map: 'Map',
};

// Fixed bottom navigation for phones (md:hidden). Self-detects the active route
// via useLocation so it works on every page, including the bespoke Visuals /
// Settings chrome that bypasses AppShell/AppHeader. Core destinations get tabs;
// the rest live in a "More" sheet alongside Settings, My Skills, workspace
// switch, and sign-out.
export default function MobileTabBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { logout } = useAuth();
  const showSettings = useCanAccessSettings();
  const { currentWorkspace, availableWorkspaces, switchWorkspace } = useWorkspace();
  const { lastUpdated, sseConnectionStatus } = useDashboard();
  const demoMode = useDemoMode();
  const [moreOpen, setMoreOpen] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);

  const matchPath = (path) => location.pathname === path || location.pathname.startsWith(`${path}/`);
  const activeId = NAV_DESTINATIONS.find((dest) => matchPath(dest.path))?.id || null;
  const destinations = useNavDestinations();
  const primaryTabs = destinations.slice(0, 4);
  const overflowDests = destinations.slice(4);
  const moreActive = !primaryTabs.some((dest) => dest.id === activeId);

  const go = (path) => {
    setMoreOpen(false);
    navigate(path);
  };

  const handleSignOut = async () => {
    setMoreOpen(false);
    await logout();
    navigate('/login');
  };

  const renderTab = (dest) => {
    const isActive = dest.id === activeId;
    const { Icon } = dest;
    const accentText = dest.bar.replace('bg-', 'text-');
    return (
      <button
        key={dest.id}
        type="button"
        onClick={() => go(dest.path)}
        aria-current={isActive ? 'page' : undefined}
        className="relative flex min-h-[48px] flex-1 flex-col items-center justify-center gap-0.5 py-1.5 tp-focus-ring"
      >
        {isActive && <span className={cn('absolute top-0 h-0.5 w-8 rounded-full', dest.bar)} />}
        <Icon className={cn('h-[22px] w-[22px]', isActive ? accentText : 'text-muted-foreground')} />
        <span className={cn('text-[10px] font-semibold leading-none', isActive ? accentText : 'text-muted-foreground')}>
          {SHORT_LABEL[dest.id] || dest.label}
        </span>
      </button>
    );
  };

  return (
    <>
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t tp-glass-strong shadow-soft pb-[env(safe-area-inset-bottom)] md:hidden">
        <div className="mx-auto flex max-w-lg items-stretch">
          {primaryTabs.map(renderTab)}
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            className="relative flex min-h-[48px] flex-1 flex-col items-center justify-center gap-0.5 py-1.5 tp-focus-ring"
          >
            {moreActive && <span className="absolute top-0 h-0.5 w-8 rounded-full bg-foreground/70" />}
            <MoreHorizontal className={cn('h-[22px] w-[22px]', moreActive ? 'text-foreground' : 'text-muted-foreground')} />
            <span className={cn('text-[10px] font-semibold leading-none', moreActive ? 'text-foreground' : 'text-muted-foreground')}>
              More
            </span>
          </button>
        </div>
      </nav>

      {moreOpen && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="More navigation">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setMoreOpen(false)}
            className="absolute inset-0 bg-slate-900/40 dark:bg-black/60 animate-in fade-in-0 motion-reduce:animate-none"
          />
          <div className="absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-border bg-card pb-[env(safe-area-inset-bottom)] shadow-soft animate-in slide-in-from-bottom-4 fade-in-0 duration-200 motion-reduce:animate-none">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <span className="text-sm font-bold text-foreground">Go to…</span>
              {/* Live-data status — the phone has no top bar, so this is its home. */}
              <span className="ml-auto mr-3 inline-flex items-center gap-1.5 text-[11px] font-semibold">
                <span
                  className={cn(
                    'h-2 w-2 rounded-full',
                    sseConnectionStatus === 'connected'
                      ? 'bg-emerald-500'
                      : sseConnectionStatus === 'connecting'
                        ? 'bg-amber-400 animate-pulse'
                        : 'bg-red-500',
                  )}
                />
                <span className={sseConnectionStatus === 'connected' ? 'text-emerald-600 dark:text-emerald-400' : sseConnectionStatus === 'connecting' ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}>
                  {sseConnectionStatus === 'connected' ? 'Live' : sseConnectionStatus === 'connecting' ? 'Connecting' : 'Offline'}
                </span>
                {lastUpdated && (
                  <span className="font-medium text-muted-foreground">
                    · {new Date(lastUpdated).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                aria-label="Close"
                className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto py-1">
              {overflowDests.map((dest) => {
                const { Icon } = dest;
                return (
                  <button
                    key={dest.id}
                    type="button"
                    onClick={() => go(dest.path)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-semibold text-foreground hover:bg-muted"
                  >
                    <span className={cn('inline-flex h-9 w-9 items-center justify-center rounded-xl border', dest.tile)}>
                      <Icon className="h-[20px] w-[20px]" />
                    </span>
                    <span className="flex-1">{dest.label}</span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground/60" />
                  </button>
                );
              })}

              {/* Settings is workspace-admin only (v3.7.02) — same gate as
                  the SideRail entry. */}
              {showSettings && (
                <button
                  type="button"
                  onClick={() => go('/settings')}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-semibold text-foreground hover:bg-muted"
                >
                  <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground">
                    <Settings className="h-[20px] w-[20px]" />
                  </span>
                  <span className="flex-1">Settings</span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground/60" />
                </button>
              )}

              <button
                type="button"
                onClick={() => go('/my-competencies')}
                className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-semibold text-foreground hover:bg-muted"
              >
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground">
                  <UserCircle2 className="h-[20px] w-[20px]" />
                </span>
                <span className="flex-1">My Skills</span>
                <ChevronRight className="h-4 w-4 text-muted-foreground/60" />
              </button>

              <button
                type="button"
                onClick={() => go('/notifications')}
                className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-semibold text-foreground hover:bg-muted"
              >
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground">
                  <Bell className="h-[20px] w-[20px]" />
                </span>
                <span className="flex-1">Notifications</span>
                <ChevronRight className="h-4 w-4 text-muted-foreground/60" />
              </button>

              {availableWorkspaces?.length > 1 && (
                <div className="px-4 py-3">
                  <label className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Workspace</label>
                  <select
                    value={currentWorkspace?.id || ''}
                    onChange={(event) => {
                      const newId = Number(event.target.value);
                      if (newId === currentWorkspace?.id) return;
                      switchWorkspace(newId);
                      window.location.reload();
                    }}
                    className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm font-semibold text-foreground"
                  >
                    {availableWorkspaces.map((ws) => (
                      <option key={ws.id} value={ws.id}>
                        {demoMode ? scrubDemoText(ws.name) : ws.name}{ws.role ? ` [${ws.role}]` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <button
                type="button"
                onClick={() => { setMoreOpen(false); setShowChangelog(true); }}
                className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-semibold text-foreground hover:bg-muted"
              >
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-blue-100 bg-blue-50 text-blue-600 dark:border-blue-400/30 dark:bg-blue-500/15 dark:text-blue-300">
                  <Sparkles className="h-[20px] w-[20px]" />
                </span>
                <span className="flex-1">What&rsquo;s new</span>
                <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-600 dark:border-blue-400/30 dark:bg-blue-500/15 dark:text-blue-300">v{APP_VERSION}</span>
              </button>

              <div className="my-1 border-t border-border" />

              {/* Theme (Phase DM-A): applies immediately; the sheet stays open
                  (no setMoreOpen(false)) so the user can compare. */}
              <ThemeControl itemRole="radio" className="px-4 py-2.5" />

              <div className="my-1 border-t border-border" />

              <button
                type="button"
                onClick={handleSignOut}
                className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-semibold text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
              >
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-red-100 bg-red-50 text-red-500 dark:border-red-400/30 dark:bg-red-500/10 dark:text-red-300">
                  <LogOut className="h-[20px] w-[20px]" />
                </span>
                <span className="flex-1">Sign out</span>
              </button>
            </div>
          </div>
        </div>
      )}

      <ChangelogModal isOpen={showChangelog} onClose={() => setShowChangelog(false)} />
    </>
  );
}
