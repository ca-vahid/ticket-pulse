import { ArrowLeft, MapPin, Clock, ChevronLeft, ChevronRight, Clock3, CalendarRange, CalendarDays } from 'lucide-react';
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
  selectedMonth,
  setSelectedMonth,
  allTickets,
  onBack,
  onPrevious,
  onNext,
  onToday,
  onDateChange,
  isToday,
  isCurrentWeek,
  isCurrentMonth,
  monthLabel: _monthLabel,
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
    } else if (viewMode === 'monthly' && selectedMonth) {
      setSelectedDate(formatDateLocal(selectedMonth));
    }
    setViewMode('daily');
  };

  const handleSwitchToWeekly = () => {
    if (viewMode !== 'weekly') {
      const dateToUse = selectedDate ? new Date(selectedDate + 'T12:00:00')
        : viewMode === 'monthly' && selectedMonth ? selectedMonth
          : new Date();
      const day = (dateToUse.getDay() + 6) % 7;
      const monday = new Date(dateToUse);
      monday.setDate(dateToUse.getDate() - day);
      monday.setHours(0, 0, 0, 0);
      setSelectedWeek(monday);
    }
    setViewMode('weekly');
  };

  const handleSwitchToMonthly = () => {
    if (viewMode !== 'monthly') {
      const dateToUse = selectedDate ? new Date(selectedDate + 'T12:00:00')
        : viewMode === 'weekly' && selectedWeek ? new Date(selectedWeek)
          : new Date();
      const firstOfMonth = new Date(dateToUse.getFullYear(), dateToUse.getMonth(), 1, 0, 0, 0);
      setSelectedMonth(firstOfMonth);
    }
    setViewMode('monthly');
  };

  const handleMonthChange = (e) => {
    if (e.target.value) {
      const [year, month] = e.target.value.split('-').map(Number);
      setSelectedMonth(new Date(year, month - 1, 1, 0, 0, 0));
    }
  };

  const monthInputValue = selectedMonth
    ? `${selectedMonth.getFullYear()}-${String(selectedMonth.getMonth() + 1).padStart(2, '0')}`
    : (() => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`; })();

  const maxMonthValue = (() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  })();

  const location = technician.location ||
    (technician.timezone ? technician.timezone.split('/').pop().replace(/_/g, ' ') : null);
  const timezone = technician.timezone ? technician.timezone.replace(/_/g, ' ') : null;
  const hasSchedule = technician.workStartTime || technician.workEndTime;

  return (
    <header className="bg-card border-b border-border sticky top-0 z-10 shadow-sm">
      <div className="max-w-7xl mx-auto px-3 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-3 lg:flex-nowrap lg:gap-4">
          {/* Back button */}
          <button
            onClick={onBack}
            className="flex min-h-[40px] flex-shrink-0 items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>

          <div className="hidden h-6 w-px flex-shrink-0 bg-secondary sm:block" />

          {/* Identity */}
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {technician.photoUrl ? (
              <img
                src={technician.photoUrl}
                alt={technician.name}
                className="w-10 h-10 rounded-full object-cover border border-border flex-shrink-0"
              />
            ) : (
              <div className="flex items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-700 w-10 h-10 flex-shrink-0">
                <span className="text-sm font-bold text-white">{getInitials(technician.name)}</span>
              </div>
            )}
            <div className="min-w-0">
              <h1 className="truncate text-base font-bold leading-tight text-foreground">{technician.name}</h1>
              <div className="flex items-center gap-2 text-xs text-muted-foreground/75 mt-0.5 flex-wrap">
                {location && (
                  <span className="flex min-w-0 items-center gap-1">
                    <MapPin className="w-3 h-3" />
                    <span className="truncate">{location}</span>
                  </span>
                )}
                {timezone && (
                  <span className="flex min-w-0 items-center gap-1">
                    <Clock className="w-3 h-3" />
                    <span className="truncate">
                      {timezone}
                      {hasSchedule && ` · ${technician.workStartTime || '??'}–${technician.workEndTime || '??'}`}
                    </span>
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Right controls: Daily/Weekly/Monthly toggle + date nav + export.
              On phones these WRAP onto multiple rows so the Export / Today
              controls stay reachable (they used to scroll off the edge of a
              hidden-scrollbar strip). */}
          <div className="flex w-full flex-shrink-0 flex-wrap items-center gap-2 lg:w-auto lg:flex-nowrap">
            {/* Daily / Weekly / Monthly toggle — fixed-width segments with the
                icon ALWAYS rendered, so switching modes never shifts layout
                (the old text-only pills jittered when styling changed). */}
            <div className="flex flex-shrink-0 bg-muted rounded-lg p-0.5 text-xs font-semibold">
              {[
                { key: 'daily', label: 'Daily', Icon: Clock3, onClick: handleSwitchToDaily },
                { key: 'weekly', label: 'Weekly', Icon: CalendarRange, onClick: handleSwitchToWeekly },
                { key: 'monthly', label: 'Monthly', Icon: CalendarDays, onClick: handleSwitchToMonthly },
              ].map(({ key, label, Icon, onClick }) => (
                <button
                  key={key}
                  onClick={onClick}
                  aria-pressed={viewMode === key}
                  className={`tp-focus-ring flex w-[92px] items-center justify-center gap-1.5 rounded-md py-1.5 transition-colors ${
                    viewMode === key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>

            <div className="h-5 w-px flex-shrink-0 bg-secondary" />

            {/* Date / week / month navigation — fixed-width area so layout never shifts */}
            <button
              onClick={onPrevious}
              className="p-1.5 hover:bg-muted rounded-md transition-colors flex-shrink-0"
              title={viewMode === 'weekly' ? 'Previous week' : viewMode === 'monthly' ? 'Previous month' : 'Previous day'}
            >
              <ChevronLeft className="w-4 h-4 text-muted-foreground" />
            </button>

            {/* Fixed-width date display: all three modes share the same 216px slot */}
            <div className="flex w-[160px] flex-shrink-0 items-center justify-center sm:w-[216px]">
              {viewMode === 'weekly' ? (
                <span className="text-sm font-medium text-foreground/85 text-center w-full text-center">
                  {weekDisplayLabel}
                </span>
              ) : viewMode === 'monthly' ? (
                <input
                  type="month"
                  value={monthInputValue}
                  max={maxMonthValue}
                  onChange={handleMonthChange}
                  className="w-full px-2.5 py-1.5 border border-input rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent text-foreground/85"
                />
              ) : (
                <input
                  type="date"
                  value={selectedDate || formatDateLocal(new Date())}
                  max={formatDateLocal(new Date())}
                  onChange={onDateChange}
                  className="w-full px-2.5 py-1.5 border border-input rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent text-foreground/85"
                />
              )}
            </div>

            {/* Next button — invisible (not removed) when at current period so layout stays fixed */}
            {(() => {
              const atEnd = (viewMode === 'daily' && isToday) || (viewMode === 'weekly' && isCurrentWeek) || (viewMode === 'monthly' && isCurrentMonth);
              return (
                <button
                  onClick={atEnd ? undefined : onNext}
                  className={`p-1.5 rounded-md transition-colors flex-shrink-0 ${atEnd ? 'invisible' : 'hover:bg-muted'}`}
                  title={viewMode === 'weekly' ? 'Next week' : viewMode === 'monthly' ? 'Next month' : 'Next day'}
                  tabIndex={atEnd ? -1 : 0}
                >
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </button>
              );
            })()}

            {/* Today/This Week/This Month — invisible when already on current period */}
            {(() => {
              const atCurrent = (viewMode === 'daily' && isToday) || (viewMode === 'weekly' && isCurrentWeek) || (viewMode === 'monthly' && isCurrentMonth);
              const label = viewMode === 'monthly' ? 'This Month' : viewMode === 'weekly' ? 'This Week' : 'Today';
              return (
                <button
                  onClick={atCurrent ? undefined : onToday}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors flex-shrink-0 ${atCurrent ? 'invisible' : 'bg-blue-600 hover:bg-blue-700 text-white'}`}
                  tabIndex={atCurrent ? -1 : 0}
                >
                  {label}
                </button>
              );
            })()}

            <div className="h-5 w-px flex-shrink-0 bg-secondary" />

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
