import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Settings } from 'lucide-react';
import { cn } from '../../lib/utils';
import { NAV_DESTINATIONS, homePathFor, useCanAccessSettings, useNavDestinations, useWorkspaceRole } from './navDestinations';
import { useApprovalCount } from '../../hooks/useApprovalCount';
import { useAuth } from '../../contexts/AuthContext';

// Fixed left navigation rail for desktop (hidden below md — phones use
// MobileTabBar). Collapsed it's a 58px icon strip; the round notch on its
// right border expands it over the content (no reflow) to reveal labels,
// Freshservice-style. It never opens on hover (16 Sep 2026 — brushing the
// left edge kept flaring it open); Escape, a click elsewhere or navigating
// closes it again. On tickets pages the thin-edge collapse lives at the rail
// foot, above Settings (two circles side by side looked bad — 16 Sep 2026).
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
  const { user } = useAuth();
  const wsRole = useWorkspaceRole();
  // Settings is workspace-admin only (v3.7.02 role lockdown; agents never had
  // sections) — hide the entry entirely rather than bouncing into the
  // "No settings available" card.
  const showSettings = useCanAccessSettings();
  const homePath = homePathFor(user, wsRole);

  const matchPath = (path) => location.pathname === path || location.pathname.startsWith(`${path}/`);
  const activeId = NAV_DESTINATIONS.find((dest) => matchPath(dest.path))?.id
    || (matchPath('/settings') ? 'settings' : null);
  const destinations = useNavDestinations();
  const onTickets = matchPath('/tickets');
  const [railCollapsed, setRailCollapsed] = useState(() => {
    try { return localStorage.getItem(RAIL_COLLAPSED_KEY) === 'true'; } catch { return false; }
  });
  const setCollapsed = (next) => {
    setRailCollapsed(next);
    try { localStorage.setItem(RAIL_COLLAPSED_KEY, String(next)); } catch { /* no-op */ }
  };
  const peek = onTickets && railCollapsed;

  // Explicit expand (the FreshService chevron). Session-only, never persisted.
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setExpanded(false); }, [location.pathname]);
  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setExpanded(false); };
    const onDoc = (e) => { if (!e.target.closest?.('.tp-side-rail, .tp-rail-notch')) setExpanded(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDoc);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDoc); };
  }, [expanded]);

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
            : 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        <span className="relative inline-flex h-5 w-5 flex-none items-center justify-center">
          <Icon className="h-5 w-5" />
          {dest.badgeKey === 'approvals' && approvalCount > 0 && (
            <span className="absolute -top-1.5 -right-1.5 inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-red-600 px-0.5 text-[8.5px] font-bold text-white shadow-sm ring-1 ring-card">
              {approvalCount > 99 ? '99+' : approvalCount}
            </span>
          )}
        </span>
        <span className="tp-rail-label flex-1 truncate">{dest.label}</span>
      </button>
    );
  };

  const settingsActive = activeId === 'settings';

  // Current rail width (px) drives where the notch sits; the actions the notch
  // offers depend on the state: thin edge → icons; icons → labels (+ thin edge
  // on tickets pages); labels → icons; a temporarily pinned peek → close it.
  const railWidth = peek ? (peekPinned ? 210 : 20) : (expanded ? 210 : 58);
  const notchActions = peek
    ? (peekPinned
      ? [{ key: 'close', label: 'Collapse navigation', Icon: ChevronLeft, expanded: true, run: () => setPeekPinned(false) }]
      : [{ key: 'icons', label: 'Show navigation', Icon: ChevronRight, expanded: false, run: () => { setPeekPinned(false); setCollapsed(false); } }])
    : expanded
      ? [{ key: 'collapse', label: 'Collapse navigation', Icon: ChevronLeft, expanded: true, run: () => setExpanded(false) }]
      : [{ key: 'expand', label: 'Expand navigation', Icon: ChevronRight, expanded: false, run: () => setExpanded(true) }];

  return (
    <>
      <nav
        aria-label="Primary navigation"
        onClick={peek && !peekPinned ? () => setPeekPinned(true) : undefined}
        onMouseLeave={peekPinned ? () => setPeekPinned(false) : undefined}
        className={cn(
          'tp-side-rail fixed inset-y-0 left-0 z-50 hidden flex-col gap-1 overflow-hidden border-r border-border/80 bg-card/90 py-3 shadow-subtle backdrop-blur-md transition-[width] duration-300 ease-soft motion-off:transition-none md:flex print:hidden',
          peek
            ? cn('tp-side-rail--peek', peekPinned ? 'tp-side-rail--peek-open w-[210px]' : 'w-[20px] cursor-pointer')
            : (expanded ? 'tp-side-rail--open w-[210px]' : 'w-[58px]'),
        )}
      >
        {peek && (
          <span
            aria-hidden="true"
            className="tp-rail-peek-hint pointer-events-none absolute inset-y-0 left-0 flex w-[20px] items-center justify-center rounded-r-md text-muted-foreground"
          >
            <ChevronsRight className="h-4 w-4" />
          </span>
        )}

        <div className="tp-rail-content flex min-h-0 flex-1 flex-col gap-1">
          <button
            type="button"
            onClick={() => navigate(homePath)}
            title={homePath === '/dashboard' ? 'Ticket Pulse — Dashboard' : 'Ticket Pulse — Tickets'}
            className="mx-[9px] mb-2 flex h-10 flex-none items-center gap-2.5 overflow-hidden whitespace-nowrap rounded-xl px-[4px] text-left tp-focus-ring"
          >
            <img src="/brand/logo-mark.png" alt="Ticket Pulse" className="h-8 w-8 flex-none object-contain" />
            <span className="tp-rail-label text-[15px] font-extrabold tracking-tight text-foreground">ticket pulse</span>
          </button>

          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {destinations.map(renderRow)}
          </div>

          {/* Tickets pages only: tuck the rail into a thin edge out of the way of
              the filter rail (persisted). Sits above Settings. */}
          {onTickets && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setPeekPinned(false); setExpanded(false); setCollapsed(!railCollapsed); }}
              title={railCollapsed ? 'Keep the navigation expanded' : 'Collapse the navigation to a thin edge'}
              className="mx-[9px] mt-1 flex h-9 flex-none items-center gap-3 overflow-hidden whitespace-nowrap rounded-xl border border-transparent px-[8px] text-left text-[12px] font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground tp-focus-ring"
            >
              <span className="inline-flex h-5 w-5 flex-none items-center justify-center">
                {railCollapsed ? <ChevronsRight className="h-[18px] w-[18px]" /> : <ChevronsLeft className="h-[18px] w-[18px]" />}
              </span>
              <span className="tp-rail-label flex-1 truncate">{railCollapsed ? 'Keep expanded' : 'Collapse rail'}</span>
            </button>
          )}

          {showSettings && (
            <button
              type="button"
              onClick={() => { if (!settingsActive) navigate('/settings'); }}
              aria-current={settingsActive ? 'page' : undefined}
              title="Settings"
              className={cn(
                'mx-[9px] mt-1 flex h-10 flex-none items-center gap-3 overflow-hidden whitespace-nowrap rounded-xl border px-[8px] text-left text-[12.5px] font-semibold transition-colors tp-focus-ring',
                settingsActive
                  ? 'border-input bg-muted text-foreground cursor-default'
                  : 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <span className="inline-flex h-5 w-5 flex-none items-center justify-center">
                <Settings className="h-5 w-5" />
              </span>
              <span className="tp-rail-label flex-1 truncate">Settings</span>
            </button>
          )}
        </div>
      </nav>

      {/* The notch (16 Sep 2026): a round button riding the rail's right border,
          FreshService-style. One circle when there is one thing to do, two
          stacked when the tickets pages also offer the thin edge. Fixed and
          OUTSIDE the nav (which clips its overflow), so it follows the width. */}
      <div
        className="tp-rail-notch fixed top-[66px] z-[51] hidden flex-col items-center gap-1.5 transition-[left] duration-300 ease-soft motion-off:transition-none md:flex print:hidden"
        style={{ left: `${railWidth - 14}px` }}
        data-testid="rail-notch"
      >
        {notchActions.map((a) => (
          <button
            key={a.key}
            type="button"
            onClick={(e) => { e.stopPropagation(); a.run(); }}
            aria-label={a.label}
            title={a.label}
            aria-expanded={a.expanded}
            className="tp-focus-ring group/notch inline-flex h-7 w-7 items-center justify-center rounded-full border border-border bg-card text-foreground/80 shadow-subtle transition-all duration-150 ease-out hover:scale-110 hover:border-blue-600 hover:bg-blue-600 hover:text-white dark:hover:border-blue-500 dark:hover:bg-blue-500"
          >
            <a.Icon className="h-4 w-4 transition-transform duration-150 group-hover/notch:translate-x-px" aria-hidden="true" />
          </button>
        ))}
      </div>
    </>
  );
}
