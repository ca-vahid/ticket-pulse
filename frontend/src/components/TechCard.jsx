import { useNavigate } from 'react-router-dom';
import { EyeOff, Trophy, Star, Hand, Send, CheckSquare, Users } from 'lucide-react';
import { useState } from 'react';
import { getDateStyling, getHolidayTooltip } from '../utils/holidays';

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

export default function TechCard({ technician, onHide, rank, selectedDate, selectedWeek, maxOpenCount = 10, maxDailyCount = 1, viewMode = 'daily', searchTerm = '', selectedCategories = [] }) {
  const navigate = useNavigate();
  const [showAssignersPopup, setShowAssignersPopup] = useState(false);

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

  const handleClick = (e) => {
    // Don't navigate if clicking the hide button
    if (e.target.closest('.hide-button')) return;

    // Pass the selected date/week, view mode, and filters to the technician detail page
    navigate(`/technician/${technician.id}`, {
      state: {
        selectedDate: selectedDate,
        selectedWeek: selectedWeek,
        viewMode: viewMode,
        searchTerm: searchTerm,
        selectedCategories: selectedCategories,
      },
    });
  };

  const handleHideToggle = (e) => {
    e.stopPropagation();
    if (onHide) onHide(technician.id);
  };

  const isTopPerformer = rank && rank <= 3;

  // Use appropriate fields based on view mode
  const totalTickets = viewMode === 'weekly'
    ? (technician.weeklyTotalCreated || 0)
    : (technician.totalTicketsToday || 0);
  const selfPicked = viewMode === 'weekly'
    ? (technician.weeklySelfPicked || 0)
    : (technician.selfPickedToday || 0);
  const assigned = viewMode === 'weekly'
    ? (technician.weeklyAssigned || 0)
    : (technician.assignedToday || 0);
  const closed = viewMode === 'weekly'
    ? (technician.weeklyClosed || 0)
    : (technician.closedToday || 0);

  // CSAT data
  const csatCount = viewMode === 'weekly'
    ? (technician.weeklyCSATCount || 0)
    : (technician.csatCount || 0);
  const csatAverage = viewMode === 'weekly'
    ? technician.weeklyCSATAverage
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

  // Get ticket counts - prioritize "Open" status (most important)
  // FreshService statuses: Open (active work), Pending (waiting/less urgent), Resolved, Closed
  const openOnlyCount = technician.openOnlyCount || 0;
  const pendingCount = technician.pendingCount || 0;
  const _totalOpenCount = technician.openTicketCount || 0; // Open + Pending combined

  // Use "Open" status count for card background color (most important metric)
  const cardBgColor = getCardBackgroundColor(openOnlyCount, maxOpenCount);

  return (
    <div
      onClick={handleClick}
      className={`${cardBgColor} border border-gray-200 rounded-lg shadow-sm hover:shadow-xl transition-all duration-300 cursor-pointer group relative overflow-hidden`}
    >
      {/* Hide Button - Top Right */}
      <button
        onClick={handleHideToggle}
        className="hide-button absolute top-2 right-2 opacity-0 group-hover:opacity-100 p-1.5 hover:bg-gray-100 rounded-lg transition-opacity z-10"
        title="Hide technician"
      >
        <EyeOff className="w-4 h-4 text-gray-400" />
      </button>

      {/* Card Content */}
      <div className="p-4">
        {/* Header: Photo + Name + Badges */}
        <div className="flex items-start gap-3 mb-4">
          {/* Profile Photo or Initials Circle */}
          {technician.photoUrl ? (
            <img
              src={technician.photoUrl}
              alt={technician.name}
              className="w-20 h-20 rounded-full object-cover shadow-lg border-2 border-gray-300 transition-all duration-500 ease-in-out hover:scale-150 hover:shadow-2xl hover:z-50 cursor-pointer"
            />
          ) : (
            <div className="flex items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-600 w-20 h-20 shadow-lg border-2 border-blue-400 transition-all duration-500 ease-in-out hover:scale-150 hover:shadow-2xl hover:z-50 cursor-pointer">
              <span className="text-xl font-bold text-white">
                {getInitials(technician.name)}
              </span>
            </div>
          )}

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

              {/* Name */}
              <h3 className="font-semibold text-lg text-gray-900 truncate">
                {technician.name}
              </h3>

              {/* Self-Starter Badge */}
              {highSelfPickRate && (
                <div className="flex items-center gap-1 px-2 py-1 bg-purple-100 rounded-full">
                  <Star className="w-3 h-3 text-purple-600 fill-purple-600" />
                  <span className="text-[9px] text-purple-700 font-semibold">SELF</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Weekly Breakdown Mini-Calendar - Only show in weekly view */}
        {viewMode === 'weekly' && technician.dailyBreakdown && (
          <div className="mb-3 pb-3 border-b border-gray-200">
            <div className="flex items-center justify-center gap-1">
              {technician.dailyBreakdown.map((day, index) => {
                const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
                const colorClass = getTicketColor(day.total, maxDailyCount);
                
                // Get weekend/holiday styling
                const dateStyling = getDateStyling(day.date, { variant: 'box' });
                const holidayTooltip = getHolidayTooltip(day.date);
                const isWeekendDay = dateStyling.isWeekend;
                const isHolidayDay = dateStyling.isHoliday;
                
                // Build tooltip
                const baseTooltip = `${dayNames[index]}: ${day.total} tickets (${day.self} self, ${day.assigned} assigned, ${day.closed} closed)`;
                const fullTooltip = holidayTooltip ? `${baseTooltip}\n${holidayTooltip}` : baseTooltip;
                
                // Determine label styling
                const labelClass = isHolidayDay 
                  ? dateStyling.isCanadian 
                    ? 'text-rose-600 font-bold' 
                    : 'text-indigo-500 font-bold'
                  : isWeekendDay 
                    ? 'text-slate-500 font-semibold' 
                    : 'text-gray-500 font-semibold';
                
                // Container styling for weekend/holiday
                const containerClass = isHolidayDay
                  ? dateStyling.isCanadian
                    ? 'bg-rose-50/50 rounded-lg p-0.5'
                    : 'bg-indigo-50/40 rounded-lg p-0.5'
                  : isWeekendDay
                    ? 'bg-slate-50/50 rounded-lg p-0.5'
                    : '';

                // Determine box styling - holidays/weekends override normal colors
                const getBoxClasses = () => {
                  if (isHolidayDay) {
                    if (dateStyling.isCanadian) {
                      if (day.total === 0) {
                        return 'border-rose-300 bg-rose-50 text-rose-400';
                      }
                      // Has tickets on Canadian holiday - use rose-themed colors
                      return 'border-rose-400 bg-rose-100 text-rose-800';
                    }
                    // US holiday
                    if (day.total === 0) {
                      return 'border-indigo-200 bg-indigo-50 text-indigo-400';
                    }
                    return 'border-indigo-300 bg-indigo-100 text-indigo-800';
                  }
                  if (isWeekendDay) {
                    if (day.total === 0) {
                      return 'border-slate-300 bg-slate-50 text-slate-400';
                    }
                    // Has tickets on weekend - use slate-themed colors
                    return 'border-slate-400 bg-slate-200 text-slate-800';
                  }
                  // Normal day - use the ticket color
                  return colorClass;
                };

                return (
                  <div
                    key={day.date}
                    className={`flex flex-col items-center ${containerClass}`}
                    title={fullTooltip}
                  >
                    <div className="flex items-center gap-0.5">
                      {isHolidayDay && (
                        <div className={`w-1 h-1 rounded-full ${dateStyling.isCanadian ? 'bg-rose-500' : 'bg-indigo-400'}`} />
                      )}
                      <div className={`text-[8px] ${labelClass} mb-0.5`}>{dayNames[index]}</div>
                    </div>
                    <div className={`w-8 h-8 rounded flex items-center justify-center text-[10px] font-bold border ${getBoxClasses()}`}>
                      {day.total}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Ticket Status Display */}
        <div className="mb-3 py-3 border-b border-gray-200">
          <div className="flex items-center justify-center gap-6">
            {/* Open Count - Only show in daily view */}
            {viewMode === 'daily' && (
              <div className="text-center">
                <div className="text-5xl font-bold text-gray-900 leading-none">{openOnlyCount}</div>
                <div className="text-xs text-gray-700 uppercase font-bold mt-1">Open</div>
                {pendingCount > 0 && (
                  <div className="text-xs text-gray-500 font-medium mt-0.5">
                    ({pendingCount} pend)
                  </div>
                )}
              </div>
            )}

            {/* Today/Week Count */}
            <div className="text-center">
              <div className="text-3xl font-bold text-blue-600 leading-none">+{totalTickets}</div>
              <div className="text-xs text-blue-700 uppercase font-bold mt-1">
                {viewMode === 'weekly' ? 'Week' : 'Today'}
              </div>
            </div>
          </div>
        </div>

        {/* Metrics Grid - Icons + Numbers (3-4 columns based on CSAT presence) */}
        <div className={`grid ${hasCSAT ? 'grid-cols-4' : 'grid-cols-3'} gap-2 mb-2`}>

          {/* Self */}
          <div className="flex flex-col items-center p-2 bg-purple-100 rounded-lg shadow-sm border border-purple-200">
            <Hand className="w-5 h-5 text-purple-700 mb-1" />
            <div className="text-lg font-bold text-purple-900">{selfPicked}</div>
            <div className="text-[9px] text-purple-700 uppercase font-bold">Self</div>
          </div>

          {/* Assigned */}
          <div className="flex flex-col items-center p-2">
            <Send className="w-5 h-5 text-orange-600 mb-1" />
            <div className="text-lg font-bold text-orange-800">{assigned}</div>
            <div className="text-[9px] text-orange-600 uppercase font-medium">Asgn</div>
          </div>

          {/* Done */}
          <div className="flex flex-col items-center p-2">
            <CheckSquare className="w-5 h-5 text-green-600 mb-1" />
            <div className="text-lg font-bold text-green-800">{closed}</div>
            <div className="text-[9px] text-green-600 uppercase font-medium">Done</div>
          </div>

          {/* CSAT - Only show if there are CSAT responses */}
          {hasCSAT && (
            <div className="flex flex-col items-center p-2 bg-yellow-50 rounded-lg shadow-sm border border-yellow-200" title={`Average: ${csatAverage?.toFixed(1)}/4`}>
              <Star className={`w-5 h-5 ${getCSATColor(csatAverage)} mb-1`} />
              <div className={`text-lg font-bold ${getCSATColor(csatAverage)}`}>{csatCount}</div>
              <div className="text-[9px] text-yellow-700 uppercase font-bold">CSAT</div>
            </div>
          )}
        </div>

        {/* Assigners Badges / Popup */}
        {viewMode === 'weekly' ? (
          // Weekly view: Show icon with popup on hover
          technician.assigners && technician.assigners.length > 0 && (
            <div className="mt-1 relative">
              <div
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-orange-100 rounded-lg cursor-help"
                onMouseEnter={() => setShowAssignersPopup(true)}
                onMouseLeave={() => setShowAssignersPopup(false)}
              >
                <Users className="w-4 h-4 text-orange-600" />
                <span className="text-[10px] font-bold text-orange-800">
                  {technician.assigners.length} Assigner{technician.assigners.length !== 1 ? 's' : ''}
                </span>
              </div>

              {/* Popup */}
              {showAssignersPopup && (
                <div className="absolute bottom-full left-0 mb-2 z-50 bg-white border-2 border-orange-300 rounded-lg shadow-xl p-3 min-w-[180px]">
                  <div className="text-[9px] text-gray-500 uppercase font-bold mb-2">Assigned by:</div>
                  <div className="space-y-1.5">
                    {technician.assigners.map((assigner, idx) => (
                      <div key={idx} className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-gray-700">{assigner.name}</span>
                        <span className="text-[10px] font-bold text-orange-600 bg-orange-100 px-2 py-0.5 rounded">
                          {assigner.count}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        ) : (
          // Daily view: Show badges as before
          technician.assigners && technician.assigners.length > 0 && (
            <div className="mt-1">
              <div className="text-[9px] text-gray-500 uppercase font-medium mb-1">Assigned by:</div>
              <div className="flex flex-wrap gap-1">
                {technician.assigners.slice(0, 3).map((assigner, idx) => {
                  // Get first name or initials
                  const nameParts = assigner.name.split(' ');
                  const firstName = nameParts[0];
                  const initials = nameParts.map(p => p[0]).join('').substring(0, 2);
                  const displayName = firstName.length <= 8 ? firstName : initials;

                  return (
                    <div
                      key={idx}
                      className="flex items-center gap-1 px-2 py-0.5 bg-gradient-to-r from-orange-100 to-orange-200 border border-orange-300 rounded-full shadow-sm"
                    >
                      <span className="text-[10px] font-semibold text-orange-800">
                        {displayName}
                      </span>
                      <span className="text-[10px] w-4 h-4 font-bold text-orange-600 bg-orange-300 rounded-full flex items-center justify-center">
                        {assigner.count}
                      </span>
                    </div>
                  );
                })}
                {technician.assigners.length > 3 && (
                  <div className="text-[10px] text-gray-500 px-2 py-0.5">
                    +{technician.assigners.length - 3} more
                  </div>
                )}
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}
