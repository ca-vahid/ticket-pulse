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
    return 'bg-white'; // No load - pure white
  }

  // Calculate percentage relative to max
  const percentage = (openCount / maxOpenCount) * 100;

  if (percentage <= 33) {
    return 'bg-green-50/30'; // Light load - extremely subtle green tint
  }
  if (percentage <= 66) {
    return 'bg-yellow-50/40'; // Medium load - extremely subtle yellow tint
  }
  return 'bg-red-50/50'; // Heavy load - extremely subtle red tint
};

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
    if (count === 0) return 'bg-white border-gray-200 text-gray-400';

    const percentage = (count / maxCount) * 100;

    // Good (high tickets) = Green gradient
    if (percentage >= 66) {
      return 'bg-green-500 border-green-600 text-white';
    } else if (percentage >= 33) {
      return 'bg-green-300 border-green-400 text-green-900';
    } else {
      return 'bg-green-100 border-green-200 text-green-800';
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
    if (!avg5) return 'text-gray-400';
    if (avg5 >= 4.4) return 'text-green-600';
    if (avg5 >= 3.1) return 'text-yellow-600';
    if (avg5 >= 1.9) return 'text-orange-600';
    return 'text-red-600';
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
  const cardBgColor = simple ? 'bg-white' : getCardBackgroundColor(openOnlyCount, maxOpenCount);

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
      className={`${cardBgColor} border ${simple ? 'border-slate-200' : 'border-gray-200'} rounded-lg shadow-sm hover:shadow-xl transition-all duration-300 cursor-pointer group relative overflow-hidden`}
    >
      {/* Hide Button - Top Right. Always visible on touch (hover-reveal is
          unreachable on phones); fades in on hover for pointer devices. */}
      <button
        onClick={handleHideToggle}
        aria-label={`Hide ${technician.name}`}
        className="hide-button tp-focus-ring absolute top-2 right-2 p-1.5 rounded-lg z-10 text-gray-400 bg-white/70 opacity-70 hover:bg-gray-100 hover:opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity"
        title="Hide technician"
      >
        <EyeOff className="w-4 h-4" />
      </button>

      {/* Card Content */}
      <div className="p-3 sm:p-4">
        {/* Header: Photo + Name + Badges */}
        <div className="flex items-start gap-3 mb-3 sm:mb-4">
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
                className="w-14 h-14 rounded-full object-cover shadow-md border-2 border-gray-300"
                onError={(e) => {
                  // Hide broken images so alt text doesn't leak the real name.
                  e.currentTarget.style.display = 'none';
                }}
              />
            ) : (
              <span className="flex items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-600 w-14 h-14 shadow-md border-2 border-blue-400">
                <span className="text-base font-bold text-white">
                  {getInitials(technician.name)}
                </span>
              </span>
            )}
          </button>

          {/* Name and Badges Column */}
          <div className="flex-1 min-w-0 pt-1">
            <div className="flex items-center gap-2 flex-wrap">
              {/* Rank Badge */}
              {isTopPerformer && (
                <div className={`
                  flex items-center justify-center rounded-full w-6 h-6
                  ${rank === 1 ? 'bg-yellow-400' : rank === 2 ? 'bg-gray-300' : 'bg-orange-400'}
                `}>
                  {rank === 1 ? (
                    <Trophy className="w-4 h-4 text-yellow-900" />
                  ) : (
                    <Star className={`w-3 h-3 ${rank === 2 ? 'text-gray-700' : 'text-orange-900'}`} />
                  )}
                </div>
              )}

              {/* Name — explicit agent-page affordance */}
              <h3 className="font-semibold text-base sm:text-lg text-gray-900 truncate">
                <button
                  type="button"
                  onClick={handleAgentLinkClick}
                  title="Open agent page"
                  className="tp-focus-ring max-w-full truncate rounded text-left hover:underline hover:text-blue-700"
                >
                  {technician.name}
                </button>
              </h3>

              {/* Self-Starter Badge */}
              {!simple && highSelfPickRate && (
                <div className="flex items-center gap-1 px-2 py-1 bg-purple-100 rounded-full">
                  <Star className="w-3 h-3 text-purple-600 fill-purple-600" />
                  <span className="text-[9px] text-purple-700 font-semibold">SELF</span>
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
          <div className="mb-3 pb-3 border-b border-gray-200">
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
                    ? 'text-rose-600 font-bold'
                    : 'text-indigo-500 font-bold'
                  : isTodayDay
                    ? simple
                      ? 'text-violet-700 font-bold'
                      : 'text-emerald-700 font-bold'
                    : isWeekendDay
                      ? 'text-slate-500 font-semibold'
                      : 'text-gray-500 font-semibold';
                
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
                      ? 'bg-rose-50/50 rounded-lg p-0.5'
                      : 'bg-indigo-50/40 rounded-lg p-0.5'
                    : isWeekendDay
                      ? 'bg-slate-50/50 rounded-lg p-0.5'
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
                        return 'border-rose-300 bg-rose-50 text-rose-400';
                      }
                      return 'border-rose-400 bg-rose-100 text-rose-800';
                    }
                    if (day.total === 0) {
                      return 'border-indigo-200 bg-indigo-50 text-indigo-400';
                    }
                    return 'border-indigo-300 bg-indigo-100 text-indigo-800';
                  }
                  if (isWeekendDay) {
                    if (day.total === 0) {
                      return 'border-slate-300 bg-slate-50 text-slate-400';
                    }
                    return 'border-slate-400 bg-slate-200 text-slate-800';
                  }
                  // Simple style: one calm violet tint for activity, white for
                  // zero — leave/holiday/weekend colors above stay (QA: keep
                  // availability colors).
                  if (simple) {
                    return day.total === 0
                      ? 'border-slate-200 bg-white text-slate-300'
                      : 'border-violet-200 bg-violet-100 text-violet-900';
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
            <div className="mb-3 flex items-baseline justify-center gap-1.5 rounded-lg bg-violet-50/60 py-2">
              <span className="text-2xl font-bold text-indigo-600 leading-none">{totalTickets}</span>
              <span className="text-xs font-medium text-slate-500">
                {totalTickets === 1 ? 'ticket' : 'tickets'}{' '}
                {viewMode === 'weekly' ? 'this week' : viewMode === 'monthly' ? 'this month' : 'today'}
              </span>
            </div>

            <div className="mb-2 grid grid-cols-3 gap-x-2 gap-y-3">
              <div className="flex flex-col items-center text-center">
                <div className={`text-base font-semibold ${selfPicked > 0 ? 'text-slate-800' : 'text-slate-300'}`}>{selfPicked}</div>
                <div className="text-[10px] text-slate-400 leading-tight">Picked up themselves</div>
              </div>
              <div className="flex flex-col items-center text-center">
                <div className={`text-base font-semibold ${appAssigned > 0 ? 'text-slate-800' : 'text-slate-300'}`}>{appAssigned}</div>
                <div className="text-[10px] text-slate-400 leading-tight">Sent by the app</div>
              </div>
              <div className="flex flex-col items-center text-center">
                <div className={`text-base font-semibold ${assigned > 0 ? 'text-slate-800' : 'text-slate-300'}`}>{assigned}</div>
                <div className="text-[10px] text-slate-400 leading-tight">Sent by a coordinator</div>
              </div>
              <div className="flex flex-col items-center text-center">
                <div className={`text-base font-semibold ${closed > 0 ? 'text-green-700' : 'text-slate-300'}`}>{closed}</div>
                <div className="text-[10px] text-slate-400 leading-tight">Resolved</div>
              </div>
              <div
                className="flex flex-col items-center text-center"
                title={
                  rejectedDisplay > 0
                    ? `Rejected tickets — picked up then put back in queue\nSelected ${periodLabel}: ${rejectedDisplay}`
                    : `No bounced tickets ${periodLabel}`
                }
              >
                <div className={`text-base font-semibold ${rejectedDisplay > 0 ? 'text-red-600' : 'text-slate-300'}`}>{rejectedDisplay}</div>
                <div className="text-[10px] text-slate-400 leading-tight">Rejected</div>
              </div>
              <div className="flex flex-col items-center text-center" title={csatTooltip}>
                <div className={`text-base font-semibold ${hasCSAT ? getCSATColor(csatOutOf5) : 'text-slate-300'}`}>
                  {hasCSAT ? csatOutOf5?.toFixed(1) : '—'}
                </div>
                <div className="text-[10px] text-slate-400 leading-tight">CSAT score</div>
              </div>
            </div>
          </>
        ) : (
          <>
            {/* Ticket Status Display */}
            <div className="mb-3 py-3 border-b border-gray-200">
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
                      <div className="text-4xl sm:text-5xl font-bold text-gray-900 leading-none">{openOnlyCount}</div>
                      <div className="text-xs text-gray-700 uppercase font-bold mt-1">Open</div>
                      {pendingCount > 0 && (
                        <div className="text-xs text-gray-500 font-medium mt-0.5">
                          ({pendingCount} pend)
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Total Count */}
                <div className="text-center">
                  <div className="text-3xl font-bold text-indigo-600 leading-none">{totalTickets}</div>
                  <div className="text-[9px] text-indigo-400 uppercase font-semibold mt-1">
                    {viewMode === 'weekly' || viewMode === 'monthly' ? 'total' : 'today'}
                  </div>
                </div>
              </div>
            </div>

            {/* Metrics Grid - Icons + Numbers */}
            {/* Fixed 6-column layout so all techs align vertically. Optional metrics
            (App, Rej, CSAT) render as muted placeholders when count is 0. */}
            <div className="grid grid-cols-3 gap-2 mb-2 sm:grid-cols-6">

              {/* Self - always primary */}
              <div className="flex flex-col items-center p-2 bg-purple-100 rounded-lg shadow-sm border border-purple-200">
                <Hand className="w-5 h-5 text-purple-700 mb-1" />
                <div className="text-lg font-bold text-purple-900">{selfPicked}</div>
                <div className="text-[9px] text-purple-700 uppercase font-bold">Self</div>
              </div>

              {/* App Assigned - muted when 0 to keep alignment */}
              <div
                className={`flex flex-col items-center p-2 rounded-lg shadow-sm border ${
                  appAssigned > 0
                    ? 'bg-sky-50 border-sky-200'
                    : 'bg-slate-50/50 border-slate-100 opacity-50'
                }`}
                title={appAssigned > 0 ? 'App-assigned tickets (by Ticket Pulse service account)' : 'No app-assigned tickets'}
              >
                <Bot className={`w-5 h-5 mb-1 ${appAssigned > 0 ? 'text-sky-600' : 'text-slate-300'}`} />
                <div className={`text-lg font-bold ${appAssigned > 0 ? 'text-sky-800' : 'text-slate-300'}`}>{appAssigned}</div>
                <div className={`text-[9px] uppercase font-bold ${appAssigned > 0 ? 'text-sky-600' : 'text-slate-300'}`}>App</div>
              </div>

              {/* Assigned (by coordinator) - always shown */}
              <div className="flex flex-col items-center p-2">
                <Send className="w-5 h-5 text-orange-600 mb-1" />
                <div className="text-lg font-bold text-orange-800">{assigned}</div>
                <div className="text-[9px] text-orange-600 uppercase font-medium">Asgn</div>
              </div>

              {/* Done - always shown */}
              <div className="flex flex-col items-center p-2">
                <CheckSquare className="w-5 h-5 text-green-600 mb-1" />
                <div className="text-lg font-bold text-green-800">{closed}</div>
                <div className="text-[9px] text-green-600 uppercase font-medium">Done</div>
              </div>

              {/* Rejected - count of rejections in the SELECTED period; muted when 0; clickable to drill into bounced list */}
              {rejectedDisplay > 0 ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(buildBouncedUrl(technician.id, viewMode, selectedDate, selectedWeek, selectedMonth));
                  }}
                  className="flex flex-col items-center p-2 bg-red-50 rounded-lg shadow-sm border border-red-200 hover:bg-red-100 hover:border-red-300 transition-colors cursor-pointer"
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
                  <div className="text-lg font-bold text-red-700">{rejectedDisplay}</div>
                  <div className="text-[9px] text-red-500 uppercase font-bold">Rej</div>
                </button>
              ) : (
                <div
                  className="flex flex-col items-center p-2 bg-slate-50/50 rounded-lg shadow-sm border border-slate-100 opacity-50"
                  title={
                    `No bounced tickets ${periodLabel}\n` +
                    `Last 7d: ${technician.rejected7d || 0}  ·  Last 30d: ${technician.rejected30d || 0}  ·  Lifetime: ${technician.rejectedLifetime || 0}`
                  }
                >
                  <RotateCcw className="w-5 h-5 text-slate-300 mb-1" />
                  <div className="text-lg font-bold text-slate-300">0</div>
                  <div className="text-[9px] text-slate-300 uppercase font-bold">Rej</div>
                </div>
              )}

              {/* CSAT — the AVERAGE on the /5 scale, not the response count
              (QA 07-30 #5: "2" next to a star read as a 2/4 score). */}
              {hasCSAT ? (
                <div className="flex flex-col items-center p-2 bg-yellow-50 rounded-lg shadow-sm border border-yellow-200" title={csatTooltip}>
                  <Star className={`w-5 h-5 ${getCSATColor(csatOutOf5)} mb-1`} />
                  <div className={`text-lg font-bold ${getCSATColor(csatOutOf5)}`}>
                    {csatOutOf5?.toFixed(1)}
                    <span className="ml-0.5 text-[10px] font-semibold text-yellow-700/70">/ 5</span>
                  </div>
                  <div className="text-[9px] text-yellow-700 uppercase font-bold">CSAT</div>
                </div>
              ) : (
                <div
                  className="flex flex-col items-center p-2 bg-slate-50/50 rounded-lg shadow-sm border border-slate-100 opacity-50"
                  title="No CSAT responses in this period"
                >
                  <Star className="w-5 h-5 text-slate-300 mb-1" />
                  <div className="text-lg font-bold text-slate-300">—</div>
                  <div className="text-[9px] text-slate-300 uppercase font-bold">CSAT</div>
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
        className="tp-focus-ring flex w-full items-center justify-between gap-2 border-t border-gray-200 px-4 py-2.5 text-left active:bg-slate-50"
      >
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600">
          <TicketIcon className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
          {ticketsOpen ? 'Hide tickets' : `View tickets${ticketTotal ? ` (${ticketTotal})` : ''}`}
        </span>
        <ChevronDown className={`h-4 w-4 flex-shrink-0 text-slate-400 transition-transform ${ticketsOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {ticketsOpen && (
        <div className="min-w-0" onClick={(e) => e.stopPropagation()}>
          {/* Assigned-by summary — used to be its own badges/popup block on
              the card face (QA 07-30 #4). */}
          {technician.assigners?.length > 0 && (
            <div className="px-4 pt-2 pb-0.5 text-[11px] text-slate-500">
              <span className="font-semibold text-slate-600">Assigned by:</span>{' '}
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
