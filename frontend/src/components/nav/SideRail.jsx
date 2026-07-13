import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronsLeft, ChevronsRight, Settings } from 'lucide-react';
import { cn } from '../../lib/utils';
import { NAV_DESTINATIONS, useNavDestinations } from './navDestinations';
import { useApprovalCount } from '../../hooks/useApprovalCount';

// Fixed left navigation rail for desktop (hidden below md — phones use
// MobileTabBar). Collapsed it's a 58px icon strip; on hover/keyboard focus it
// expands over the content (no reflow) to reveal labels, Freshservice-style.
// Like MobileTabBar it self-detects the active route via useLocation, so it
// works on every page it's mounted on, including the bespoke Visuals chrome
// that bypasses AppShell/AppHeader.
//
// Page hue survives as *state* here: the active row tints in its destination's
// accent; everything at rest stays quiet slate. Chrome roots that host the
// rail reserve its width with `md:pl-[58px]`.
//
// TICKETS PAGES (/tickets*): these carry their own left filter rail, so the
// nav rail is COLLAPSIBLE there (QA 07-13 #6 — the always-thin peek edge was
// too hard to hit, so full icons are now the default). A chevron at the rail
// foot shrinks it to a 20px edge tab (`.tp-side-rail--peek`: hover or click
// expands it temporarily); the choice persists per user. The pages reserve
// the right gutter via the `--tp-rail-w` CSS variable this component owns.
const RAIL_COLLAPSED_KEY = 'tp_ticketsRailCollapsed';

