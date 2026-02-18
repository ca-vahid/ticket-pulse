import { useMemo, useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { filterTickets } from '../utils/ticketFilter';
import { getHolidayTooltip, getDateStyling } from '../utils/holidays';

export default function MonthlyCalendar({ monthlyData, selectedMonth, onMonthChange, technicians = [], searchTerm = '', selectedCategories = [], onClearSelections: _onClearSelections }) {
  const [hoveredDayDate, setHoveredDayDate] = useState(null);
  const [clickedDayDate, setClickedDayDate] = useState(null);
  const [selectedTechnicianIds, setSelectedTechnicianIds] = useState([]);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  // Clear technician selections when search/category filters are cleared
  useEffect(() => {
    if (!searchTerm?.trim() && (!selectedCategories || selectedCategories.length === 0) && selectedTechnicianIds.length > 0) {
      setSelectedTechnicianIds([]);
    }
  }, [searchTerm, selectedCategories]);

  const baseDailyBreakdown = monthlyData?.dailyBreakdown || [];
  const monthStart = monthlyData?.monthStart || new Date().toISOString().split('T')[0];
  const daysInMonth = monthlyData?.daysInMonth || 0;

  // Recalculate daily breakdown with filtered tickets if search/filter is active
  const dailyBreakdown = useMemo(() => {
    const hasSearchOrFilter = searchTerm?.trim() || selectedCategories?.length > 0;
    
    if (!hasSearchOrFilter) {
      return baseDailyBreakdown;
    }

    // Recalculate breakdown for each day based on filtered tickets
    return baseDailyBreakdown.map(day => {
      const dayStart = new Date(day.date + 'T00:00:00');
      const dayEnd = new Date(day.date + 'T23:59:59');

      const techniciansForDay = [];

      // Iterate through all technicians to find tickets for this day
      technicians.forEach(tech => {
        // Get all tickets for this tech (now includes all month tickets from backend)
        const allTechTickets = tech.tickets || [];
        
        // First, filter tickets for this specific day (must be within day range)
        const dayTickets = allTechTickets.filter(ticket => {
          if (!ticket) return false;
          const assignDate = ticket.firstAssignedAt 
            ? new Date(ticket.firstAssignedAt)
            : new Date(ticket.createdAt);
          // Ticket must fall within the specific day
          return assignDate >= dayStart && assignDate <= dayEnd;
        });
        
        // Then apply search and category filters to the day's tickets
        const filteredTickets = filterTickets(dayTickets, searchTerm, selectedCategories);

        if (filteredTickets.length > 0) {
          const selfPicked = filteredTickets.filter(t => t.isSelfPicked || t.assignedBy === tech.name).length;
          const assigned = filteredTickets.filter(t => !t.isSelfPicked && t.assignedBy !== tech.name).length;
          const closed = filteredTickets.filter(t => ['Resolved', 'Closed'].includes(t.status)).length;
          const csatCount = filteredTickets.filter(t => t.csatScore !== null).length;

          techniciansForDay.push({
            technicianId: tech.id,
            technicianName: tech.name,
            total: filteredTickets.length,
            selfPicked,
            assigned,
            closed,
            csatCount,
          });
        }
      });

      const dayTotal = techniciansForDay.reduce((sum, t) => sum + t.total, 0);
      const daySelf = techniciansForDay.reduce((sum, t) => sum + t.selfPicked, 0);
      const dayAssigned = techniciansForDay.reduce((sum, t) => sum + t.assigned, 0);
      const dayClosed = techniciansForDay.reduce((sum, t) => sum + t.closed, 0);
      const dayCSAT = techniciansForDay.reduce((sum, t) => sum + (t.csatCount || 0), 0);

      return {
        ...day,
        total: dayTotal,
        selfPicked: daySelf,
        assigned: dayAssigned,
        closed: dayClosed,
        csatCount: dayCSAT,
        technicians: techniciansForDay,
      };
    });
  }, [baseDailyBreakdown, monthStart, technicians, searchTerm, selectedCategories]);

  const monthStartDate = new Date(monthStart + 'T12:00:00');
  const monthName = monthStartDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const weekDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  
  // Convert Sunday-based dayOfWeek (0=Sun, 1=Mon, ..., 6=Sat) to Monday-based (0=Mon, 1=Tue, ..., 6=Sun)
  const convertToMondayBased = (dayOfWeek) => {
    return dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Sunday (0) becomes 6, Monday (1) becomes 0, etc.
  };
  
  const firstDayOfWeek = dailyBreakdown[0] ? convertToMondayBased(dailyBreakdown[0].dayOfWeek) : 0;

  // Build calendar weeks (Mon-Sun)
  const weeks = [];
  let currentWeek = new Array(7).fill(null);
  // Fill in empty days at the start of the first week
  for (let i = 0; i < firstDayOfWeek; i += 1) {
    currentWeek[i] = null;
  }
  dailyBreakdown.forEach((day) => {
    const dayIndex = convertToMondayBased(day.dayOfWeek);
    currentWeek[dayIndex] = day;
    if (dayIndex === 6 || day.dayOfMonth === daysInMonth) {
      weeks.push([...currentWeek]);
      currentWeek = new Array(7).fill(null);
    }
  });

  const handlePrevMonth = () => {
    const prevMonth = new Date(selectedMonth);
    prevMonth.setMonth(prevMonth.getMonth() - 1);
    onMonthChange(prevMonth);
  };

  const handleNextMonth = () => {
    const nextMonth = new Date(selectedMonth);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    onMonthChange(nextMonth);
  };

  const technicianMap = useMemo(() => {
    const map = new Map();
    technicians.forEach((tech) => map.set(tech.id, tech));
    return map;
  }, [technicians]);

  const technicianMonthlyStats = useMemo(() => {
    return technicians
      .filter((tech) =>
        dailyBreakdown.some((day) => day.technicians.some((t) => t.technicianId === tech.id)),
      )
      .map((tech) => {
        let monthlyTotal = 0;
        let monthlySelfPicked = 0;
        let monthlyAssigned = 0;
        let monthlyClosed = 0;
        let monthlyCSAT = 0;

        dailyBreakdown.forEach((day) => {
          const techData = day.technicians.find((t) => t.technicianId === tech.id);
          if (techData) {
            monthlyTotal += techData.total;
            monthlySelfPicked += techData.selfPicked;
            monthlyAssigned += techData.assigned;
            monthlyClosed += techData.closed;
            monthlyCSAT += techData.csatCount || 0;
          }
        });

        return {
          ...tech,
          monthlyTotal,
          monthlySelfPicked,
          monthlyAssigned,
          monthlyClosed,
          monthlyCSAT: tech.monthlyCSATCount || monthlyCSAT, // Prefer backend data
          monthlyCSATAverage: tech.monthlyCSATAverage || null,
        };
      });
  }, [technicians, dailyBreakdown]);

  const selectedSet = useMemo(() => new Set(selectedTechnicianIds), [selectedTechnicianIds]);
  const hasFilter = selectedTechnicianIds.length > 0;

  const sortedTechnicians = useMemo(
    () => [...technicianMonthlyStats].sort((a, b) => b.monthlyTotal - a.monthlyTotal),
    [technicianMonthlyStats],
  );

  const aggregateStats = (techs) => {
    let total = 0;
    let selfPicked = 0;
    let assigned = 0;
    let closed = 0;
    let csatCount = 0;
    techs.forEach((tech) => {
      total += tech.total || 0;
      selfPicked += tech.selfPicked || 0;
      assigned += tech.assigned || 0;
      closed += tech.closed || 0;
      csatCount += tech.csatCount || 0;
    });
    return { total, selfPicked, assigned, closed, csatCount };
  };

  const sidebarWidthClass = isSidebarCollapsed ? 'w-16' : 'w-64';

  return (
    <div className="relative flex gap-4">
      {/* Technician Sidebar */}
      <div className={`${sidebarWidthClass} flex-shrink-0 transition-all duration-300`}>
        <div className="bg-white rounded-2xl shadow h-full flex flex-col">
          <div className="p-4 border-b border-gray-200 flex items-center justify-between">
            {!isSidebarCollapsed && (
              <div>
                <h3 className="font-semibold text-gray-800">Technicians</h3>
                <p className="text-xs text-gray-500 mt-1">{monthName}</p>
              </div>
            )}
            <button
              type="button"
              onClick={() => setIsSidebarCollapsed((prev) => !prev)}
              className="p-2 rounded-xl hover:bg-gray-100 transition-colors"
              aria-label={isSidebarCollapsed ? 'Expand technician panel' : 'Collapse technician panel'}
            >
              {isSidebarCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
            </button>
          </div>

          {sortedTechnicians.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-sm text-gray-500">
              No activity this month
            </div>
          ) : isSidebarCollapsed ? (
            <div className="flex-1 overflow-y-auto py-4 flex flex-col items-center gap-3">
              {sortedTechnicians.map((tech) => {
                const isSelected = selectedSet.has(tech.id);
                return (
                  <button
                    key={tech.id}
                    type="button"
                    onClick={() =>
                      setSelectedTechnicianIds((prev) =>
                        isSelected ? prev.filter((id) => id !== tech.id) : [...prev, tech.id],
                      )
                    }
                    className={`transition-all duration-200 rounded-full ${
                      isSelected ? 'ring-2 ring-blue-400' : ''
                    }`}
                    title={`${tech.name} • ${tech.monthlyTotal} tickets`}
                  >
                    {tech.photoUrl ? (
                      <img
                        src={tech.photoUrl}
                        alt={tech.name}
                        className="w-10 h-10 rounded-full object-cover"
                      />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-gray-300 flex items-center justify-center text-sm font-semibold text-gray-600">
                        {tech.name.charAt(0)}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto px-2 py-3 space-y-1.5">
              {sortedTechnicians.map((tech) => {
                const isSelected = selectedSet.has(tech.id);
                return (
                  <button
                    key={tech.id}
                    type="button"
                    onClick={() =>
                      setSelectedTechnicianIds((prev) =>
                        isSelected ? prev.filter((id) => id !== tech.id) : [...prev, tech.id],
                      )
                    }
                    className={`w-full rounded-2xl border transition-all duration-200 text-left px-2 py-2 ${
                      isSelected
                        ? 'border-blue-300 bg-blue-50/80 shadow-sm'
                        : 'border-transparent bg-gray-50 hover:bg-gray-100'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {tech.photoUrl ? (
                        <img src={tech.photoUrl} alt={tech.name} className="w-8 h-8 rounded-full object-cover flex-shrink-0" />
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-gray-300 flex items-center justify-center text-xs font-semibold text-gray-600 flex-shrink-0">
                          {tech.name.charAt(0)}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-gray-800 truncate">{tech.name}</span>
                          <span className="text-sm font-bold text-gray-700 flex-shrink-0">{tech.monthlyTotal}</span>
                        </div>
                        <div className="mt-1 flex gap-1.5 text-[10px] font-semibold flex-wrap">
                          {tech.monthlySelfPicked > 0 && (
                            <span className="px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700">S:{tech.monthlySelfPicked}</span>
                          )}
                          {tech.monthlyAssigned > 0 && (
                            <span className="px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700">A:{tech.monthlyAssigned}</span>
                          )}
                          {tech.monthlyClosed > 0 && (
                            <span className="px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">C:{tech.monthlyClosed}</span>
                          )}
                          {tech.monthlyCSAT > 0 && (
                            <span 
                              className="px-1.5 py-0.5 rounded-full bg-yellow-100 text-yellow-700"
                              title={tech.monthlyCSATAverage ? `Avg: ${tech.monthlyCSATAverage.toFixed(1)}/4` : undefined}
                            >
                              ⭐{tech.monthlyCSAT}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {!isSidebarCollapsed && (
            <div className="border-t border-gray-200 px-4 py-3 text-xs text-gray-600">
              <h4 className="font-semibold text-gray-700 mb-2">Legend</h4>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-blue-500/80" />
                  <span>Today indicator</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-purple-500/80" />
                  <span>Self-picked</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-orange-500/80" />
                  <span>Assigned</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-green-500/80" />
                  <span>Closed</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-yellow-500 text-sm">⭐</span>
                  <span>CSAT</span>
                </div>
              </div>
              
              {/* Weekend & Holiday Legend */}
              <h4 className="font-semibold text-gray-700 mb-2 mt-4">Calendar</h4>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded bg-slate-200 border border-slate-300" />
                  <span>Weekend</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-rose-500" />
                  <span>Canadian Holiday</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-indigo-400" />
                  <span>US Holiday</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Calendar Section */}
      <div className="flex-1 bg-white rounded-2xl shadow p-4 flex flex-col">
        <div className="flex items-center justify-between px-2 pb-2">
          <button
            type="button"
            onClick={handlePrevMonth}
            className="p-2 rounded-xl hover:bg-gray-100 transition-colors"
            title="Previous month"
          >
            <ChevronLeft className="w-5 h-5 text-gray-600" />
          </button>
          <h2 className="text-2xl font-semibold text-gray-800">{monthName}</h2>
          <button
            type="button"
            onClick={handleNextMonth}
            className="p-2 rounded-xl hover:bg-gray-100 transition-colors"
            title="Next month"
          >
            <ChevronRight className="w-5 h-5 text-gray-600" />
          </button>
        </div>

        <div className="grid grid-cols-7 gap-3 text-[11px] font-semibold px-2 pb-3 uppercase tracking-wide">
          {weekDays.map((day, index) => {
            const isWeekendHeader = index === 5 || index === 6; // Sat = 5, Sun = 6
            return (
              <div 
                key={day} 
                className={`text-center ${isWeekendHeader ? 'text-slate-500 bg-slate-100/50 rounded py-0.5' : 'text-gray-500'}`}
              >
                {day}
              </div>
            );
          })}
        </div>

        <div className="flex-1 space-y-3">
          {weeks.map((week, weekIdx) => (
            <div key={weekIdx} className="grid grid-cols-7 gap-3">
              {week.map((day, dayIdx) => {
                if (!day) {
                  return <div key={dayIdx} className="rounded-3xl border border-dashed border-gray-200 h-40" />;
                }

                const isToday = day.date === new Date().toISOString().split('T')[0];
                const _isActive = clickedDayDate === day.date;
                const dayTechnicians = hasFilter
                  ? day.technicians.filter((t) => selectedSet.has(t.technicianId))
                  : day.technicians;
                const stats = hasFilter
                  ? aggregateStats(dayTechnicians)
                  : {
                    total: day.total,
                    selfPicked: day.selfPicked,
                    assigned: day.assigned,
                    closed: day.closed,
                    csatCount: day.csatCount || 0,
                  };
                
                
                const hasTickets = stats.total > 0;
                const topTechs = hasFilter
                  ? [...dayTechnicians].sort((a, b) => b.total - a.total).slice(0, 3)
                  : [];
                const _maxTicketsForAvatars = topTechs.length > 0 ? Math.max(...topTechs.map((t) => t.total)) : 1;

                const isHovered = hoveredDayDate === day.date;
                
                // Get weekend/holiday styling
                const dateStyling = getDateStyling(day.date, { variant: 'cell' });
                const holidayTooltip = getHolidayTooltip(day.date);
                const isWeekendDay = dateStyling.isWeekend;
                const isHolidayDay = dateStyling.isHoliday;
                
                // Determine background styling based on weekend/holiday
                const getBackgroundClass = () => {
                  if (isHovered) return 'bg-white';
                  if (isHolidayDay) {
                    if (dateStyling.isCanadian) {
                      return hasTickets ? 'bg-gradient-to-br from-rose-50/40 via-rose-50/60 to-rose-50/40' : 'bg-rose-50/30';
                    }
                    return hasTickets ? 'bg-gradient-to-br from-indigo-50/30 via-indigo-50/50 to-indigo-50/30' : 'bg-indigo-50/20';
                  }
                  if (isWeekendDay) {
                    return hasTickets ? 'bg-gradient-to-br from-slate-50/40 via-slate-100/50 to-slate-50/40' : 'bg-slate-50/30';
                  }
                  return hasTickets ? 'bg-gradient-to-br from-white via-blue-50/30 to-white' : 'bg-white';
                };
                
                const getBorderClass = () => {
                  if (isHovered) return 'border-blue-400';
                  if (isHolidayDay) {
                    if (dateStyling.isCanadian) return 'border-rose-200';
                    return 'border-indigo-200';
                  }
                  if (isWeekendDay) return 'border-slate-200';
                  if (hasTickets) return 'border-gray-200 hover:border-blue-300';
                  return 'border-dashed border-gray-200';
                };

                return (
                  <div key={dayIdx} className="relative h-40 w-full" style={{ overflow: 'visible', zIndex: isHovered ? 50 : 1 }}>
                    <button
                      type="button"
                      onMouseEnter={() => hasTickets && setHoveredDayDate(day.date)}
                      onMouseLeave={() => setHoveredDayDate(null)}
                      onClick={() => hasTickets && setClickedDayDate(day.date)}
                      title={holidayTooltip || undefined}
                      className={`absolute rounded-3xl border text-left transition-all duration-300 flex flex-col ${
                        isHovered
                          ? `${getBorderClass()} shadow-2xl shadow-blue-200/50 z-50 ${getBackgroundClass()} ${hasFilter && dayTechnicians.length > 0 ? 'overflow-hidden' : 'overflow-y-auto'}`
                          : hasTickets
                            ? `${getBorderClass()} hover:shadow-lg z-0 inset-0 overflow-hidden ${hasFilter ? 'pb-8 px-4 pt-4' : 'p-4'}`
                            : `${getBorderClass()} text-gray-400 z-0 p-4 inset-0 overflow-hidden`
                      } ${getBackgroundClass()}`}
                      style={isHovered ? { 
                        transform: 'translate(-50%, -50%) scale(1.5)',
                        transformOrigin: 'center center',
                        left: '50%',
                        top: '50%',
                        width: hasFilter && dayTechnicians.length > 0 ? '180px' : '140px',
                        height: hasFilter && dayTechnicians.length > 0 ? (stats.csatCount > 0 ? '240px' : '180px') : 'auto',
                        padding: hasFilter && dayTechnicians.length > 0 ? '0.875rem' : '1.25rem',
                      } : {}}
                    >
                      {/* Day Number - Small square badge top-right */}
                      <div className="absolute top-1.5 right-1.5 z-10 flex items-center gap-1">
                        {/* Holiday indicators */}
                        {isHolidayDay && (
                          <div className="flex items-center gap-0.5">
                            {dateStyling.isCanadian && (
                              <div className={`${isHovered ? 'w-2 h-2' : 'w-1.5 h-1.5'} rounded-full bg-rose-500 shadow-sm`} title="Canadian Holiday" />
                            )}
                            {dateStyling.isUS && !dateStyling.isCanadian && (
                              <div className={`${isHovered ? 'w-2 h-2' : 'w-1.5 h-1.5'} rounded-full bg-indigo-400 shadow-sm`} title="US Holiday" />
                            )}
                            {dateStyling.isUS && dateStyling.isCanadian && (
                              <div className={`${isHovered ? 'w-2 h-2' : 'w-1.5 h-1.5'} rounded-full bg-indigo-400 shadow-sm`} title="US Holiday" />
                            )}
                          </div>
                        )}
                        {/* Weekend indicator (small dot) */}
                        {isWeekendDay && !isHolidayDay && (
                          <div className={`${isHovered ? 'w-1.5 h-1.5' : 'w-1 h-1'} rounded-full bg-slate-400`} title="Weekend" />
                        )}
                        <div className={`flex items-center justify-center rounded ${
                          isToday 
                            ? 'bg-blue-500 text-white font-bold shadow-md' 
                            : isHolidayDay && dateStyling.isCanadian
                              ? 'bg-rose-100 text-rose-700 font-medium'
                              : isHolidayDay
                                ? 'bg-indigo-100 text-indigo-700 font-medium'
                                : isWeekendDay
                                  ? 'bg-slate-200/80 text-slate-600 font-medium'
                                  : 'bg-gray-200/70 text-gray-500 font-medium'
                        } ${isHovered ? 'px-1.5 py-0.5 text-sm' : 'px-1 py-0.5 text-[10px]'} border ${
                          isToday ? 'border-blue-600' : 
                            isHolidayDay && dateStyling.isCanadian ? 'border-rose-300' :
                              isHolidayDay ? 'border-indigo-300' :
                                isWeekendDay ? 'border-slate-300' :
                                  'border-gray-300/50'
                        }`}>
                          {day.dayOfMonth}
                        </div>
                      </div>

                      <div className={`flex items-baseline gap-2 ${isHovered ? (hasFilter && dayTechnicians.length > 0 ? 'mt-1' : 'mt-2') : 'mt-1'}`}>
                        <span className={`font-semibold text-gray-800 ${isHovered ? (hasFilter && dayTechnicians.length > 0 ? 'text-3xl' : 'text-4xl') : 'text-3xl'}`}>{stats.total}</span>
                        {stats.total > 0 && <span className={`text-gray-500 ${isHovered ? (hasFilter && dayTechnicians.length > 0 ? 'text-xs' : 'text-sm') : 'text-xs'}`}>tickets</span>}
                      </div>

                      <div className={`flex flex-col ${isHovered ? 'flex-shrink-0 min-h-0' : 'flex-1'} ${hasFilter && !isHovered ? 'overflow-hidden' : ''}`}>
                        {hasTickets ? (
                          <>
                            {/* Stats Breakdown - Always show in hover */}
                            <div className={`${isHovered ? (hasFilter && dayTechnicians.length > 0 ? 'mb-2 space-y-1 flex-shrink-0' : 'mb-3 space-y-1.5 flex-shrink-0') : hasFilter ? 'pt-2 space-y-1' : 'mt-auto pt-3 space-y-1'}`}>
                              <div className={`${isHovered ? 'space-y-0.5' : 'space-y-0.5'}`}>
                                {isHovered && (
                                  <div className="text-[10px] font-semibold text-purple-700 flex items-center justify-between">
                                    <span>Self</span>
                                    <span>{stats.selfPicked}</span>
                                  </div>
                                )}
                                <div className={`rounded-full bg-gray-100 overflow-hidden ${isHovered ? (hasFilter && dayTechnicians.length > 0 ? 'h-1.5' : 'h-2') : 'h-2'}`}>
                                  <div
                                    className="h-full bg-purple-500/80"
                                    style={{
                                      width: `${stats.total > 0 ? Math.max((stats.selfPicked / stats.total) * 100, 2) : 0}%`,
                                      transition: 'width 200ms ease-out',
                                    }}
                                  />
                                </div>
                              </div>
                              <div className={`${isHovered ? 'space-y-0.5' : 'space-y-0.5'}`}>
                                {isHovered && (
                                  <div className="text-[10px] font-semibold text-orange-700 flex items-center justify-between">
                                    <span>Asgn</span>
                                    <span>{stats.assigned}</span>
                                  </div>
                                )}
                                <div className={`rounded-full bg-gray-100 overflow-hidden ${isHovered ? (hasFilter && dayTechnicians.length > 0 ? 'h-1.5' : 'h-2') : 'h-2'}`}>
                                  <div
                                    className="h-full bg-orange-500/80"
                                    style={{
                                      width: `${stats.total > 0 ? Math.max((stats.assigned / stats.total) * 100, 2) : 0}%`,
                                      transition: 'width 200ms ease-out',
                                    }}
                                  />
                                </div>
                              </div>
                              <div className={`${isHovered ? 'space-y-0.5' : 'space-y-0.5'}`}>
                                {isHovered && (
                                  <div className="text-[10px] font-semibold text-green-700 flex items-center justify-between">
                                    <span>Closed</span>
                                    <span>{stats.closed}</span>
                                  </div>
                                )}
                                <div className={`rounded-full bg-gray-100 overflow-hidden ${isHovered ? (hasFilter && dayTechnicians.length > 0 ? 'h-1.5' : 'h-2') : 'h-2'}`}>
                                  <div
                                    className="h-full bg-green-500/80"
                                    style={{
                                      width: `${stats.total > 0 ? Math.max((stats.closed / stats.total) * 100, 2) : 0}%`,
                                      transition: 'width 200ms ease-out',
                                    }}
                                  />
                                </div>
                              </div>
                              {/* CSAT Indicator - Show differently based on filter state */}
                              {stats.csatCount > 0 && !isHovered && !hasFilter && (
                                <div className="mt-1.5 flex items-center justify-center">
                                  <div className="px-2 py-0.5 rounded-full bg-yellow-100 border border-yellow-300 flex items-center gap-0.5">
                                    <span className="text-yellow-600 text-xs">⭐</span>
                                    <span className="text-[10px] font-bold text-yellow-700">{stats.csatCount}</span>
                                  </div>
                                </div>
                              )}
                              {/* CSAT in filtered view (not hovering) - position at top right to avoid avatar overlap */}
                              {stats.csatCount > 0 && !isHovered && hasFilter && (
                                <div className="absolute top-2 right-2 z-10">
                                  <div className="px-1.5 py-0.5 rounded-full bg-yellow-400 border border-yellow-500 flex items-center gap-0.5 shadow-sm">
                                    <span className="text-xs">⭐</span>
                                    <span className="text-[10px] font-bold text-yellow-900">{stats.csatCount}</span>
                                  </div>
                                </div>
                              )}
                              {/* CSAT when hovered */}
                              {stats.csatCount > 0 && isHovered && (
                                <div className="mt-1.5 pt-1.5 border-t-2 border-yellow-300 bg-yellow-50/50 -mx-3 px-3 py-1 rounded flex-shrink-0">
                                  <div className="text-[11px] font-bold text-yellow-700 flex items-center justify-between">
                                    <span>⭐ CSAT</span>
                                    <span className="text-sm">{stats.csatCount}</span>
                                  </div>
                                </div>
                              )}
                            </div>

                            {/* Technician Details - Only show in hover when filtering */}
                            {hasFilter && isHovered && dayTechnicians.length > 0 && (
                              <div className="mt-1.5 pt-1.5 border-t border-gray-200 flex-shrink-0">
                                <div className="text-[9px] font-semibold text-gray-600 mb-1">Techs ({dayTechnicians.length}):</div>
                                <div className="space-y-1 overflow-hidden">
                                  {dayTechnicians
                                    .sort((a, b) => b.total - a.total)
                                    .slice(0, 3)
                                    .map((tech) => {
                                      const info = technicianMap.get(tech.technicianId);
                                      const initials = tech.technicianName
                                        .split(' ')
                                        .map((part) => part.charAt(0))
                                        .join('')
                                        .slice(0, 2)
                                        .toUpperCase();
                                      return (
                                        <div
                                          key={tech.technicianId}
                                          className="flex items-center gap-1.5 p-1 rounded bg-gray-50"
                                        >
                                          <div className="w-5 h-5 rounded-full border border-white shadow-sm bg-gray-200 flex items-center justify-center text-[9px] font-semibold text-gray-700 overflow-hidden flex-shrink-0">
                                            {info?.photoUrl ? (
                                              <img
                                                src={info.photoUrl}
                                                alt={tech.technicianName}
                                                className="w-full h-full rounded-full object-cover"
                                              />
                                            ) : (
                                              initials
                                            )}
                                          </div>
                                          <div className="flex-1 min-w-0">
                                            <div className="text-[10px] font-semibold text-gray-800 truncate">
                                              {tech.technicianName}
                                            </div>
                                            <div className="flex items-center gap-1 mt-0.5">
                                              <span className="text-[8px] text-purple-700">S:{tech.selfPicked}</span>
                                              <span className="text-[8px] text-orange-700">A:{tech.assigned}</span>
                                              <span className="text-[8px] text-green-700">C:{tech.closed}</span>
                                              {tech.csatCount > 0 && (
                                                <span className="text-[8px] text-yellow-700">⭐{tech.csatCount}</span>
                                              )}
                                              <span className="text-[8px] text-gray-600">T:{tech.total}</span>
                                            </div>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  {dayTechnicians.length > 3 && (
                                    <div className="text-[8px] text-gray-500 text-center pt-0.5">
                                    +{dayTechnicians.length - 3} more
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="mt-auto text-xs text-gray-300">No activity</div>
                        )}
                      </div>
                    
                      {/* Bottom Tech Indicator Line - Only in hover when filtering */}
                      {hasFilter && isHovered && dayTechnicians.length > 0 && (
                        <div className="absolute bottom-0 left-0 right-0 h-5 bg-blue-50/60 border-t border-blue-200 flex items-center gap-1 px-2 rounded-b-3xl">
                          <div className="flex items-center -space-x-1 flex-1 justify-center">
                            {dayTechnicians
                              .sort((a, b) => b.total - a.total)
                              .slice(0, 5)
                              .map((tech) => {
                                const info = technicianMap.get(tech.technicianId);
                                const initials = tech.technicianName
                                  .split(' ')
                                  .map((part) => part.charAt(0))
                                  .join('')
                                  .slice(0, 2)
                                  .toUpperCase();
                                return (
                                  <div
                                    key={tech.technicianId}
                                    className="rounded-full border border-blue-300 shadow-sm bg-white flex items-center justify-center text-[7px] font-semibold text-gray-700 overflow-hidden flex-shrink-0"
                                    style={{ 
                                      width: '14px', 
                                      height: '14px',
                                    }}
                                    title={`${tech.technicianName} • ${tech.total} tickets`}
                                  >
                                    {info?.photoUrl ? (
                                      <img
                                        src={info.photoUrl}
                                        alt={tech.technicianName}
                                        className="w-full h-full rounded-full object-cover"
                                      />
                                    ) : (
                                      initials
                                    )}
                                  </div>
                                );
                              })}
                          </div>
                          {dayTechnicians.length > 5 && (
                            <span className="text-[7px] font-semibold text-blue-700 bg-blue-100 border border-blue-200 rounded-full px-1 py-0.5 whitespace-nowrap flex-shrink-0">
                            +{dayTechnicians.length - 5}
                            </span>
                          )}
                        </div>
                      )}
                    </button>
                    
                    {hasFilter && !isHovered && hasTickets && dayTechnicians.length > 0 && (
                      <div className="absolute bottom-0 left-0 right-0 h-6 bg-blue-50/50 border-t border-blue-200 flex items-center gap-1 px-2">
                        <div className="flex items-center -space-x-1 flex-1 justify-center">
                          {dayTechnicians
                            .sort((a, b) => b.total - a.total)
                            .slice(0, 5)
                            .map((tech) => {
                              const info = technicianMap.get(tech.technicianId);
                              const initials = tech.technicianName
                                .split(' ')
                                .map((part) => part.charAt(0))
                                .join('')
                                .slice(0, 2)
                                .toUpperCase();
                              return (
                                <div
                                  key={tech.technicianId}
                                  className="rounded-full border border-blue-300 shadow-sm bg-white flex items-center justify-center text-[8px] font-semibold text-gray-700 overflow-hidden flex-shrink-0"
                                  style={{ 
                                    width: '16px', 
                                    height: '16px',
                                  }}
                                  title={`${tech.technicianName} • ${tech.total} tickets`}
                                >
                                  {info?.photoUrl ? (
                                    <img
                                      src={info.photoUrl}
                                      alt={tech.technicianName}
                                      className="w-full h-full rounded-full object-cover"
                                    />
                                  ) : (
                                    initials
                                  )}
                                </div>
                              );
                            })}
                        </div>
                        {dayTechnicians.length > 5 && (
                          <span className="text-[8px] font-semibold text-blue-700 bg-blue-100 border border-blue-200 rounded-full px-1 py-0.5 whitespace-nowrap flex-shrink-0">
                            +{dayTechnicians.length - 5}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Click Modal */}
      {clickedDayDate && (() => {
        const clickedDay = dailyBreakdown.find((day) => day.date === clickedDayDate);
        if (!clickedDay) return null;

        const overlayTechnicians = hasFilter
          ? clickedDay.technicians.filter((tech) => selectedSet.has(tech.technicianId))
          : clickedDay.technicians;
        const overlayStats = hasFilter
          ? aggregateStats(overlayTechnicians)
          : {
            total: clickedDay.total,
            selfPicked: clickedDay.selfPicked,
            assigned: clickedDay.assigned,
            closed: clickedDay.closed,
          };

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-in fade-in duration-200">
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setClickedDayDate(null)} />
            <div className="relative w-full max-w-4xl bg-gradient-to-br from-white to-gray-50 rounded-3xl shadow-2xl overflow-hidden animate-in zoom-in duration-200">
              <button
                type="button"
                onClick={() => setClickedDayDate(null)}
                className="absolute top-6 right-6 p-2 rounded-full bg-white/80 hover:bg-white shadow-sm transition-colors z-10"
                aria-label="Close day details"
              >
                <X className="w-5 h-5 text-gray-600" />
              </button>

              {/* Header */}
              <div className="bg-gradient-to-r from-blue-600 to-purple-600 px-8 py-6 text-white">
                <p className="text-sm opacity-90 mb-1">Day Overview</p>
                <h3 className="text-3xl font-bold">
                  {new Date(clickedDay.date + 'T12:00:00').toLocaleDateString('en-US', {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </h3>
                <div className="flex items-center gap-3 text-sm font-semibold mt-4">
                  <span className="px-4 py-1.5 rounded-full bg-white/20 backdrop-blur-sm border border-white/30">
                    Total {overlayStats.total}
                  </span>
                  <span className="px-4 py-1.5 rounded-full bg-purple-500/30 backdrop-blur-sm border border-white/30">
                    Self {overlayStats.selfPicked}
                  </span>
                  <span className="px-4 py-1.5 rounded-full bg-orange-500/30 backdrop-blur-sm border border-white/30">
                    Assigned {overlayStats.assigned}
                  </span>
                  <span className="px-4 py-1.5 rounded-full bg-green-500/30 backdrop-blur-sm border border-white/30">
                    Closed {overlayStats.closed}
                  </span>
                  {overlayStats.csatCount > 0 && (
                    <span className="px-4 py-1.5 rounded-full bg-yellow-400/30 backdrop-blur-sm border border-yellow-300/50">
                      ⭐ CSAT {overlayStats.csatCount}
                    </span>
                  )}
                </div>
              </div>

              {/* Content */}
              <div className="p-8">

                {overlayTechnicians.length === 0 ? (
                  <div className="py-16 text-center text-gray-400">
                    <p className="text-lg">No technician activity for this selection</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 max-h-[500px] overflow-y-auto pr-2">
                    {overlayTechnicians
                      .sort((a, b) => b.total - a.total)
                      .map((tech) => {
                        const info = technicianMap.get(tech.technicianId);
                        const initials = tech.technicianName
                          .split(' ')
                          .map((part) => part.charAt(0))
                          .join('')
                          .slice(0, 2)
                          .toUpperCase();
                        return (
                          <div
                            key={tech.technicianId}
                            className="group rounded-3xl border border-gray-200 bg-white p-5 hover:border-blue-300 hover:shadow-lg transition-all duration-200"
                          >
                            <div className="flex flex-col items-center text-center gap-3">
                              {info?.photoUrl ? (
                                <img
                                  src={info.photoUrl}
                                  alt={tech.technicianName}
                                  className="w-16 h-16 rounded-full object-cover border-4 border-white shadow-md"
                                />
                              ) : (
                                <div className="w-16 h-16 rounded-full bg-gradient-to-br from-gray-200 to-gray-300 flex items-center justify-center text-xl font-bold text-gray-700 border-4 border-white shadow-md">
                                  {initials}
                                </div>
                              )}
                              <div className="w-full">
                                <h4 className="font-bold text-gray-800 mb-1">{tech.technicianName}</h4>
                                <div className="text-2xl font-bold text-gray-900 mb-3">{tech.total}</div>
                                <div className="flex flex-col gap-1.5 text-xs font-semibold">
                                  {tech.selfPicked > 0 && (
                                    <div className="flex items-center justify-between px-3 py-1.5 rounded-full bg-purple-50 text-purple-700">
                                      <span>Self-picked</span>
                                      <span className="font-bold">{tech.selfPicked}</span>
                                    </div>
                                  )}
                                  {tech.assigned > 0 && (
                                    <div className="flex items-center justify-between px-3 py-1.5 rounded-full bg-orange-50 text-orange-700">
                                      <span>Assigned</span>
                                      <span className="font-bold">{tech.assigned}</span>
                                    </div>
                                  )}
                                  {tech.closed > 0 && (
                                    <div className="flex items-center justify-between px-3 py-1.5 rounded-full bg-green-50 text-green-700">
                                      <span>Closed</span>
                                      <span className="font-bold">{tech.closed}</span>
                                    </div>
                                  )}
                                  {tech.csatCount > 0 && (
                                    <div className="flex items-center justify-between px-3 py-1.5 rounded-full bg-yellow-50 text-yellow-700">
                                      <span>⭐ CSAT</span>
                                      <span className="font-bold">{tech.csatCount}</span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

