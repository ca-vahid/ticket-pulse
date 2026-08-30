import { useNavigate } from 'react-router-dom';
import { EyeOff, Trophy, Star, Hand, Send, CheckSquare, Bot, RotateCcw, ChevronDown, Ticket as TicketIcon } from 'lucide-react';
import { useState, useCallback, useRef } from 'react';
import { getDateStyling, getHolidayTooltip } from '../utils/holidays';
import { getLeaveForDate, getLeaveBadge, getLeaveTooltip, getLeaveDotClass, getLeaveStyle, isHalfDayLeave, getLeaveSplit } from '../utils/leaveInfo';
import { prefetchTechDetail } from '../hooks/usePrefetch';
import ExpandableTicketList, { useGroupedTickets, getTicketsForView } from './ExpandableTicketList';
import AgentStatusPill from './AgentStatusPill';

/**
 * Build a deep-link URL to the Bounced tab with a date range matching the
 * dashboard's current view. Lets the user click "Rej N" on a tech card and
 * land on exactly the N tickets that contributed to that number.
 */
function buildBouncedUrl(techId, viewMode, selectedDate, selectedWeek, selectedMonth) {
  const base = `/technician/${techId}?tab=bounced`;
  const fmt = (d) => {
    if (!d) return null;
    const dt = typeof d === 'string' ? new Date(d) : d;
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  if (viewMode === 'weekly' && selectedWeek) {
    const wk = typeof selectedWeek === 'string' ? new Date(selectedWeek) : selectedWeek;
    const start = fmt(wk);
    const endDt = new Date(wk);
    endDt.setDate(endDt.getDate() + 6);
    return `${base}&range=week&start=${start}&end=${fmt(endDt)}`;
  }
  if (viewMode === 'monthly' && selectedMonth) {
    const m = typeof selectedMonth === 'string' ? new Date(selectedMonth) : selectedMonth;
    const start = new Date(m.getFullYear(), m.getMonth(), 1);
    const end = new Date(m.getFullYear(), m.getMonth() + 1, 0);
    return `${base}&range=month&start=${fmt(start)}&end=${fmt(end)}`;
  }
  // daily (default)
  const date = fmt(selectedDate) || fmt(new Date());
  return `${base}&range=day&start=${date}&end=${date}`;
}

// Extremely subtle card background color based on relative load level
const getCardBackgroundColor = (openCount, maxOpenCount) => {
  if (openCount === 0) {
    return 'bg-card'; // No load - pure white
  }

  // Calculate percentage relative to max
  const percentage = (openCount / maxOpenCount) * 100;

  if (percentage <= 33) {
    return 'bg-green-50/30 dark:bg-green-500/10'; // Light load - extremely subtle green tint
  }
  if (percentage <= 66) {
    return 'bg-yellow-50/40 dark:bg-yellow-500/10'; // Medium load - extremely subtle yellow tint
  }
  return 'bg-red-50/50 dark:bg-red-500/10'; // Heavy load - extremely subtle red tint
};

// Text color for the mobile "open now" number — same load semantics as the
// workload status colors (load-light <5, load-medium 5–9, load-heavy ≥10).
const getLoadTextClass = (open) => {
  if (open >= 10) return 'text-red-600 dark:text-red-300';
  if (open >= 5) return 'text-amber-700 dark:text-amber-200';
  if (open > 0) return 'text-emerald-700 dark:text-emerald-200';
  return 'text-muted-foreground/75';
};

/**
 * Mobile-only stat cell (below `sm`): tiny inline icon + number with a caption
 * under it — the phone-scale answer to the desktop icon tiles, which read
 * gigantic on a 390px card (QA 08-08). Interactive cells keep a ≥44px hit box.
 */
function MobileStat({ icon: Icon, value, label, iconClass = '', numClass = '', suffix = null, muted = false, title, onClick }) {
  const body = (
    <>
      <span className="flex items-center gap-1 leading-none">
        <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${muted ? 'text-muted-foreground/50' : iconClass}`} aria-hidden="true" />
        <span className={`text-sm font-bold ${muted ? 'text-muted-foreground/50' : numClass}`}>
          {value}
          {suffix && !muted && <span className="ml-0.5 text-[9px] font-semibold text-muted-foreground/75">{suffix}</span>}
        </span>
      </span>
      <span className={`max-w-full truncate text-[9px] font-semibold uppercase tracking-wide leading-none ${muted ? 'text-muted-foreground/50' : 'text-muted-foreground'}`}>
        {label}
      </span>
    </>
  );
  const base = 'flex min-h-[44px] min-w-0 flex-col items-center justify-center gap-1 rounded-lg';
  if (onClick) {
    // Only the Rejected cell is tappable — a faint red chip signals it
    // (tooltips being unreachable on touch).
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        className={`${base} tp-focus-ring bg-red-50/70 dark:bg-red-500/10 active:bg-red-100 dark:active:bg-red-500/20 transition-colors`}
      >
        {body}
      </button>
    );
  }
  return (
    <div className={base} title={title}>
      {body}
    </div>
  );
}

// Get initials from technician name (e.g., "Vahid Haeri" -> "VH")
const getInitials = (name) => {
  const parts = name.split(' ').filter(p => p.length > 0);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  } else if (parts.length === 1) {
    return parts[0].substring(0, 2).toUpperCase();
  }
  return '??';
};

export default function TechCard({ technician, onHide, rank, selectedDate, selectedWeek, selectedMonth, maxOpenCount = 10, maxDailyCount = 1, viewMode = 'daily', searchTerm = '', selectedCategories = [], canonicalCategoryFilter = null, simple = false, topLoad = false }) {
  const navigate = useNavigate();
  const [ticketsOpen, setTicketsOpen] = useState(false);
  const hoverTimerRef = useRef(null);

  // Inline ticket drilldown (mobile) — reuses the dashboard's grouped-ticket
  // helpers so the rows carry the correct in-app /tickets/:id links. Groups
  // are disjoint, so the period total is the sum of both.
  const { activeTickets, closedTickets } = useGroupedTickets(getTicketsForView(technician, viewMode));
  const ticketTotal = activeTickets.length + closedTickets.length;

  // Get color gradient based on normalized ticket count
  const getTicketColor = (count, maxCount) => {
    if (count === 0) return 'bg-card border-border text-muted-foreground/75';

    const percentage = (count / maxCount) * 100;

    // Good (high tickets) = Green gradient
    if (percentage >= 66) {
      return 'bg-green-500 border-green-600 text-white';
    } else if (percentage >= 33) {
      return 'bg-green-300 dark:bg-green-500/40 border-green-400 dark:border-green-500/50 text-green-900 dark:text-green-100';
    } else {
      return 'bg-green-100 dark:bg-green-500/20 border-green-200 dark:border-green-500/30 text-green-800 dark:text-green-200';
    }
  };

  const handleMouseEnter = useCallback(() => {
    hoverTimerRef.current = setTimeout(() => {
      prefetchTechDetail(technician.id, viewMode, selectedDate, selectedWeek);
    }, 150);
  }, [technician.id, viewMode, selectedDate, selectedWeek]);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }, []);

  const navigateToAgent = () => {
    navigate(`/technician/${technician.id}`, {
      state: {
        selectedDate: selectedDate,
        selectedWeek: selectedWeek,
        viewMode: viewMode,
        searchTerm: searchTerm,
        selectedCategories: selectedCategories,
        canonicalCategoryFilter,
        techSummary: {
          id: technician.id,
          name: technician.name,
          email: technician.email,
          photoUrl: technician.photoUrl,
          loadLevel: technician.loadLevel,
        },
      },
    });
  };

  // Name/avatar are explicit agent-page affordances (mirrors TechCardCompact).
  const handleAgentLinkClick = (e) => {
    e.stopPropagation();
    navigateToAgent();
  };

  const handleClick = (e) => {
    // Don't navigate if clicking the hide button
    if (e.target.closest('.hide-button')) return;

    navigateToAgent();
  };

  const handleHideToggle = (e) => {
    e.stopPropagation();
    if (onHide) onHide(technician.id);
  };

  const isTopPerformer = rank && rank <= 3;

  // Use appropriate fields based on view mode (daily | weekly | monthly)
  const totalTickets = viewMode === 'weekly'
    ? (technician.weeklyTotalCreated || 0)
    : viewMode === 'monthly'
      ? (technician.monthlyTotalCreated || 0)
      : (technician.totalTicketsToday || 0);
  const selfPicked = viewMode === 'weekly'
    ? (technician.weeklySelfPicked || 0)
    : viewMode === 'monthly'
      ? (technician.monthlySelfPicked || 0)
      : (technician.selfPickedToday || 0);
  const appAssigned = viewMode === 'weekly'
    ? (technician.weeklyAppAssigned || 0)
    : viewMode === 'monthly'
      ? (technician.monthlyAppAssigned || 0)
      : (technician.appAssignedToday || 0);
  const assigned = viewMode === 'weekly'
    ? (technician.weeklyAssigned || 0)
    : viewMode === 'monthly'
      ? (technician.monthlyAssigned || 0)
      : (technician.assignedToday || 0);
  const closed = viewMode === 'weekly'
    ? (technician.weeklyClosed || 0)
    : viewMode === 'monthly'
      ? (technician.monthlyClosed || 0)
      : (technician.closedToday || 0);

  // CSAT data
  const csatCount = viewMode === 'weekly'
    ? (technician.weeklyCSATCount || 0)
    : viewMode === 'monthly'
      ? (technician.monthlyCSATCount || 0)
      : (technician.csatCount || 0);
  const csatAverage = viewMode === 'weekly'
    ? technician.weeklyCSATAverage
    : viewMode === 'monthly'
      ? technician.monthlyCSATAverage
      : technician.csatAverage;

  const hasCSAT = csatCount > 0;

  // FreshService CSAT is 1-4; TP-native feedback is 1-5. Display everything on
  // the /5 scale (the go-forward system, QA 07-30 #5): FS average x 1.25.
  const csatOutOf5 = csatAverage != null ? Math.round(csatAverage * 1.25 * 10) / 10 : null;
  const csatTooltip = hasCSAT
    ? `CSAT average: ${csatOutOf5?.toFixed(1)}/5 (FreshService raw ${csatAverage?.toFixed(1)}/4 · ${csatCount} response${csatCount === 1 ? '' : 's'})`
    : 'No CSAT responses in this period';

  // Color bands on the /5 scale (same cutoffs as the old /4 bands x 1.25).
  const getCSATColor = (avg5) => {
    if (!avg5) return 'text-muted-foreground/75';
    if (avg5 >= 4.4) return 'text-green-600 dark:text-green-300';
    if (avg5 >= 3.1) return 'text-yellow-600 dark:text-yellow-300';
    if (avg5 >= 1.9) return 'text-orange-600 dark:text-orange-300';
    return 'text-red-600 dark:text-red-300';
  };

  const highSelfPickRate = selfPicked >= 3;

  // Rejection display: count of rejections in the SELECTED period (today /
  // selected week / selected month). Falls back to 7d/30d if backend hasn't
  // sent rejectedThisPeriod yet (older deploy).
  const rejectedDisplay = (technician.rejectedThisPeriod !== undefined && technician.rejectedThisPeriod !== null)
    ? technician.rejectedThisPeriod
    : viewMode === 'monthly'
      ? (technician.rejected30d || 0)
      : (technician.rejected7d || 0);
  const periodLabel = viewMode === 'weekly' ? 'this week'
    : viewMode === 'monthly' ? 'this month'
      : 'this day';

  // Get ticket counts - prioritize "Open" status (most important)
  // FreshService statuses: Open (active work), Pending (waiting/less urgent), Resolved, Closed
  const openOnlyCount = technician.openOnlyCount || 0;
  const pendingCount = technician.pendingCount || 0;
  const _totalOpenCount = technician.openTicketCount || 0; // Open + Pending combined

  // Use "Open" status count for card background color (most important metric).
  // Simple style keeps cards plain white — load is readable from the numbers
  // (QA 07-30 #9: fewer colors).
  const cardBgColor = simple ? 'bg-card' : getCardBackgroundColor(openOnlyCount, maxOpenCount);

  // Active leave for the current view's reference date (badge + simple caption)
  const activeLeave = (() => {
    let dateStr;
    if (viewMode === 'daily') {
      dateStr = selectedDate
        ? (typeof selectedDate === 'string' ? selectedDate : selectedDate.toISOString().slice(0, 10))
        : new Date().toISOString().slice(0, 10);
    } else {
      dateStr = new Date().toISOString().slice(0, 10);
    }
    return getLeaveForDate(technician.leaveInfo, dateStr);
  })();
  const leaveBadge = activeLeave ? getLeaveBadge(activeLeave) : null;

  return (
    <div
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={`${cardBgColor} border ${simple ? 'border-border' : 'border-border'} rounded-lg shadow-sm hover:shadow-xl transition-all duration-300 cursor-pointer group relative overflow-hidden`}
    >
      {/* Hide Button - Top Right. Always visible on touch (hover-reveal is
          unreachable on phones); fades in on hover for pointer devices. */}
      <button
        onClick={handleHideToggle}
        aria-label={`Hide ${technician.name}`}
        className="hide-button tp-focus-ring absolute top-2 right-2 p-2 sm:p-1.5 rounded-lg z-10 text-muted-foreground/75 bg-card/70 opacity-70 hover:bg-muted hover:opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity"
        title="Hide technician"
      >
        <EyeOff className="w-4 h-4" />
      </button>

      {/* Card Content */}
      <div className="p-3 sm:p-4">
        {/* Header: Photo + Name + Badges */}
        <div className="flex items-center sm:items-start gap-3 mb-2 sm:mb-4">
          {/* Profile Photo or Initials Circle — explicit agent-page affordance */}
          <button
            type="button"
            onClick={handleAgentLinkClick}
            title="Open agent page"
            aria-label={`Open ${technician.name}'s agent page`}
            className="tp-focus-ring rounded-full flex-shrink-0"
          >
            {technician.photoUrl ? (
              <img
                src={technician.photoUrl}
                alt={technician.name}
                className="w-12 h-12 sm:w-14 sm:h-14 rounded-full object-cover shadow-md border-2 border-input"
                onError={(e) => {
                  // Hide broken images so alt text doesn't leak the real name.
                  e.currentTarget.style.display = 'none';
                }}
              />
            ) : (
              <span className="flex items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-600 w-12 h-12 sm:w-14 sm:h-14 shadow-md border-2 border-blue-400">
                <span className="text-sm sm:text-base font-bold text-white">
                  {getInitials(technician.name)}
                </span>
              </span>
            )}
          </button>

          {/* Name and Badges Column */}
          <div className="flex-1 min-w-0 sm:pt-1">
            <div className="flex items-center gap-2 flex-wrap">
              {/* Rank Badge */}
              {isTopPerformer && (
                <div className={`
                  flex items-center justify-center rounded-full w-6 h-6
                  ${rank === 1 ? 'bg-yellow-400' : rank === 2 ? 'bg-muted-foreground/40' : 'bg-orange-400'}
                `}>
                  {rank === 1 ? (
                    <Trophy className="w-4 h-4 text-yellow-900 dark:text-yellow-200" />
                  ) : (
                    <Star className={`w-3 h-3 ${rank === 2 ? 'text-foreground/85' : 'text-orange-900 dark:text-orange-200'}`} />
                  )}
                </div>
              )}

              {/* Name — explicit agent-page affordance */}
              <h3 className="font-semibold text-base sm:text-lg text-foreground truncate">
                <button
                  type="button"
                  onClick={handleAgentLinkClick}
                  title="Open agent page"
                  className="tp-focus-ring max-w-full truncate rounded text-left hover:underline hover:text-blue-700 dark:hover:text-blue-200"
                >
                  {technician.name}
                </button>
              </h3>

              {/* Self-Starter Badge */}
              {!simple && highSelfPickRate && (
                <div className="flex items-center gap-1 px-2 py-1 bg-purple-100 dark:bg-purple-500/20 rounded-full">
                  <Star className="w-3 h-3 text-purple-600 dark:text-purple-300 fill-purple-600" />
                  <span className="text-[9px] text-purple-700 dark:text-purple-200 font-semibold">SELF</span>
                </div>
              )}

              {/* Leave Badge */}
              {leaveBadge && (
                <div className={`flex items-center gap-1 px-2 py-0.5 ${leaveBadge.badgeBg} ${leaveBadge.badgeText} border ${leaveBadge.badgeBorder} rounded-full`} title={getLeaveTooltip(activeLeave)}>
                  <div className={`w-1.5 h-1.5 rounded-full ${leaveBadge.dotClass}`} />
                  <span className="text-[9px] font-semibold">{leaveBadge.shortText}</span>
                </div>
              )}

            </div>

            {/* Simple style: one calm status pill instead of badges (QA 08-04 #11) */}
            {simple && (
              <div className="mt-1 min-w-0">
                <AgentStatusPill leaveBadge={leaveBadge} activeLeave={activeLeave} topLoad={topLoad} />
              </div>
            )}
          </div>
        </div>

        {/* Weekly Breakdown Mini-Calendar - Only show in weekly view */}
        {viewMode === 'weekly' && technician.dailyBreakdown && (
          <div className="mb-3 pb-3 border-b border-border">
            <div className="grid grid-cols-7 gap-1">
              {technician.dailyBreakdown.map((day, index) => {
                const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
                const colorClass = getTicketColor(day.total, maxDailyCount);
                
                // Get weekend/holiday styling
                const dateStyling = getDateStyling(day.date, { variant: 'box' });
                const holidayTooltip = getHolidayTooltip(day.date);
                const isWeekendDay = dateStyling.isWeekend;
                const isHolidayDay = dateStyling.isHoliday;
                const isTodayDay = dateStyling.isToday;

                // Leave info for this day
                const dayLeave = getLeaveForDate(technician.leaveInfo, day.date);
                const leaveTooltip = getLeaveTooltip(dayLeave);
                const leaveDot = getLeaveDotClass(dayLeave);

                // Build tooltip
                const baseTooltip = `${dayNames[index]}: ${day.total} tickets (${day.self} self, ${day.assigned} assigned, ${day.closed} closed)`;
                const tooltipParts = isTodayDay ? ['Today', baseTooltip] : [baseTooltip];
                if (holidayTooltip) tooltipParts.push(holidayTooltip);
                if (leaveTooltip) tooltipParts.push(leaveTooltip);
                const fullTooltip = tooltipParts.join('\n');

                // Determine label styling — holiday colors keep priority (they
                // carry meaning); the today ring is what marks today there.
                // Today tint per view (QA 08-05 #5): violet is Simple's brand
                // tint; Detailed uses a deep emerald that reads as a calm
                // marker next to its green/rose/indigo/slate tiles.
                const todayRing = simple
                  ? 'ring-2 ring-violet-500 ring-offset-1'
                  : 'ring-2 ring-emerald-700 ring-offset-1';
                const labelClass = isHolidayDay
                  ? dateStyling.isCanadian
                    ? 'text-rose-600 dark:text-rose-300 font-bold'
                    : 'text-indigo-500 font-bold'
                  : isTodayDay
                    ? simple
                      ? 'text-violet-700 dark:text-violet-200 font-bold'
                      : 'text-emerald-700 dark:text-emerald-200 font-bold'
                    : isWeekendDay
                      ? 'text-muted-foreground font-semibold'
                      : 'text-muted-foreground font-semibold';
                
                const leaveStyle = dayLeave ? getLeaveStyle(dayLeave.category) : null;
                const dayLeaveIsHalf = isHalfDayLeave(dayLeave);
                const dayLeaveSplit = dayLeaveIsHalf ? getLeaveSplit(dayLeave) : null;

                // Container styling for leave/holiday/weekend.
                // Half-day leaves use the full-day container so the day still
                // reads as "leave" at a glance; the box itself is what shows
                // the AM/PM split.
                const containerClass = dayLeave
                  ? `${leaveStyle.bgClass} rounded-lg p-0.5`
                  : isHolidayDay
                    ? dateStyling.isCanadian
                      ? 'bg-rose-50/50 dark:bg-rose-500/10 rounded-lg p-0.5'
                      : 'bg-indigo-50/40 dark:bg-indigo-500/10 rounded-lg p-0.5'
                    : isWeekendDay
                      ? 'bg-muted/25 rounded-lg p-0.5'
                      : '';

                // Determine box styling - full-day leave/holidays/weekends
                // override normal colors. Half-day leaves keep the normal
                // ticket-count colour and add an AM/PM overlay below.
                const getBoxClasses = () => {
                  if (dayLeave && !dayLeaveIsHalf) {
                    if (day.total === 0) return `${leaveStyle.borderClass} ${leaveStyle.bgClass} ${leaveStyle.textClass}`;
                    return `${leaveStyle.borderClass} ${leaveStyle.badgeBg} ${leaveStyle.badgeText}`;
                  }
                  if (isHolidayDay) {
                    if (dateStyling.isCanadian) {
                      if (day.total === 0) {
                        return 'border-rose-300 dark:border-rose-500/40 bg-rose-50 dark:bg-rose-500/15 text-rose-400';
                      }
                      return 'border-rose-400 bg-rose-100 dark:bg-rose-500/20 text-rose-800 dark:text-rose-200';
                    }
                    if (day.total === 0) {
                      return 'border-indigo-200 dark:border-indigo-500/30 bg-indigo-50 dark:bg-indigo-500/15 text-indigo-400';
                    }
                    return 'border-indigo-300 dark:border-indigo-500/40 bg-indigo-100 dark:bg-indigo-500/20 text-indigo-800 dark:text-indigo-200';
                  }
                  if (isWeekendDay) {
                    if (day.total === 0) {
                      return 'border-input bg-muted/50 text-muted-foreground/75';
                    }
                    return 'border-muted-foreground/40 bg-secondary text-foreground';
                  }
                  // Simple style: one calm violet tint for activity, white for
                  // zero — leave/holiday/weekend colors above stay (QA: keep
                  // availability colors).
                  if (simple) {
                    return day.total === 0
                      ? 'border-border bg-card text-muted-foreground/50'
                      : 'border-violet-200 dark:border-violet-500/30 bg-violet-100 dark:bg-violet-500/20 text-violet-900 dark:text-violet-200';
                  }
                  return colorClass;
                };

                const handleDayBoxClick = (e) => {
                  e.stopPropagation();
                  navigate(`/technician/${technician.id}`, {
                    state: {
                      selectedDate: new Date(day.date + 'T12:00:00'),
                      selectedWeek: selectedWeek,
                      viewMode: 'daily',
                      returnViewMode: 'weekly',
                      searchTerm: searchTerm,
                      selectedCategories: selectedCategories,
                      canonicalCategoryFilter,
                    },
                  });
                };

                return (
                  <div
                    key={day.date}
                    className={`flex min-w-0 flex-col items-center cursor-pointer ${containerClass}`}
                    title={fullTooltip}
                    onClick={handleDayBoxClick}
                  >
                    <div className="flex items-center justify-center gap-0.5 h-3">
                      {isHolidayDay && (
                        <div className={`w-1 h-1 rounded-full ${dateStyling.isCanadian ? 'bg-rose-500' : 'bg-indigo-400'}`} />
                      )}
                      {leaveDot && (
                        <div className={`w-1.5 h-1.5 rounded-full ${leaveDot}`} />
                      )}
                      <div className={`text-[8px] ${labelClass} mb-0.5`}>
                        {dayNames[index]}
                        <span className="text-[7px] opacity-60 ml-0.5">{parseInt(day.date.split('-')[2], 10)}</span>
                      </div>
                    </div>
                    <div className={`relative h-8 w-full max-w-9 rounded flex items-center justify-center text-[10px] font-bold border overflow-hidden transition-all duration-150 hover:scale-110 hover:shadow-lg hover:ring-2 hover:ring-blue-400 hover:ring-offset-1 ${isTodayDay ? todayRing : ''} ${getBoxClasses()}`}>
                      {/* Half-day overlay: gradient fades from the leave colour
                          at the AM/PM edge into transparent at the midline,
                          so there is no hard 50/50 split. */}
                      {dayLeaveSplit?.isSplit && (
                        <div className={`absolute inset-0 ${dayLeaveSplit.overlayClass} pointer-events-none`} />
                      )}
                      <span className="relative z-10">{day.total}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {simple ? (
          /* Simple style (QA 07-30 #9): total band + plain-number stat pairs
             with full-word labels — no icon tiles, minimal color. */
          <>
            <div className="mb-3 flex flex-wrap items-baseline justify-center gap-x-1.5 gap-y-0.5 rounded-lg bg-violet-50/60 dark:bg-violet-500/10 px-2 py-2">
              <span className="text-2xl font-bold text-indigo-600 dark:text-indigo-300 leading-none">{totalTickets}</span>
              <span className="text-xs font-medium text-muted-foreground">
                {totalTickets === 1 ? 'ticket' : 'tickets'}{' '}
                {viewMode === 'weekly' ? 'this week' : viewMode === 'monthly' ? 'this month' : 'today'}
              </span>
              {/* Mobile only (daily): open-now, so phones don't lose the
                  workload signal the desktop table shows in its Open column */}
              {viewMode === 'daily' && (
                <span
                  className="sm:hidden flex items-baseline gap-1 border-l border-violet-200/70 pl-2.5 ml-1"
                  title={`${openOnlyCount} open ticket${openOnlyCount === 1 ? '' : 's'} right now${pendingCount > 0 ? ` · ${pendingCount} pending` : ''}`}
                >
                  <span className="text-2xl font-bold leading-none text-foreground/85">{openOnlyCount}</span>
                  <span className="text-xs font-medium text-muted-foreground">
                    open now{pendingCount > 0 ? ` +${pendingCount} pend` : ''}
                  </span>
                </span>
              )}
            </div>

            <div className="mb-2 grid grid-cols-3 gap-x-2 gap-y-3">
              <div className="flex flex-col items-center text-center">
                <div className={`text-base font-semibold ${selfPicked > 0 ? 'text-foreground' : 'text-muted-foreground/50'}`}>{selfPicked}</div>
                <div className="text-[10px] text-muted-foreground/75 max-sm:text-muted-foreground leading-tight">Picked up themselves</div>
              </div>
              <div className="flex flex-col items-center text-center">
                <div className={`text-base font-semibold ${appAssigned > 0 ? 'text-foreground' : 'text-muted-foreground/50'}`}>{appAssigned}</div>
                <div className="text-[10px] text-muted-foreground/75 max-sm:text-muted-foreground leading-tight">Sent by the app</div>
              </div>
              <div className="flex flex-col items-center text-center">
                <div className={`text-base font-semibold ${assigned > 0 ? 'text-foreground' : 'text-muted-foreground/50'}`}>{assigned}</div>
                <div className="text-[10px] text-muted-foreground/75 max-sm:text-muted-foreground leading-tight">Sent by a coordinator</div>
              </div>
              <div className="flex flex-col items-center text-center">
                <div className={`text-base font-semibold ${closed > 0 ? 'text-green-700 dark:text-green-200' : 'text-muted-foreground/50'}`}>{closed}</div>
                <div className="text-[10px] text-muted-foreground/75 max-sm:text-muted-foreground leading-tight">Resolved</div>
              </div>
              <div
                className="flex flex-col items-center text-center"
                title={
                  rejectedDisplay > 0
                    ? `Rejected tickets — picked up then put back in queue\nSelected ${periodLabel}: ${rejectedDisplay}`
                    : `No bounced tickets ${periodLabel}`
                }
              >
                <div className={`text-base font-semibold ${rejectedDisplay > 0 ? 'text-red-600 dark:text-red-300' : 'text-muted-foreground/50'}`}>{rejectedDisplay}</div>
                <div className="text-[10px] text-muted-foreground/75 max-sm:text-muted-foreground leading-tight">Rejected</div>
              </div>
              <div className="flex flex-col items-center text-center" title={csatTooltip}>
                <div className={`text-base font-semibold ${hasCSAT ? getCSATColor(csatOutOf5) : 'text-muted-foreground/50'}`}>
                  {hasCSAT ? csatOutOf5?.toFixed(1) : '—'}
                </div>
                <div className="text-[10px] text-muted-foreground/75 max-sm:text-muted-foreground leading-tight">
                  CSAT score
                  {/* Mobile: tooltips are unreachable on touch, so surface N inline */}
                  {hasCSAT && <span className="sm:hidden"> ({csatCount})</span>}
                </div>
              </div>
            </div>
          </>
        ) : (
          <>
            {/* ── Mobile (<sm) compact presentation ──────────────────────
                The display-size Open number + icon tiles read gigantic on a
                phone (QA 08-08). Same data, phone-scale hierarchy: a calm
                summary band, then an inline six-stat strip. Desktop Cards
                view (sm+) keeps the original presentation below. */}
            <div className="sm:hidden mb-1">
              <div className="mb-1.5 flex flex-wrap items-center justify-center gap-x-4 gap-y-0.5 rounded-lg border border-border/60 bg-muted/40 px-2 py-2">
                {viewMode === 'daily' && (
                  <span
                    className="flex items-baseline gap-1"
                    title={`Workload: ${openOnlyCount} open ticket${openOnlyCount === 1 ? '' : 's'}${pendingCount > 0 ? ` · ${pendingCount} pending` : ''}`}
                  >
                    <span className={`text-lg font-bold leading-none ${getLoadTextClass(openOnlyCount)}`}>{openOnlyCount}</span>
                    <span className="text-[11px] font-medium text-muted-foreground">
                      open now{pendingCount > 0 ? ` +${pendingCount} pend` : ''}
                    </span>
                  </span>
                )}
                <span className={`flex items-baseline gap-1 ${viewMode === 'daily' ? 'border-l border-border pl-3' : ''}`}>
                  <span className="text-lg font-bold leading-none text-indigo-600 dark:text-indigo-300">{totalTickets}</span>
                  <span className="text-[11px] font-medium text-muted-foreground">
                    {viewMode === 'weekly' ? 'this week' : viewMode === 'monthly' ? 'this month' : 'new today'}
                  </span>
                </span>
              </div>
              <div className="grid grid-cols-6">
                <MobileStat icon={Hand} value={selfPicked} label="Self" iconClass="text-purple-600 dark:text-purple-300" numClass="text-purple-900 dark:text-purple-200" muted={selfPicked === 0} title="Picked up themselves" />
                <MobileStat
                  icon={Bot}
                  value={appAssigned}
                  label="App"
                  iconClass="text-sky-600 dark:text-sky-300"
                  numClass="text-sky-800 dark:text-sky-200"
                  muted={appAssigned === 0}
                  title={appAssigned > 0 ? 'App-assigned tickets (by Ticket Pulse service account)' : 'No app-assigned tickets'}
                />
                <MobileStat icon={Send} value={assigned} label="Coord" iconClass="text-orange-600 dark:text-orange-300" numClass="text-orange-800 dark:text-orange-200" muted={assigned === 0} title={`Coordinator-assigned: ${assigned}`} />
                <MobileStat icon={CheckSquare} value={closed} label="Done" iconClass="text-green-600 dark:text-green-300" numClass="text-green-800 dark:text-green-200" muted={closed === 0} title={`Closed: ${closed}`} />
                <MobileStat
                  icon={RotateCcw}
                  value={rejectedDisplay}
                  label="Rej"
                  iconClass="text-red-500"
                  numClass="text-red-700 dark:text-red-200"
                  muted={rejectedDisplay === 0}
                  title={
                    rejectedDisplay > 0
                      ? `Rejected tickets — picked up then put back in queue\nSelected ${periodLabel}: ${rejectedDisplay}\n\nTap to see the list`
                      : `No bounced tickets ${periodLabel}`
                  }
                  onClick={
                    rejectedDisplay > 0
                      ? (e) => {
                        e.stopPropagation();
                        navigate(buildBouncedUrl(technician.id, viewMode, selectedDate, selectedWeek, selectedMonth));
                      }
                      : undefined
                  }
                />
                <MobileStat
                  icon={Star}
                  value={hasCSAT ? csatOutOf5?.toFixed(1) : '—'}
                  suffix={hasCSAT ? '/5' : null}
                  label={hasCSAT ? `CSAT (${csatCount})` : 'CSAT'}
                  iconClass={getCSATColor(csatOutOf5)}
                  numClass={getCSATColor(csatOutOf5)}
                  muted={!hasCSAT}
                  title={csatTooltip}
                />
              </div>
            </div>

            {/* Ticket Status Display (sm+ / desktop Cards view) */}
            <div className="hidden sm:block mb-3 py-3 border-b border-border">
              <div className="flex items-center justify-center gap-4 sm:gap-6">
                {/* Open Count - Only show in daily view */}
                {viewMode === 'daily' && (
                  <div className="text-center flex items-center gap-2 sm:gap-3">
                    <img
                      src="/brand/icon-workload.png"
                      alt=""
                      aria-hidden="true"
                      title={`Workload: ${openOnlyCount} open ticket${openOnlyCount === 1 ? '' : 's'}`}
                      className="w-7 h-7 sm:w-9 sm:h-9 flex-shrink-0 opacity-90"
                    />
                    <div>
                      <div className="text-4xl sm:text-5xl font-bold text-foreground leading-none">{openOnlyCount}</div>
                      <div className="text-xs text-foreground/85 uppercase font-bold mt-1">Open</div>
                      {pendingCount > 0 && (
                        <div className="text-xs text-muted-foreground font-medium mt-0.5">
                          ({pendingCount} pend)
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Total Count */}
                <div className="text-center">
                  <div className="text-3xl font-bold text-indigo-600 dark:text-indigo-300 leading-none">{totalTickets}</div>
                  <div className="text-[9px] text-indigo-400 uppercase font-semibold mt-1">
                    {viewMode === 'weekly' || viewMode === 'monthly' ? 'total' : 'today'}
                  </div>
                </div>
              </div>
            </div>

            {/* Metrics Grid - Icons + Numbers (sm+ / desktop Cards view) */}
            {/* Fixed 6-column layout so all techs align vertically. Optional metrics
            (App, Rej, CSAT) render as muted placeholders when count is 0. */}
            <div className="hidden gap-2 mb-2 sm:grid sm:grid-cols-6">

              {/* Self - always primary */}
              <div className="flex flex-col items-center p-2 bg-purple-100 dark:bg-purple-500/20 rounded-lg shadow-sm border border-purple-200 dark:border-purple-500/30">
                <Hand className="w-5 h-5 text-purple-700 dark:text-purple-200 mb-1" />
                <div className="text-lg font-bold text-purple-900 dark:text-purple-200">{selfPicked}</div>
                <div className="text-[9px] text-purple-700 dark:text-purple-200 uppercase font-bold">Self</div>
              </div>

              {/* App Assigned - muted when 0 to keep alignment */}
              <div
                className={`flex flex-col items-center p-2 rounded-lg shadow-sm border ${
                  appAssigned > 0
                    ? 'bg-sky-50 dark:bg-sky-500/15 border-sky-200 dark:border-sky-500/30'
                    : 'bg-muted/25 border-border/60 opacity-50'
                }`}
                title={appAssigned > 0 ? 'App-assigned tickets (by Ticket Pulse service account)' : 'No app-assigned tickets'}
              >
                <Bot className={`w-5 h-5 mb-1 ${appAssigned > 0 ? 'text-sky-600 dark:text-sky-300' : 'text-muted-foreground/50'}`} />
                <div className={`text-lg font-bold ${appAssigned > 0 ? 'text-sky-800 dark:text-sky-200' : 'text-muted-foreground/50'}`}>{appAssigned}</div>
                <div className={`text-[9px] uppercase font-bold ${appAssigned > 0 ? 'text-sky-600 dark:text-sky-300' : 'text-muted-foreground/50'}`}>App</div>
              </div>

              {/* Assigned (by coordinator) - always shown */}
              <div className="flex flex-col items-center p-2">
                <Send className="w-5 h-5 text-orange-600 dark:text-orange-300 mb-1" />
                <div className="text-lg font-bold text-orange-800 dark:text-orange-200">{assigned}</div>
                <div className="text-[9px] text-orange-600 dark:text-orange-300 uppercase font-medium">Asgn</div>
              </div>

              {/* Done - always shown */}
              <div className="flex flex-col items-center p-2">
                <CheckSquare className="w-5 h-5 text-green-600 dark:text-green-300 mb-1" />
                <div className="text-lg font-bold text-green-800 dark:text-green-200">{closed}</div>
                <div className="text-[9px] text-green-600 dark:text-green-300 uppercase font-medium">Done</div>
              </div>

              {/* Rejected - count of rejections in the SELECTED period; muted when 0; clickable to drill into bounced list */}
              {rejectedDisplay > 0 ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(buildBouncedUrl(technician.id, viewMode, selectedDate, selectedWeek, selectedMonth));
                  }}
                  className="flex flex-col items-center p-2 bg-red-50 dark:bg-red-500/15 rounded-lg shadow-sm border border-red-200 dark:border-red-500/30 hover:bg-red-100 dark:hover:bg-red-500/20 hover:border-red-300 dark:hover:border-red-500/40 transition-colors cursor-pointer"
                  title={
                    'Rejected tickets — tech picked up then put back in queue\n' +
                    `Selected ${periodLabel}: ${rejectedDisplay}\n` +
                    `Last 7d: ${technician.rejected7d || 0}\n` +
                    `Last 30d: ${technician.rejected30d || 0}\n` +
                    `Lifetime: ${technician.rejectedLifetime || 0}\n\n` +
                    'Click to see the list'
                  }
                >
                  <RotateCcw className="w-5 h-5 text-red-500 mb-1" />
                  <div className="text-lg font-bold text-red-700 dark:text-red-200">{rejectedDisplay}</div>
                  <div className="text-[9px] text-red-500 uppercase font-bold">Rej</div>
                </button>
              ) : (
                <div
                  className="flex flex-col items-center p-2 bg-muted/25 rounded-lg shadow-sm border border-border/60 opacity-50"
                  title={
                    `No bounced tickets ${periodLabel}\n` +
                    `Last 7d: ${technician.rejected7d || 0}  ·  Last 30d: ${technician.rejected30d || 0}  ·  Lifetime: ${technician.rejectedLifetime || 0}`
                  }
                >
                  <RotateCcw className="w-5 h-5 text-muted-foreground/50 mb-1" />
                  <div className="text-lg font-bold text-muted-foreground/50">0</div>
                  <div className="text-[9px] text-muted-foreground/50 uppercase font-bold">Rej</div>
                </div>
              )}

              {/* CSAT — the AVERAGE on the /5 scale, not the response count
              (QA 07-30 #5: "2" next to a star read as a 2/4 score). */}
              {hasCSAT ? (
                <div className="flex flex-col items-center p-2 bg-yellow-50 dark:bg-yellow-500/15 rounded-lg shadow-sm border border-yellow-200 dark:border-yellow-500/30" title={csatTooltip}>
                  <Star className={`w-5 h-5 ${getCSATColor(csatOutOf5)} mb-1`} />
                  <div className={`text-lg font-bold ${getCSATColor(csatOutOf5)}`}>
                    {csatOutOf5?.toFixed(1)}
                    <span className="ml-0.5 text-[10px] font-semibold text-yellow-700/70">/ 5</span>
                  </div>
                  <div className="text-[9px] text-yellow-700 dark:text-yellow-200 uppercase font-bold">CSAT</div>
                </div>
              ) : (
                <div
                  className="flex flex-col items-center p-2 bg-muted/25 rounded-lg shadow-sm border border-border/60 opacity-50"
                  title="No CSAT responses in this period"
                >
                  <Star className="w-5 h-5 text-muted-foreground/50 mb-1" />
                  <div className="text-lg font-bold text-muted-foreground/50">—</div>
                  <div className="text-[9px] text-muted-foreground/50 uppercase font-bold">CSAT</div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Inline ticket drilldown — the mobile answer to "no ticket list on
          phones". Tapping toggles the tech's tickets in place instead of
          forcing a trip to the detail page; links go to /tickets/:id. */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setTicketsOpen((v) => !v); }}
        aria-expanded={ticketsOpen}
        className="tp-focus-ring flex w-full items-center justify-between gap-2 border-t border-border px-4 py-3 sm:py-2.5 text-left active:bg-muted/50"
      >
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <TicketIcon className="h-3.5 w-3.5 text-muted-foreground/75" aria-hidden="true" />
          {ticketsOpen ? 'Hide tickets' : `View tickets${ticketTotal ? ` (${ticketTotal})` : ''}`}
        </span>
        <ChevronDown className={`h-4 w-4 flex-shrink-0 text-muted-foreground/75 transition-transform ${ticketsOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {ticketsOpen && (
        <div className="min-w-0" onClick={(e) => e.stopPropagation()}>
          {/* Assigned-by summary — used to be its own badges/popup block on
              the card face (QA 07-30 #4). */}
          {technician.assigners?.length > 0 && (
            <div className="px-4 pt-2 pb-0.5 text-[11px] text-muted-foreground">
              <span className="font-semibold text-muted-foreground">Assigned by:</span>{' '}
              {technician.assigners.map((a) => `${a.name} (${a.count})`).join(' · ')}
            </div>
          )}
          <ExpandableTicketList
            activeTickets={activeTickets}
            closedTickets={closedTickets}
            techName={technician.name}
            viewMode={viewMode}
            narrow
          />
        </div>
      )}
    </div>
  );
}