export default function SideRail() {
  const navigate = useNavigate();
  const location = useLocation();
  const approvalCount = useApprovalCount();

  const matchPath = (path) => location.pathname === path || location.pathname.startsWith(`${path}/`);
  const activeId = NAV_DESTINATIONS.find((dest) => matchPath(dest.path))?.id
    || (matchPath('/settings') ? 'settings' : null);
  const destinations = useNavDestinations(activeId);
  const onTickets = matchPath('/tickets');
  const [railCollapsed, setRailCollapsed] = useState(() => {
    try { return localStorage.getItem(RAIL_COLLAPSED_KEY) === 'true'; } catch { return false; }
  });
  const setCollapsed = (next) => {
    setRailCollapsed(next);
    try { localStorage.setItem(RAIL_COLLAPSED_KEY, String(next)); } catch { /* no-op */ }
  };
  const peek = onTickets && railCollapsed;

  // Tickets pages reserve the rail gutter via --tp-rail-w so collapsing the
  // rail gives the table the width back without hardcoded paddings.
  useEffect(() => {
    const root = document.documentElement;
    if (onTickets) root.style.setProperty('--tp-rail-w', peek ? '20px' : '58px');
    else root.style.removeProperty('--tp-rail-w');
    return () => root.style.removeProperty('--tp-rail-w');
  }, [onTickets, peek]);

  // Click-to-open for the collapsed edge tab (QA 07-10 #5). Clicking pins the
  // rail open; navigating, Escape, or the mouse leaving lets it collapse.
  const [peekPinned, setPeekPinned] = useState(false);
  useEffect(() => { setPeekPinned(false); }, [location.pathname]);
  useEffect(() => {
    if (!peekPinned) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setPeekPinned(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [peekPinned]);

  const renderRow = (dest) => {
    const isActive = dest.id === activeId;
    const { Icon } = dest;
    return (
      <button
        key={dest.id}
        type="button"
        onClick={() => { if (!isActive) navigate(dest.path); }}
        aria-current={isActive ? 'page' : undefined}
        title={dest.label}
        className={cn(
          'group/row relative mx-[9px] flex h-10 flex-none items-center gap-3 overflow-hidden whitespace-nowrap rounded-xl border px-[8px] text-left text-[12.5px] font-semibold transition-colors tp-focus-ring',
          isActive
            ? `${dest.tile} cursor-default`
            : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800',
        )}
      >
        <span className="relative inline-flex h-5 w-5 flex-none items-center justify-center">
          <Icon className="h-5 w-5" />
          {dest.badgeKey === 'approvals' && approvalCount > 0 && (
            <span className="absolute -top-1.5 -right-1.5 inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-red-600 px-0.5 text-[8.5px] font-bold text-white shadow-sm ring-1 ring-white">
              {approvalCount > 99 ? '99+' : approvalCount}
            </span>
          )}
        </span>
        <span className="tp-rail-label flex-1 truncate">{dest.label}</span>
      </button>
    );
  };

  const settingsActive = activeId === 'settings';

  return (
    <nav
      aria-label="Primary navigation"
      onClick={peek && !peekPinned ? () => setPeekPinned(true) : undefined}
      onMouseLeave={peekPinned ? () => setPeekPinned(false) : undefined}
      className={cn(
        'tp-side-rail fixed inset-y-0 left-0 z-50 hidden flex-col gap-1 overflow-hidden border-r border-slate-200/80 bg-white/90 py-3 shadow-subtle backdrop-blur-md transition-[width] duration-200 ease-out hover:w-[210px] focus-within:w-[210px] motion-reduce:transition-none md:flex print:hidden',
        peek
          ? cn('tp-side-rail--peek', peekPinned ? 'tp-side-rail--peek-open w-[210px]' : 'w-[20px] cursor-pointer')
          : 'w-[58px]',
      )}
    >
      {peek && (
        <span
          aria-hidden="true"
          className="tp-rail-peek-hint pointer-events-none absolute inset-y-0 left-0 flex w-[20px] items-center justify-center rounded-r-md text-slate-500"
        >
          <ChevronsRight className="h-4 w-4" />
        </span>
      )}

      <div className="tp-rail-content flex min-h-0 flex-1 flex-col gap-1">
        <button
          type="button"
          onClick={() => navigate('/dashboard')}
          title="Ticket Pulse — Dashboard"
          className="mx-[9px] mb-2 flex h-10 flex-none items-center gap-2.5 overflow-hidden whitespace-nowrap rounded-xl px-[4px] text-left tp-focus-ring"
        >
          <img src="/brand/logo-mark.png" alt="Ticket Pulse" className="h-8 w-8 flex-none object-contain" />
          <span className="tp-rail-label text-[15px] font-extrabold tracking-tight text-slate-900">ticket pulse</span>
        </button>

        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {destinations.map(renderRow)}
        </div>

        <button
          type="button"
          onClick={() => { if (!settingsActive) navigate('/settings'); }}
          aria-current={settingsActive ? 'page' : undefined}
          title="Settings"
          className={cn(
            'mx-[9px] mt-1 flex h-10 flex-none items-center gap-3 overflow-hidden whitespace-nowrap rounded-xl border px-[8px] text-left text-[12.5px] font-semibold transition-colors tp-focus-ring',
            settingsActive
              ? 'border-slate-300 bg-slate-100 text-slate-700 cursor-default'
              : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800',
          )}
        >
          <span className="inline-flex h-5 w-5 flex-none items-center justify-center">
            <Settings className="h-5 w-5" />
          </span>
          <span className="tp-rail-label flex-1 truncate">Settings</span>
        </button>

        {/* Tickets pages only: collapse/expand the rail out of the way of the
            filter rail. The preference sticks (localStorage). */}
        {onTickets && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setPeekPinned(false); setCollapsed(!railCollapsed); }}
            title={railCollapsed ? 'Keep the navigation expanded' : 'Collapse the navigation to a thin edge'}
            className="mx-[9px] mt-1 flex h-9 flex-none items-center gap-3 overflow-hidden whitespace-nowrap rounded-xl border border-transparent px-[8px] text-left text-[12px] font-semibold text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 tp-focus-ring"
          >
            <span className="inline-flex h-5 w-5 flex-none items-center justify-center">
              {railCollapsed ? <ChevronsRight className="h-[18px] w-[18px]" /> : <ChevronsLeft className="h-[18px] w-[18px]" />}
            </span>
            <span className="tp-rail-label flex-1 truncate">{railCollapsed ? 'Keep expanded' : 'Collapse rail'}</span>
          </button>
        )}
      </div>
    </nav>
  );
}
