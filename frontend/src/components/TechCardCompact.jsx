import { useNavigate } from 'react-router-dom';
import { EyeOff, Trophy, Star, Hand, Send, CheckSquare, Users, ChevronDown, ChevronUp, Bot, RotateCcw } from 'lucide-react';
import { useState, useCallback, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { getDateStyling, getHolidayTooltip } from '../utils/holidays';
import { getLeaveForDate, getLeaveBadge, getLeaveTooltip, getLeaveDotClass, getLeaveStyle, isHalfDayLeave, getLeaveSplit } from '../utils/leaveInfo';
import { prefetchTechDetail } from '../hooks/usePrefetch';
import ExpandableTicketList, { useGroupedTickets, getTicketsForView } from './ExpandableTicketList';
import { getCompactGridTemplate } from './compactLayout';

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

export default function TechCardCompact({ technician, onHide, rank, selectedDate, selectedWeek, selectedMonth, maxOpenCount = 10, maxDailyCount = 1, viewMode = 'daily', searchTerm = '', selectedCategories = [], forceExpand = null }) {
  const navigate = useNavigate();
  const [showAssignersPopup, setShowAssignersPopup] = useState(false);
  const [assignersPopupPos, setAssignersPopupPos] = useState(null);
  const assignersTriggerRef = useRef(null);
  const [localExpanded, setLocalExpanded] = useState(false);
  const hoverTimerRef = useRef(null);

  // When the assigners popup opens, measure the trigger and stash the
  // viewport-relative position. We render the popup via a Portal at
  // document.body so it escapes the per-row animate-slideInLeft transform
  // (which creates a stacking context that traps z-index, hiding the popup
  // behind the sticky table header).
  useLayoutEffect(() => {
    if (!showAssignersPopup || !assignersTriggerRef.current) return;
    const update = () => {
      const rect = assignersTriggerRef.current?.getBoundingClientRect();
      if (rect) {
        setAssignersPopupPos({ left: rect.left, top: rect.top });
      }
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [showAssignersPopup]);

  // forceExpand (true/false) overrides local state; null = use local
  const isExpanded = forceExpand !== null ? forceExpand : localExpanded;

  // Centralized ticket grouping
  const ticketsForView = getTicketsForView(technician, viewMode);
  const { allTickets, closedTickets } = useGroupedTickets(ticketsForView);
  const hasExpandableTickets = allTickets.length > 0 || closedTickets.length > 0;

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

  const handleToggleExpand = (e) => {
    e.stopPropagation();
    setLocalExpanded(prev => !prev);
  };

  const handleClick = (e) => {
    if (e.target.closest('.hide-button')) return;
    if (e.target.closest('.expand-toggle')) return;
    if (e.target.closest('.expanded-tickets')) return;
    if (e.target.closest('.no-row-nav')) return;

    navigate(`/technician/${technician.id}`, {
      state: {
        selectedDate: selectedDate,
        selectedWeek: selectedWeek,
        viewMode: viewMode,
        searchTerm: searchTerm,
        selectedCategories: selectedCategories,
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

  // CSAT color based on average
  const getCSATColor = (avg) => {
    if (!avg) return 'text-gray-400';
    if (avg >= 3.5) return 'text-green-600';
    if (avg >= 2.5) return 'text-yellow-600';
    if (avg >= 1.5) return 'text-orange-600';
    return 'text-red-600';
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

  // Use "Open" status count for row background color
  const rowBgColor = getRowBackgroundColor(openOnlyCount, maxOpenCount);

  const gridTemplate = getCompactGridTemplate(viewMode);

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
      className={`${rowBgColor} border border-gray-200 rounded-lg hover:shadow-md hover:border-gray-300 transition-all duration-200 cursor-pointer group relative`}
    >
      {/* Hide Button */}
      <button
        onClick={handleHideToggle}
        className="hide-button absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-100 rounded transition-opacity z-10"
        title="Hide technician"
      >
        <EyeOff className="w-3 h-3 text-gray-400" />
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
            hasExpandableTickets ? 'hover:bg-gray-200 cursor-pointer' : 'cursor-default'
          }`}
          title={hasExpandableTickets ? (isExpanded ? 'Collapse tickets' : 'Expand tickets') : undefined}
          tabIndex={hasExpandableTickets ? 0 : -1}
        >
          {hasExpandableTickets ? (
            isExpanded ? (
              <ChevronUp className="w-4 h-4 text-gray-500" />
            ) : (
              <ChevronDown className="w-4 h-4 text-gray-400" />
            )
          ) : (
            <span className="w-4 h-4" />
          )}
        </button>

        {/* Col 2: Avatar + Name + inline pills */}
        <div className="flex items-center gap-2 min-w-0">
          {technician.photoUrl ? (
            <img
              src={technician.photoUrl}
              alt={technician.name}
              className="w-9 h-9 rounded-full object-cover shadow-sm border border-gray-300 flex-shrink-0 transition-all duration-300 ease-in-out hover:scale-150 hover:shadow-2xl hover:z-50"
              onError={(e) => {
                // If the image URL is broken (404, CORS, etc.), hide the broken
                // image so the alt text doesn't leak the technician's name.
                e.currentTarget.style.display = 'none';
              }}
            />
          ) : (
            <div className="flex items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-600 w-9 h-9 shadow-sm border border-blue-400 flex-shrink-0 transition-all duration-300 ease-in-out hover:scale-150 hover:shadow-2xl hover:z-50">
              <span className="text-[11px] font-bold text-white">
                {getInitials(technician.name)}
              </span>
            </div>
          )}

          {isTopPerformer && (
            <div className={`flex items-center justify-center rounded-full w-5 h-5 flex-shrink-0 ${
              rank === 1 ? 'bg-yellow-400' : rank === 2 ? 'bg-gray-300' : 'bg-orange-400'
            }`}>
              {rank === 1 ? (
                <Trophy className="w-3 h-3 text-yellow-900" />
              ) : (
                <Star className={`w-2.5 h-2.5 ${rank === 2 ? 'text-gray-700' : 'text-orange-900'}`} />
              )}
            </div>
          )}

          <span className="font-semibold text-sm text-gray-900 truncate">
            {technician.name}
          </span>

          {highSelfPickRate && (
            <div className="flex items-center gap-0.5 px-1.5 py-0.5 bg-purple-100 rounded-full flex-shrink-0">
              <Star className="w-2 h-2 text-purple-600 fill-purple-600" />
              <span className="text-[8px] text-purple-700 font-semibold">SELF</span>
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
          <div className="flex items-center justify-center gap-1 no-row-nav">
            {(technician.dailyBreakdown || []).map((day, index) => {
              const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
              const colorClass = getTicketColor(day.total, maxDailyCount);

              const dateStyling = getDateStyling(day.date, { variant: 'box' });
              const holidayTooltip = getHolidayTooltip(day.date);
              const isWeekendDay = dateStyling.isWeekend;
              const isHolidayDay = dateStyling.isHoliday;

              const dayLeave = getLeaveForDate(technician.leaveInfo, day.date);
              const leaveTooltip = getLeaveTooltip(dayLeave);
              const leaveDot = getLeaveDotClass(dayLeave);

              const baseTooltip = `${dayNames[index]}: ${day.total} tickets (${day.self} self, ${day.assigned} assigned, ${day.closed} closed)`;
              const tooltipParts = [baseTooltip];
              if (holidayTooltip) tooltipParts.push(holidayTooltip);
              if (leaveTooltip) tooltipParts.push(leaveTooltip);
              const fullTooltip = tooltipParts.join('\n');

              const labelClass = isHolidayDay
                ? dateStyling.isCanadian
                  ? 'text-rose-600 font-bold'
                  : 'text-indigo-500 font-bold'
                : isWeekendDay
                  ? 'text-slate-500 font-semibold'
                  : 'text-gray-500 font-semibold';

              const leaveStyle = dayLeave ? getLeaveStyle(dayLeave.category) : null;
              const dayLeaveIsHalf = isHalfDayLeave(dayLeave);
              const dayLeaveSplit = dayLeaveIsHalf ? getLeaveSplit(dayLeave) : null;

              const containerClass = dayLeave
                ? `${leaveStyle.bgClass} rounded p-0.5`
                : isHolidayDay
                  ? dateStyling.isCanadian
                    ? 'bg-rose-50/50 rounded p-0.5'
                    : 'bg-indigo-50/40 rounded p-0.5'
                  : isWeekendDay
                    ? 'bg-slate-50/50 rounded p-0.5'
                    : '';

              const getBoxClasses = () => {
                if (dayLeave && !dayLeaveIsHalf) {
                  if (day.total === 0) return `${leaveStyle.borderClass} ${leaveStyle.bgClass} ${leaveStyle.textClass}`;
                  return `${leaveStyle.borderClass} ${leaveStyle.badgeBg} ${leaveStyle.badgeText}`;
                }
                if (isHolidayDay) {
                  if (dateStyling.isCanadian) {
                    if (day.total === 0) return 'border-rose-300 bg-rose-50 text-rose-400';
                    return 'border-rose-400 bg-rose-100 text-rose-800';
                  }
                  if (day.total === 0) return 'border-indigo-200 bg-indigo-50 text-indigo-400';
                  return 'border-indigo-300 bg-indigo-100 text-indigo-800';
                }
                if (isWeekendDay) {
                  if (day.total === 0) return 'border-slate-300 bg-slate-50 text-slate-400';
                  return 'border-slate-400 bg-slate-200 text-slate-800';
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
                  },
                });
              };

              return (
                <div
                  key={day.date}
                  className={`flex flex-col items-center cursor-pointer w-[34px] ${containerClass}`}
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
                  <div className={`relative w-7 h-7 rounded flex items-center justify-center text-[10px] font-bold border overflow-hidden transition-all duration-150 hover:scale-125 hover:shadow-lg hover:ring-2 hover:ring-blue-400 hover:ring-offset-1 ${getBoxClasses()}`}>
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
            <div className="text-2xl font-bold text-gray-900 leading-none">{openOnlyCount}</div>
            {pendingCount > 0 && (
              <div className="text-[9px] text-gray-500 mt-0.5">+{pendingCount}p</div>
            )}
          </div>
        )}

        {/* Col 4: Total / Today */}
        <div className="flex items-center justify-center">
          <span className="text-2xl font-bold text-indigo-600 leading-none">{totalTickets}</span>
        </div>

        {/* Col 5: Self */}
        <div className="flex items-center justify-center">
          <div className="flex items-center justify-center w-11 h-11 rounded-md bg-purple-50 border border-purple-200">
            <div className="flex flex-col items-center leading-none">
              <Hand className="w-3.5 h-3.5 text-purple-600 mb-0.5" />
              <span className="text-base font-bold text-purple-800">{selfPicked}</span>
            </div>
          </div>
        </div>

        {/* Col 6: App */}
        <div className="flex items-center justify-center">
          <div
            className={`flex items-center justify-center w-11 h-11 rounded-md border ${
              appAssigned > 0
                ? 'bg-sky-50 border-sky-200'
                : 'bg-slate-50/50 border-slate-100 opacity-50'
            }`}
            title={appAssigned > 0 ? 'App-assigned tickets' : 'No app-assigned tickets'}
          >
            <div className="flex flex-col items-center leading-none">
              <Bot className={`w-3.5 h-3.5 mb-0.5 ${appAssigned > 0 ? 'text-sky-600' : 'text-slate-300'}`} />
              <span className={`text-base font-bold ${appAssigned > 0 ? 'text-sky-800' : 'text-slate-300'}`}>{appAssigned}</span>
            </div>
          </div>
        </div>

        {/* Col 7: Asgn (icon-only column) */}
        <div className="flex items-center justify-center">
          <div className="flex items-center gap-1" title={`Coordinator-assigned: ${assigned}`}>
            <Send className="w-4 h-4 text-orange-600" />
            <span className="text-base font-bold text-orange-800">{assigned}</span>
          </div>
        </div>

        {/* Col 8: Done */}
        <div className="flex items-center justify-center">
          <div className="flex items-center gap-1" title={`Closed: ${closed}`}>
            <CheckSquare className="w-4 h-4 text-green-600" />
            <span className="text-base font-bold text-green-800">{closed}</span>
          </div>
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
              className="no-row-nav flex items-center gap-1 px-1.5 py-1 rounded hover:bg-red-100 transition-colors cursor-pointer"
              title={
                'Rejected tickets — picked up then put back in queue\n' +
                `Selected ${periodLabel}: ${rejectedDisplay}\n` +
                `Last 7d: ${technician.rejected7d || 0}  ·  Last 30d: ${technician.rejected30d || 0}  ·  Lifetime: ${technician.rejectedLifetime || 0}\n\n` +
                'Click to drill down'
              }
            >
              <RotateCcw className="w-4 h-4 text-red-500" />
              <span className="text-base font-bold text-red-700">{rejectedDisplay}</span>
            </button>
          ) : (
            <div
              className="flex items-center gap-1 opacity-40"
              title={
                `No bounced tickets ${periodLabel}\n` +
                `Last 7d: ${technician.rejected7d || 0}  ·  Last 30d: ${technician.rejected30d || 0}  ·  Lifetime: ${technician.rejectedLifetime || 0}`
              }
            >
              <RotateCcw className="w-4 h-4 text-slate-400" />
              <span className="text-base font-bold text-slate-400">0</span>
            </div>
          )}
        </div>

        {/* Col 10: CSAT */}
        <div className="flex items-center justify-center">
          {hasCSAT ? (
            <div className="flex items-center gap-1" title={`Average: ${csatAverage?.toFixed(1)}/4 (${csatCount} responses)`}>
              <Star className={`w-4 h-4 ${getCSATColor(csatAverage)}`} />
              <span className={`text-base font-bold ${getCSATColor(csatAverage)}`}>{csatCount}</span>
            </div>
          ) : (
            <div className="flex items-center gap-1 opacity-40" title="No CSAT responses in this period">
              <Star className="w-4 h-4 text-slate-400" />
              <span className="text-base font-bold text-slate-400">0</span>
            </div>
          )}
        </div>

        {/* Col 11: Assigners (icon + count, hover popup in weekly view) */}
        <div className="flex items-center justify-start relative no-row-nav">
          {viewMode === 'weekly' ? (
            technician.assigners && technician.assigners.length > 0 ? (
              <div
                ref={assignersTriggerRef}
                className="relative"
                onMouseEnter={() => setShowAssignersPopup(true)}
                onMouseLeave={() => setShowAssignersPopup(false)}
              >
                <div className="flex items-center gap-1 px-2 py-0.5 bg-orange-100 rounded-full cursor-help">
                  <Users className="w-3 h-3 text-orange-600" />
                  <span className="text-[10px] font-bold text-orange-800">
                    {technician.assigners.length}
                  </span>
                </div>

                {showAssignersPopup && assignersPopupPos && createPortal(
                  <div
                    className="fixed z-[100] bg-white border-2 border-orange-300 rounded-lg shadow-xl p-2 min-w-[160px] pointer-events-none"
                    style={{
                      // Anchor above the trigger; translateY(-100%) shifts the
                      // popup up by its own height. 8px gap between popup and
                      // trigger via the extra -8.
                      left: assignersPopupPos.left,
                      top: assignersPopupPos.top - 8,
                      transform: 'translateY(-100%)',
                    }}
                  >
                    <div className="text-[8px] text-gray-500 uppercase font-bold mb-1">Assigned by:</div>
                    <div className="space-y-1">
                      {technician.assigners.map((assigner, idx) => (
                        <div key={idx} className="flex items-center justify-between gap-2">
                          <span className="text-[10px] text-gray-700">{assigner.name}</span>
                          <span className="text-[9px] font-bold text-orange-600 bg-orange-100 px-1.5 py-0.5 rounded">
                            {assigner.count}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>,
                  document.body
                )}
              </div>
            ) : (
              <span className="text-[10px] text-gray-300">—</span>
            )
          ) : (
            technician.assigners && technician.assigners.length > 0 ? (
              <div className="flex items-center gap-1 flex-wrap">
                {technician.assigners.slice(0, 2).map((assigner, idx) => {
                  const nameParts = assigner.name.split(' ');
                  const initials = nameParts.map(p => p[0]).join('').substring(0, 2);

                  return (
                    <div
                      key={idx}
                      className="flex items-center gap-0.5 px-1.5 py-0.5 bg-gradient-to-r from-orange-100 to-orange-200 border border-orange-300 rounded-full"
                      title={`${assigner.name}: ${assigner.count}`}
                    >
                      <span className="text-[9px] font-semibold text-orange-800">
                        {initials}
                      </span>
                      <span className="text-[9px] w-3 h-3 font-bold text-orange-600 bg-orange-300 rounded-full flex items-center justify-center">
                        {assigner.count}
                      </span>
                    </div>
                  );
                })}
                {technician.assigners.length > 2 && (
                  <div className="text-[9px] text-gray-500 px-0.5">
                    +{technician.assigners.length - 2}
                  </div>
                )}
              </div>
            ) : (
              <span className="text-[10px] text-gray-300">—</span>
            )
          )}
        </div>
      </div>

      {/* Expandable ticket details */}
      {isExpanded && (
        <ExpandableTicketList
          allTickets={allTickets}
          closedTickets={closedTickets}
          techName={technician.name}
          viewMode={viewMode}
        />
      )}
    </div>
  );
}
