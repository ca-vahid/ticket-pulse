import { ArrowLeft, MapPin, Clock, ChevronLeft, ChevronRight } from 'lucide-react';
import ExportButton from '../ExportButton';
import { getInitials, formatDateLocal } from './utils';

export default function TechDetailHeader({
  technician,
  viewMode,
  setViewMode,
  selectedDate,
  setSelectedDate,
  selectedWeek,
  setSelectedWeek,
  allTickets,
  onBack,
  onPrevious,
  onNext,
  onToday,
  onDateChange,
  isToday,
  isCurrentWeek,
}) {
  const weekDisplayLabel = (() => {
    const ws = technician.weekStart
      ? new Date(technician.weekStart + 'T12:00:00')
      : selectedWeek
        ? new Date(selectedWeek)
        : null;
    if (!ws) return 'Loading…';
    const we = technician.weekEnd
      ? new Date(technician.weekEnd + 'T12:00:00')
      : (() => { const d = new Date(ws); d.setDate(d.getDate() + 6); return d; })();
    return `${ws.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${we.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  })();

  const handleSwitchToDaily = () => {
    if (viewMode === 'weekly' && selectedWeek) {
      setSelectedDate(formatDateLocal(new Date(selectedWeek)));
    }
    setViewMode('daily');
  };

  const handleSwitchToWeekly = () => {
    if (viewMode !== 'weekly') {
      const dateToUse = selectedDate ? new Date(selectedDate + 'T12:00:00') : new Date();
      const day = (dateToUse.getDay() + 6) % 7;
      const monday = new Date(dateToUse);
      monday.setDate(dateToUse.getDate() - day);
      monday.setHours(0, 0, 0, 0);
      setSelectedWeek(monday);
    }
    setViewMode('weekly');
  };

  const location = technician.location ||
    (technician.timezone ? technician.timezone.split('/').pop().replace(/_/g, ' ') : null);
  const timezone = technician.timezone ? technician.timezone.replace(/_/g, ' ') : null;
  const hasSchedule = technician.workStartTime || technician.workEndTime;

  return (
    <header className="bg-white border-b border-slate-200 sticky top-0 z-10 shadow-sm">
      <div className="max-w-7xl mx-auto px-6 py-3">
        {/* Single row layout */}
        <div className="flex items-center gap-4">
          {/* Back button */}
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-slate-500 hover:text-slate-800 transition-colors flex-shrink-0 text-sm font-medium"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>

          <div className="w-px h-6 bg-slate-200 flex-shrink-0" />

          {/* Identity */}
          <div className="flex items-center gap-3 min-w-0 flex-1">
            {technician.photoUrl ? (
              <img
                src={technician.photoUrl}
                alt={technician.name}
                className="w-10 h-10 rounded-full object-cover border border-slate-200 flex-shrink-0"
              />
            ) : (
              <div className="flex items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-700 w-10 h-10 flex-shrink-0">
                <span className="text-sm font-bold text-white">{getInitials(technician.name)}</span>
              </div>
            )}
            <div className="min-w-0">
              <h1 className="text-base font-bold text-slate-900 leading-tight">{technician.name}</h1>
              <div className="flex items-center gap-2 text-xs text-slate-400 mt-0.5 flex-wrap">
                {location && (
                  <span className="flex items-center gap-1">
                    <MapPin className="w-3 h-3" />
                    {location}
                  </span>
                )}
                {timezone && (
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {timezone}
                    {hasSchedule && ` · ${technician.workStartTime || '??'}–${technician.workEndTime || '??'}`}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Right controls: Daily/Weekly toggle + date nav + export */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Daily / Weekly toggle */}
            <div className="flex bg-slate-100 rounded-lg p-0.5 text-xs font-semibold">
              <button
                onClick={handleSwitchToDaily}
                className={`px-3 py-1.5 rounded-md transition-all ${
                  viewMode === 'daily' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                Daily
              </button>
              <button
                onClick={handleSwitchToWeekly}
                className={`px-3 py-1.5 rounded-md transition-all ${
                  viewMode === 'weekly' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                Weekly
              </button>
            </div>

            <div className="w-px h-5 bg-slate-200" />

            {/* Date / week navigation */}
            <button
              onClick={onPrevious}
              className="p-1.5 hover:bg-slate-100 rounded-md transition-colors"
              title={viewMode === 'weekly' ? 'Previous week' : 'Previous day'}
            >
              <ChevronLeft className="w-4 h-4 text-slate-500" />
            </button>

            {viewMode === 'weekly' ? (
              <span className="text-sm font-medium text-slate-700 min-w-[200px] text-center">
                {weekDisplayLabel}
              </span>
            ) : (
              <input
                type="date"
                value={selectedDate || formatDateLocal(new Date())}
                max={formatDateLocal(new Date())}
                onChange={onDateChange}
                className="px-2.5 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent text-slate-700"
              />
            )}

            {/* Next button — hidden when already at today / current week */}
            {!(viewMode === 'daily' && isToday) && !(viewMode === 'weekly' && isCurrentWeek) && (
              <button
                onClick={onNext}
                className="p-1.5 hover:bg-slate-100 rounded-md transition-colors"
                title={viewMode === 'weekly' ? 'Next week' : 'Next day'}
              >
                <ChevronRight className="w-4 h-4 text-slate-500" />
              </button>
            )}

            {(viewMode === 'weekly' ? !isCurrentWeek : !isToday) && (
              <button
                onClick={onToday}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg transition-colors"
              >
                {viewMode === 'weekly' ? 'This Week' : 'Today'}
              </button>
            )}

            <div className="w-px h-5 bg-slate-200" />

            <ExportButton
              tickets={allTickets}
              technicians={[technician]}
              viewMode={technician.name}
              selectedDate={selectedDate ? new Date(selectedDate + 'T12:00:00') : new Date()}
            />
          </div>
        </div>
      </div>
    </header>
  );
}
