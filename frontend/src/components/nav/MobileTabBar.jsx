import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ChevronRight,
  LogOut,
  MoreHorizontal,
  Settings,
  UserCircle2,
  X,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { scrubFreeText as scrubDemoText, useDemoMode } from '../../utils/demoMode';
import { cn } from '../../lib/utils';
import { NAV_DESTINATIONS, useNavDestinations } from './navDestinations';

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
  const { currentWorkspace, availableWorkspaces, switchWorkspace } = useWorkspace();
  const demoMode = useDemoMode();
  const [moreOpen, setMoreOpen] = useState(false);

  const matchPath = (path) => location.pathname === path || location.pathname.startsWith(`${path}/`);
  const activeId = NAV_DESTINATIONS.find((dest) => matchPath(dest.path))?.id || null;
  const destinations = useNavDestinations(activeId);
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
        <Icon className={cn('h-[22px] w-[22px]', isActive ? accentText : 'text-slate-500')} />
        <span className={cn('text-[10px] font-semibold leading-none', isActive ? accentText : 'text-slate-500')}>
          {SHORT_LABEL[dest.id] || dest.label}
        </span>
      </button>
    );
  };

  return (
    <>
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-white/70 tp-glass-strong shadow-soft pb-[env(safe-area-inset-bottom)] md:hidden">
        <div className="mx-auto flex max-w-lg items-stretch">
          {primaryTabs.map(renderTab)}
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            className="relative flex min-h-[48px] flex-1 flex-col items-center justify-center gap-0.5 py-1.5 tp-focus-ring"
          >
            {moreActive && <span className="absolute top-0 h-0.5 w-8 rounded-full bg-slate-600" />}
            <MoreHorizontal className={cn('h-[22px] w-[22px]', moreActive ? 'text-slate-700' : 'text-slate-500')} />
            <span className={cn('text-[10px] font-semibold leading-none', moreActive ? 'text-slate-700' : 'text-slate-500')}>
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
            className="absolute inset-0 bg-slate-900/40 animate-in fade-in-0 motion-reduce:animate-none"
          />
          <div className="absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] shadow-soft animate-in slide-in-from-bottom-4 fade-in-0 duration-200 motion-reduce:animate-none">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <span className="text-sm font-bold text-slate-900">Go to…</span>
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                aria-label="Close"
                className="rounded-full p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
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
                    className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    <span className={cn('inline-flex h-9 w-9 items-center justify-center rounded-xl border', dest.tile)}>
                      <Icon className="h-[20px] w-[20px]" />
                    </span>
                    <span className="flex-1">{dest.label}</span>
                    <ChevronRight className="h-4 w-4 text-slate-300" />
                  </button>
                );
              })}

              <button
                type="button"
                onClick={() => go('/settings')}
                className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500">
                  <Settings className="h-[20px] w-[20px]" />
                </span>
                <span className="flex-1">Settings</span>
                <ChevronRight className="h-4 w-4 text-slate-300" />
              </button>

              <button
                type="button"
                onClick={() => go('/my-competencies')}
                className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500">
                  <UserCircle2 className="h-[20px] w-[20px]" />
                </span>
                <span className="flex-1">My Skills</span>
                <ChevronRight className="h-4 w-4 text-slate-300" />
              </button>

              {availableWorkspaces?.length > 1 && (
                <div className="px-4 py-3">
                  <label className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-400">Workspace</label>
                  <select
                    value={currentWorkspace?.id || ''}
                    onChange={(event) => {
                      const newId = Number(event.target.value);
                      if (newId === currentWorkspace?.id) return;
                      switchWorkspace(newId);
                      window.location.reload();
                    }}
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700"
                  >
                    {availableWorkspaces.map((ws) => (
                      <option key={ws.id} value={ws.id}>
                        {demoMode ? scrubDemoText(ws.name) : ws.name}{ws.role ? ` [${ws.role}]` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="my-1 border-t border-slate-100" />

              <button
                type="button"
                onClick={handleSignOut}
                className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-semibold text-red-600 hover:bg-red-50"
              >
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-red-100 bg-red-50 text-red-500">
                  <LogOut className="h-[20px] w-[20px]" />
                </span>
                <span className="flex-1">Sign out</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
