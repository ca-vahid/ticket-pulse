import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronsRight, Settings } from 'lucide-react';
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
// PEEK MODE (/tickets*): those pages already carry their own left filter rail,
// so a second 58px icon bar read as double chrome. There the rail collapses to
// a 14px edge tab (chevron hint, `.tp-side-rail--peek`) and only expands to
// the full labeled rail on hover/keyboard focus; the pages reserve just
// `md:pl-[14px]`, giving the ticket table the width back.
export default function SideRail() {
  const navigate = useNavigate();
  const location = useLocation();
  const approvalCount = useApprovalCount();

  const matchPath = (path) => location.pathname === path || location.pathname.startsWith(`${path}/`);
  const activeId = NAV_DESTINATIONS.find((dest) => matchPath(dest.path))?.id
    || (matchPath('/settings') ? 'settings' : null);
  const destinations = useNavDestinations(activeId);
  const peek = matchPath('/tickets');

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
      className={cn(
        'tp-side-rail fixed inset-y-0 left-0 z-50 hidden flex-col gap-1 overflow-hidden border-r border-slate-200/80 bg-white/90 py-3 shadow-subtle backdrop-blur-md transition-[width] duration-200 ease-out hover:w-[210px] focus-within:w-[210px] motion-reduce:transition-none md:flex print:hidden',
        peek ? 'tp-side-rail--peek w-[14px]' : 'w-[58px]',
      )}
    >
      {peek && (
        <span
          aria-hidden="true"
          className="tp-rail-peek-hint pointer-events-none absolute inset-y-0 left-0 flex w-[14px] items-center justify-center text-slate-400"
        >
          <ChevronsRight className="h-3.5 w-3.5" />
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
      </div>
    </nav>
  );
}
