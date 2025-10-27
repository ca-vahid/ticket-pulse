import { useNavigate } from 'react-router-dom';
import { EyeOff, Trophy, Star, Hand, Send, CheckSquare, Users } from 'lucide-react';
import { useState } from 'react';

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

export default function TechCardCompact({ technician, onHide, rank, selectedDate, selectedWeek, maxOpenCount = 10, maxDailyCount = 1, viewMode = 'daily' }) {
  const navigate = useNavigate();
  const [showAssignersPopup, setShowAssignersPopup] = useState(false);

  // Helper to format date as YYYY-MM-DD
  const formatDateLocal = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

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

    // Pass the selected date/week and view mode to the technician detail page
    navigate(`/technician/${technician.id}`, {
      state: {
        selectedDate: selectedDate,
        selectedWeek: selectedWeek,
        viewMode: viewMode
      }
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

  const highSelfPickRate = selfPicked >= 3;

  // Get ticket counts
  const openOnlyCount = technician.openOnlyCount || 0;
  const pendingCount = technician.pendingCount || 0;

  // Use "Open" status count for row background color
  const rowBgColor = getRowBackgroundColor(openOnlyCount, maxOpenCount);

  return (
    <div
      onClick={handleClick}
      className={`${rowBgColor} border border-gray-200 rounded-lg shadow-sm hover:shadow-lg transition-all duration-300 cursor-pointer group relative px-4 py-3 flex items-center gap-4`}
    >
      {/* Hide Button */}
      <button
        onClick={handleHideToggle}
        className="hide-button absolute top-2 right-2 opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-100 rounded transition-opacity z-10"
        title="Hide technician"
      >
        <EyeOff className="w-3 h-3 text-gray-400" />
      </button>

      {/* Profile Photo */}
      <div className="flex-shrink-0">
        {technician.photoUrl ? (
          <img
            src={technician.photoUrl}
            alt={technician.name}
            className="w-10 h-10 rounded-full object-cover shadow-md border border-gray-300 transition-all duration-500 ease-in-out hover:scale-150 hover:shadow-2xl hover:z-50 cursor-pointer"
          />
        ) : (
          <div className="flex items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-600 w-10 h-10 shadow-md border border-blue-400 transition-all duration-500 ease-in-out hover:scale-150 hover:shadow-2xl hover:z-50 cursor-pointer">
            <span className="text-xs font-bold text-white">
              {getInitials(technician.name)}
            </span>
          </div>
        )}
      </div>

      {/* Name + Badges */}
      <div className="flex items-center gap-2 w-[200px] flex-shrink-0">
        {/* Rank Badge */}
        {isTopPerformer && (
          <div className={`
            flex items-center justify-center rounded-full w-5 h-5 flex-shrink-0
            ${rank === 1 ? 'bg-yellow-400' : rank === 2 ? 'bg-gray-300' : 'bg-orange-400'}
          `}>
            {rank === 1 ? (
              <Trophy className="w-3 h-3 text-yellow-900" />
            ) : (
              <Star className={`w-2.5 h-2.5 ${rank === 2 ? 'text-gray-700' : 'text-orange-900'}`} />
            )}
          </div>
        )}

        {/* Name */}
        <span className="font-semibold text-sm text-gray-900 truncate flex-1">
          {technician.name}
        </span>

        {/* Self-Starter Badge */}
        {highSelfPickRate && (
          <div className="flex items-center gap-0.5 px-1.5 py-0.5 bg-purple-100 rounded-full flex-shrink-0">
            <Star className="w-2 h-2 text-purple-600 fill-purple-600" />
            <span className="text-[8px] text-purple-700 font-semibold">SELF</span>
          </div>
        )}
      </div>

      {/* Weekly Breakdown Mini-Calendar - Only show in weekly view */}
      {viewMode === 'weekly' && technician.dailyBreakdown && (
        <div className="flex items-center gap-1 ml-4">
          {technician.dailyBreakdown.map((day, index) => {
            const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
            const colorClass = getTicketColor(day.total, maxDailyCount);

            return (
              <div
                key={day.date}
                className="flex flex-col items-center"
                title={`${dayNames[index]}: ${day.total} tickets (${day.self} self, ${day.assigned} assigned, ${day.closed} closed)`}
              >
                <div className="text-[8px] text-gray-500 font-semibold mb-0.5">{dayNames[index]}</div>
                <div className={`w-8 h-8 rounded flex items-center justify-center text-[10px] font-bold border ${colorClass}`}>
                  {day.total}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Open Count - Only show in daily view */}
      {viewMode === 'daily' && (
        <div className="flex items-center justify-center gap-1 w-[80px] flex-shrink-0">
          <div className="text-center">
            <div className="text-2xl font-bold text-gray-900 leading-none">{openOnlyCount}</div>
            <div className="text-[8px] text-gray-600 uppercase font-bold">Open</div>
          </div>
          {pendingCount > 0 && (
            <div className="text-[9px] text-gray-500">
              ({pendingCount}p)
            </div>
          )}
        </div>
      )}

      {/* Today/Week Count */}
      <div className="flex items-center justify-center gap-1 w-[70px] flex-shrink-0">
        <div className="text-xl font-bold text-blue-600 leading-none">+{totalTickets}</div>
        <div className="text-[8px] text-blue-600 uppercase font-bold">{viewMode === 'weekly' ? 'Week' : 'Today'}</div>
      </div>

      {/* Metrics - Self, Assigned, Done */}
      <div className="flex items-center gap-3 ml-auto">
        {/* Self */}
        <div className="flex flex-col items-center justify-center px-3 py-1.5 bg-purple-100 rounded border border-purple-200 w-[50px] h-[60px]">
          <Hand className="w-4 h-4 text-purple-700 mb-1" />
          <div className="text-base font-bold text-purple-900">{selfPicked}</div>
          <div className="text-[7px] text-purple-700 uppercase font-bold">Self</div>
        </div>

        {/* Assigned */}
        <div className="flex flex-col items-center justify-center w-[45px] h-[60px]">
          <Send className="w-4 h-4 text-orange-600 mb-1" />
          <div className="text-base font-bold text-orange-800">{assigned}</div>
          <div className="text-[7px] text-orange-600 uppercase font-medium">Asgn</div>
        </div>

        {/* Done */}
        <div className="flex flex-col items-center justify-center w-[45px] h-[60px]">
          <CheckSquare className="w-4 h-4 text-green-600 mb-1" />
          <div className="text-base font-bold text-green-800">{closed}</div>
          <div className="text-[7px] text-green-600 uppercase font-medium">Done</div>
        </div>
      </div>

      {/* Assigners Badges / Popup */}
      <div className="flex items-center gap-1 ml-2 w-[120px] flex-shrink-0 relative">
        {viewMode === 'weekly' ? (
          // Weekly view: Show icon with popup on hover
          technician.assigners && technician.assigners.length > 0 ? (
            <div
              className="relative"
              onMouseEnter={() => setShowAssignersPopup(true)}
              onMouseLeave={() => setShowAssignersPopup(false)}
            >
              <div className="flex items-center gap-1 px-2 py-1 bg-orange-100 rounded-full cursor-help">
                <Users className="w-3 h-3 text-orange-600" />
                <span className="text-[9px] font-bold text-orange-800">
                  {technician.assigners.length}
                </span>
              </div>

              {/* Popup */}
              {showAssignersPopup && (
                <div className="absolute bottom-full left-0 mb-2 z-50 bg-white border-2 border-orange-300 rounded-lg shadow-xl p-2 min-w-[150px]">
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
                </div>
              )}
            </div>
          ) : (
            <div className="text-[9px] text-gray-400">—</div>
          )
        ) : (
          // Daily view: Show badges as before
          technician.assigners && technician.assigners.length > 0 ? (
            <>
              {technician.assigners.slice(0, 2).map((assigner, idx) => {
                const nameParts = assigner.name.split(' ');
                const initials = nameParts.map(p => p[0]).join('').substring(0, 2);

                return (
                  <div
                    key={idx}
                    className="flex items-center gap-0.5 px-1.5 py-0.5 bg-gradient-to-r from-orange-100 to-orange-200 border border-orange-300 rounded-full shadow-sm"
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
                <div className="text-[9px] text-gray-500 px-1">
                  +{technician.assigners.length - 2}
                </div>
              )}
            </>
          ) : (
            <div className="text-[9px] text-gray-400">—</div>
          )
        )}
      </div>
    </div>
  );
}
