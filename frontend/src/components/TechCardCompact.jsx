import { useNavigate } from 'react-router-dom';
import { EyeOff, Trophy, Star, Hand, Send, CheckSquare, ChevronDown, ChevronUp, Bot, RotateCcw } from 'lucide-react';
import { useState, useCallback, useRef } from 'react';
import { getDateStyling, getHolidayTooltip } from '../utils/holidays';
import { getLeaveForDate, getLeaveBadge, getLeaveTooltip, getLeaveDotClass, getLeaveStyle, isHalfDayLeave, getLeaveSplit } from '../utils/leaveInfo';
import { prefetchTechDetail } from '../hooks/usePrefetch';
import ExpandableTicketList, { useGroupedTickets, getTicketsForView } from './ExpandableTicketList';
import { getCompactGridTemplate } from './compactLayout';
import AgentStatusPill from './AgentStatusPill';

/**
 * Deep-link URL for the Bounced tab with a date range matching the current
 * dashboard view. Mirrors the helper in TechCard.jsx.
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
  const date = fmt(selectedDate) || fmt(new Date());
  return `${base}&range=day&start=${date}&end=${date}`;
}

// Extremely subtle row background color based on relative load level
const getRowBackgroundColor = (openCount, maxOpenCount) => {
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

export default function TechCardCompact({ technician, onHide, rank, selectedDate, selectedWeek, selectedMonth, maxOpenCount = 10, maxDailyCount = 1, viewMode = 'daily', searchTerm = '', selectedCategories = [], canonicalCategoryFilter = null, forceExpand = null, simple = false, topLoad = false }) {
  const navigate = useNavigate();
  const [localExpanded, setLocalExpanded] = useState(false);
  const hoverTimerRef = useRef(null);

  // forceExpand (true/false) overrides local state; null = use local
  const isExpanded = forceExpand !== null ? forceExpand : localExpanded;

  // Centralized ticket grouping (disjoint: active vs closed/resolved)
  const ticketsForView = getTicketsForView(technician, viewMode);
  const { activeTickets, closedTickets } = useGroupedTickets(ticketsForView);
  const hasExpandableTickets = activeTickets.length > 0 || closedTickets.length > 0;

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

  const handleToggleExpand = (e) => {
    e.stopPropagation();
    setLocalExpanded(prev => !prev);
  };

  // Navigation to the agent page lives on the name/avatar (a real affordance);
  // the row body itself toggles the inline ticket list (QA: clicking a row to
  // "see the tickets" kept teleporting people to the agent page).
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

  const handleAgentLinkClick = (e) => {
    e.stopPropagation();
    navigateToAgent();
  };

  const handleClick = (e) => {
    if (e.target.closest('.hide-button')) return;
    if (e.target.closest('.expand-toggle')) return;
    if (e.target.closest('.expanded-tickets')) return;
    if (e.target.closest('.no-row-nav')) return;

    // Row body click = expand/collapse, same as the chevron.
    if (!hasExpandableTickets) return;
    setLocalExpanded(prev => !prev);
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

  // Rejection display: count of rejections in the SELECTED period.
  const rejectedDisplay = (technician.rejectedThisPeriod !== undefined && technician.rejectedThisPeriod !== null)
    ? technician.rejectedThisPeriod
    : viewMode === 'monthly'
      ? (technician.rejected30d || 0)
      : (technician.rejected7d || 0);
  const periodLabel = viewMode === 'weekly' ? 'this week'
    : viewMode === 'monthly' ? 'this month'
      : 'this day';

  // Get ticket counts
  const openOnlyCount = technician.openOnlyCount || 0;
  const pendingCount = technician.pendingCount || 0;

  // Use "Open" status count for row background color. Simple style keeps rows
  // plain white — load is readable from the numbers (QA 07-30 #8: fewer colors).
  const rowBgColor = simple ? 'bg-card' : getRowBackgroundColor(openOnlyCount, maxOpenCount);

  const gridTemplate = getCompactGridTemplate(viewMode, simple);

  // Active leave for the current view's reference date (used in the name cell)
  const activeLeave = (() => {
    const dateStr = viewMode === 'daily'
      ? (selectedDate ? (typeof selectedDate === 'string' ? selectedDate : selectedDate.toISOString().slice(0, 10)) : new Date().toISOString().slice(0, 10))
      : new Date().toISOString().slice(0, 10);
    return getLeaveForDate(technician.leaveInfo, dateStr);
  })();
  const leaveBadge = activeLeave ? getLeaveBadge(activeLeave) : null;

  return (
    <div
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={`${rowBgColor} border border-border rounded-lg hover:shadow-md hover:border-input transition-all duration-200 cursor-pointer group relative`}
    >
      {/* Hide Button */}
      <button
        onClick={handleHideToggle}
        className="hide-button absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 p-1 hover:bg-muted rounded transition-opacity z-10"
        title="Hide technician"
      >
        <EyeOff className="w-3 h-3 text-muted-foreground/75" />
      </button>

      {/* Main row — CSS Grid template matches TechCompactHeader */}
      <div
        className="grid items-center gap-3 px-3 py-2"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        {/* Col 1: Expand chevron */}
        <button
          onClick={hasExpandableTickets ? handleToggleExpand : undefined}
          className={`expand-toggle p-1 rounded transition-colors w-6 h-6 flex items-center justify-center ${
            hasExpandableTickets ? 'hover:bg-secondary cursor-pointer' : 'cursor-default'
          }`}
          title={hasExpandableTickets ? (isExpanded ? 'Collapse tickets' : 'Expand tickets') : undefined}
          tabIndex={hasExpandableTickets ? 0 : -1}
        >
          {hasExpandableTickets ? (
            isExpanded ? (
              <ChevronUp className="w-4 h-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="w-4 h-4 text-muted-foreground/75" />
            )
          ) : (
            <span className="w-4 h-4" />
          )}
        </button>

        {/* Col 2: Avatar + Name (both navigate to the agent page) + inline pills */}
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={handleAgentLinkClick}
            title="Open agent page"
            aria-label={`Open ${technician.name}'s agent page`}
            className="no-row-nav tp-focus-ring rounded-full flex-shrink-0"
          >
            {technician.photoUrl ? (
              <img
                src={technician.photoUrl}
                alt={technician.name}
                className="w-9 h-9 rounded-full object-cover shadow-sm border border-input transition-all duration-300 ease-in-out hover:scale-150 hover:shadow-2xl hover:z-50"
                onError={(e) => {
                  // If the image URL is broken (404, CORS, etc.), hide the broken
                  // image so the alt text doesn't leak the technician's name.
                  e.currentTarget.style.display = 'none';
                }}
              />
            ) : (
              <span className="flex items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-600 w-9 h-9 shadow-sm border border-blue-400 transition-all duration-300 ease-in-out hover:scale-150 hover:shadow-2xl hover:z-50">
                <span className="text-[11px] font-bold text-white">
                  {getInitials(technician.name)}
                </span>
              </span>
            )}
          </button>

          {isTopPerformer && (
            <div className={`flex items-center justify-center rounded-full w-5 h-5 flex-shrink-0 ${
              rank === 1 ? 'bg-yellow-400' : rank === 2 ? 'bg-muted-foreground/40' : 'bg-orange-400'
            }`}>
              {rank === 1 ? (
                <Trophy className="w-3 h-3 text-yellow-900 dark:text-yellow-200" />
              ) : (
                <Star className={`w-2.5 h-2.5 ${rank === 2 ? 'text-foreground/85' : 'text-orange-900 dark:text-orange-200'}`} />
              )}
            </div>
          )}

          {simple ? (
            <span className="min-w-0 flex flex-col">
              <button
                type="button"
                onClick={handleAgentLinkClick}
                title="Open agent page"
                className="no-row-nav tp-focus-ring self-start max-w-full truncate rounded text-left font-semibold text-sm text-foreground hover:underline hover:text-blue-700 dark:hover:text-blue-200"
              >
                {technician.name}
              </button>
              <AgentStatusPill leaveBadge={leaveBadge} activeLeave={activeLeave} topLoad={topLoad} className="mt-0.5" />
            </span>
          ) : (
            <button
              type="button"
              onClick={handleAgentLinkClick}
              title="Open agent page"
              className="no-row-nav tp-focus-ring min-w-0 truncate rounded text-left font-semibold text-sm text-foreground hover:underline hover:text-blue-700 dark:hover:text-blue-200"
            >
              {technician.name}
            </button>
          )}

          {!simple && highSelfPickRate && (
            <div className="flex items-center gap-0.5 px-1.5 py-0.5 bg-purple-100 dark:bg-purple-500/20 rounded-full flex-shrink-0">
              <Star className="w-2 h-2 text-purple-600 dark:text-purple-300 fill-purple-600" />
              <span className="text-[8px] text-purple-700 dark:text-purple-200 font-semibold">SELF</span>
            </div>
          )}

          {leaveBadge && (
            <div
              className={`flex items-center gap-0.5 px-1.5 py-0.5 ${leaveBadge.badgeBg} ${leaveBadge.badgeText} border ${leaveBadge.badgeBorder} rounded-full flex-shrink-0`}
              title={getLeaveTooltip(activeLeave)}
            >
              <div className={`w-1.5 h-1.5 rounded-full ${leaveBadge.dotClass}`} />
              <span className="text-[8px] font-semibold">{leaveBadge.shortText}</span>
            </div>
          )}
        </div>

        {/* Col 3: Weekly heatmap (weekly) OR Open count (daily) */}
        {viewMode === 'weekly' ? (
          /* 7 equal grid columns (not a shrinkable flex row): per-day min-content
             differs (holiday/leave dots), so flex items shrank unevenly inside
             the laptop minmax track and tiles drifted out of vertical alignment
             across rows (QA 08-05 #4). Equal tracks keep every row columnar. */
          <div className="grid grid-cols-7 items-center gap-1 w-full no-row-nav">
            {(technician.dailyBreakdown || []).map((day, index) => {
              const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
              const colorClass = getTicketColor(day.total, maxDailyCount);

              const dateStyling = getDateStyling(day.date, { variant: 'box' });
              const holidayTooltip = getHolidayTooltip(day.date);
              const isWeekendDay = dateStyling.isWeekend;
              const isHolidayDay = dateStyling.isHoliday;
              const isTodayDay = dateStyling.isToday;

              const dayLeave = getLeaveForDate(technician.leaveInfo, day.date);
              const leaveTooltip = getLeaveTooltip(dayLeave);
              const leaveDot = getLeaveDotClass(dayLeave);

              const baseTooltip = `${dayNames[index]}: ${day.total} tickets (${day.self} self, ${day.assigned} assigned, ${day.closed} closed)`;
              const tooltipParts = isTodayDay ? ['Today', baseTooltip] : [baseTooltip];
              if (holidayTooltip) tooltipParts.push(holidayTooltip);
              if (leaveTooltip) tooltipParts.push(leaveTooltip);
              const fullTooltip = tooltipParts.join('\n');

              // Holiday label colors keep priority (they carry meaning); the
              // today ring below is what marks today on holiday tiles.
              // Today tint per view (QA 08-05 #5): violet is Simple's brand
              // tint; Detailed uses a deep emerald that reads as a calm marker
              // next to its green/rose/indigo/slate tiles (slate-400 vanished
              // against the weekend tiles).
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

              const containerClass = dayLeave
                ? `${leaveStyle.bgClass} rounded p-0.5`
                : isHolidayDay
                  ? dateStyling.isCanadian
                    ? 'bg-rose-50/50 dark:bg-rose-500/10 rounded p-0.5'
                    : 'bg-indigo-50/40 dark:bg-indigo-500/10 rounded p-0.5'
                  : isWeekendDay
                    ? 'bg-muted/25 rounded p-0.5'
                    : '';

              const getBoxClasses = () => {
                if (dayLeave && !dayLeaveIsHalf) {
                  if (day.total === 0) return `${leaveStyle.borderClass} ${leaveStyle.bgClass} ${leaveStyle.textClass}`;
                  return `${leaveStyle.borderClass} ${leaveStyle.badgeBg} ${leaveStyle.badgeText}`;
                }
                if (isHolidayDay) {
                  if (dateStyling.isCanadian) {
                    if (day.total === 0) return 'border-rose-300 dark:border-rose-500/40 bg-rose-50 dark:bg-rose-500/15 text-rose-400';
                    return 'border-rose-400 bg-rose-100 dark:bg-rose-500/20 text-rose-800 dark:text-rose-200';
                  }
                  if (day.total === 0) return 'border-indigo-200 dark:border-indigo-500/30 bg-indigo-50 dark:bg-indigo-500/15 text-indigo-400';
                  return 'border-indigo-300 dark:border-indigo-500/40 bg-indigo-100 dark:bg-indigo-500/20 text-indigo-800 dark:text-indigo-200';
                }
                if (isWeekendDay) {
                  if (day.total === 0) return 'border-input bg-muted/50 text-muted-foreground/75';
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
                  className={`flex flex-col items-center cursor-pointer min-w-0 w-full ${containerClass}`}
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
                  <div className={`relative w-7 h-7 rounded flex items-center justify-center text-[10px] font-bold border overflow-hidden transition-all duration-150 hover:scale-125 hover:shadow-lg hover:ring-2 hover:ring-blue-400 hover:ring-offset-1 ${isTodayDay ? todayRing : ''} ${getBoxClasses()}`}>
                    {dayLeaveSplit?.isSplit && (
                      <div className={`absolute inset-0 ${dayLeaveSplit.overlayClass} pointer-events-none`} />
                    )}
                    <span className="relative z-10">{day.total}</span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          /* Daily: Open count */
          <div className="flex flex-col items-center justify-center" title={`${openOnlyCount} open${pendingCount > 0 ? ` · ${pendingCount} pending` : ''}`}>
            <div className="text-2xl font-bold text-foreground leading-none">{openOnlyCount}</div>
            {pendingCount > 0 && (
              <div className="text-[9px] text-muted-foreground mt-0.5">+{pendingCount}p</div>
            )}
          </div>
        )}

        {/* Col 4: Total / Today */}
        <div className="flex items-center justify-center">
          <span className="text-2xl font-bold text-indigo-600 dark:text-indigo-300 leading-none">{totalTickets}</span>
        </div>

        {/* Col 5: Self */}
        <div className="flex items-center justify-center">
          {simple ? (
            <span className={`text-base font-semibold ${selfPicked > 0 ? 'text-foreground' : 'text-muted-foreground/50'}`} title="Picked up themselves">{selfPicked}</span>
          ) : (
            <div className="flex items-center justify-center w-11 h-11 rounded-md bg-purple-50 dark:bg-purple-500/15 border border-purple-200 dark:border-purple-500/30">
              <div className="flex flex-col items-center leading-none">
                <Hand className="w-3.5 h-3.5 text-purple-600 dark:text-purple-300 mb-0.5" />
                <span className="text-base font-bold text-purple-800 dark:text-purple-200">{selfPicked}</span>
              </div>
            </div>
          )}
        </div>

        {/* Col 6: App */}
        <div className="flex items-center justify-center">
          {simple ? (
            <span className={`text-base font-semibold ${appAssigned > 0 ? 'text-foreground' : 'text-muted-foreground/50'}`} title="Assigned by the app (AI)">{appAssigned}</span>
          ) : (
            <div
              className={`flex items-center justify-center w-11 h-11 rounded-md border ${
                appAssigned > 0
                  ? 'bg-sky-50 dark:bg-sky-500/15 border-sky-200 dark:border-sky-500/30'
                  : 'bg-muted/25 border-border/60 opacity-50'
              }`}
              title={appAssigned > 0 ? 'App-assigned tickets' : 'No app-assigned tickets'}
            >
              <div className="flex flex-col items-center leading-none">
                <Bot className={`w-3.5 h-3.5 mb-0.5 ${appAssigned > 0 ? 'text-sky-600 dark:text-sky-300' : 'text-muted-foreground/50'}`} />
                <span className={`text-base font-bold ${appAssigned > 0 ? 'text-sky-800 dark:text-sky-200' : 'text-muted-foreground/50'}`}>{appAssigned}</span>
              </div>
            </div>
          )}
        </div>

        {/* Col 7: Asgn */}
        <div className="flex items-center justify-center">
          {simple ? (
            <span className={`text-base font-semibold ${assigned > 0 ? 'text-foreground' : 'text-muted-foreground/50'}`} title="Assigned by a coordinator">{assigned}</span>
          ) : (
            <div className="flex items-center gap-1" title={`Coordinator-assigned: ${assigned}`}>
              <Send className="w-4 h-4 text-orange-600 dark:text-orange-300" />
              <span className="text-base font-bold text-orange-800 dark:text-orange-200">{assigned}</span>
            </div>
          )}
        </div>

        {/* Col 8: Done */}
        <div className="flex items-center justify-center">
          {simple ? (
            <span className={`text-base font-semibold ${closed > 0 ? 'text-green-700 dark:text-green-200' : 'text-muted-foreground/50'}`} title="Resolved">{closed}</span>
          ) : (
            <div className="flex items-center gap-1" title={`Closed: ${closed}`}>
              <CheckSquare className="w-4 h-4 text-green-600 dark:text-green-300" />
              <span className="text-base font-bold text-green-800 dark:text-green-200">{closed}</span>
            </div>
          )}
        </div>

        {/* Col 9: Rejected (clickable when > 0) */}
        <div className="flex items-center justify-center">
          {rejectedDisplay > 0 ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                navigate(buildBouncedUrl(technician.id, viewMode, selectedDate, selectedWeek, selectedMonth));
              }}
              className="no-row-nav flex items-center gap-1 px-1.5 py-1 rounded hover:bg-red-100 dark:hover:bg-red-500/20 transition-colors cursor-pointer"
              title={
                'Rejected tickets — picked up then put back in queue\n' +
                `Selected ${periodLabel}: ${rejectedDisplay}\n` +
                `Last 7d: ${technician.rejected7d || 0}  ·  Last 30d: ${technician.rejected30d || 0}  ·  Lifetime: ${technician.rejectedLifetime || 0}\n\n` +
                'Click to drill down'
              }
            >
              {!simple && <RotateCcw className="w-4 h-4 text-red-500" />}
              <span className={`text-base ${simple ? 'font-semibold text-red-600 dark:text-red-300' : 'font-bold text-red-700 dark:text-red-200'}`}>{rejectedDisplay}</span>
            </button>
          ) : (
            <div
              className="flex items-center gap-1 opacity-40"
              title={
                `No bounced tickets ${periodLabel}\n` +
                `Last 7d: ${technician.rejected7d || 0}  ·  Last 30d: ${technician.rejected30d || 0}  ·  Lifetime: ${technician.rejectedLifetime || 0}`
              }
            >
              {!simple && <RotateCcw className="w-4 h-4 text-muted-foreground/75" />}
              <span className={`text-base ${simple ? 'font-semibold text-muted-foreground/50' : 'font-bold text-muted-foreground/75'}`}>0</span>
            </div>
          )}
        </div>

        {/* Col 10: CSAT — the AVERAGE on the /5 scale, not the response count
            (QA 07-30 #5: "2" next to a star read as a 2/4 score). */}
        <div className="flex items-center justify-center">
          {hasCSAT ? (
            <div className="flex items-center gap-1" title={csatTooltip}>
              {!simple && <Star className={`w-4 h-4 ${getCSATColor(csatOutOf5)}`} />}
              <span className={`text-base font-bold ${getCSATColor(csatOutOf5)}`}>{csatOutOf5?.toFixed(1)}</span>
              {simple && <span className="text-[10px] text-muted-foreground/75 font-medium">/ 5</span>}
            </div>
          ) : (
            <div className={`flex items-center gap-1 ${simple ? '' : 'opacity-40'}`} title="No CSAT responses in this period">
              {!simple && <Star className="w-4 h-4 text-muted-foreground/75" />}
              <span className={`text-base font-bold ${simple ? 'text-muted-foreground/50' : 'text-muted-foreground/75'}`}>—</span>
            </div>
          )}
        </div>
      </div>

      {/* Expandable ticket details — includes the assigned-by summary that
          used to be its own column (QA 07-30 #4). */}
      {isExpanded && technician.assigners?.length > 0 && (
        <div className="px-3 pt-1.5 pb-0.5 text-[11px] text-muted-foreground border-t border-border/60">
          <span className="font-semibold text-muted-foreground">Assigned by:</span>{' '}
          {technician.assigners.map((a) => `${a.name} (${a.count})`).join(' · ')}
        </div>
      )}
      {isExpanded && (
        <ExpandableTicketList
          activeTickets={activeTickets}
          closedTickets={closedTickets}
          techName={technician.name}
          viewMode={viewMode}
        />
      )}
    </div>
  );
}
