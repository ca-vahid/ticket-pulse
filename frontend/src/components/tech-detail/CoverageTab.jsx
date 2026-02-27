import { useState } from 'react';
import { Moon, Sunrise, ExternalLink, Layers } from 'lucide-react';
import { getHolidayInfo, getHolidayTooltip } from '../../utils/holidays';
import { PRIORITY_STRIP_COLORS, STATUS_COLORS, FRESHSERVICE_DOMAIN } from './constants';
import { fmtWaitTime } from './utils';
import FilterBar, { applyNotPickedFilters, applyPickedFilters } from './FilterBar';
import MergedTimelineModal from './MergedTimelineModal';

function isOvernight(ticket) {
  if (!ticket._day) return true;
  const cutoff = new Date(ticket._day + 'T10:00:00Z');
  return new Date(ticket.createdAt) < cutoff;
}

// ── Coverage ticket row ───────────────────────────────────────────────────────

function CoverageTicketRow({ ticket, showAssignee, onExcludeCategory }) {
  const overnight = isOvernight(ticket);
  const wait = fmtWaitTime(ticket);
  return (
    <div className={`border rounded overflow-hidden hover:shadow-sm transition-all ${overnight ? 'bg-slate-50 border-slate-200' : 'bg-amber-50/30 border-amber-200'}`}>
      <div className="flex items-stretch">
        <div className={`${PRIORITY_STRIP_COLORS[ticket.priority] || 'bg-slate-300'} w-1 flex-shrink-0`} />
        <div className="flex-1 px-2 py-1.5 flex items-center gap-1.5 min-w-0">
          {overnight
            ? <Moon className="w-3 h-3 text-indigo-400 flex-shrink-0" title="Overnight (before 5 AM ET)" />
            : <Sunrise className="w-3 h-3 text-amber-500 flex-shrink-0" title="Early morning (5 AM ET+)" />}
          <a
            href={`https://${FRESHSERVICE_DOMAIN}/a/tickets/${ticket.freshserviceTicketId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:text-blue-800 flex-shrink-0"
            title={`#${ticket.freshserviceTicketId}`}
          >
            <ExternalLink className="w-3 h-3" />
          </a>
          <span className="text-slate-800 font-medium text-xs truncate min-w-0 flex-1">{ticket.subject}</span>
          <span className={`${STATUS_COLORS[ticket.status] || 'bg-slate-100 text-slate-600'} px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0`}>
            {ticket.status}
          </span>
          {ticket.ticketCategory && (
            <button
              onClick={onExcludeCategory ? (e) => { e.stopPropagation(); onExcludeCategory(ticket.ticketCategory); } : undefined}
              className={`px-1.5 py-0.5 rounded text-[10px] flex-shrink-0 truncate max-w-[90px] ${onExcludeCategory ? 'bg-slate-100 text-slate-600 hover:bg-red-50 hover:text-red-600 hover:line-through cursor-pointer' : 'bg-slate-100 text-slate-500'}`}
              title={onExcludeCategory ? `Click to exclude "${ticket.ticketCategory}"` : ticket.ticketCategory}
            >
              {ticket.ticketCategory}
            </button>
          )}
          {showAssignee && ticket.assignedTechName && (
            <span className="text-slate-500 font-semibold text-[10px] flex-shrink-0 whitespace-nowrap">
              → {ticket.assignedTechName}
            </span>
          )}
          {wait && (
            <span className="bg-slate-100 text-slate-600 border border-slate-200 px-1.5 py-0.5 rounded text-[10px] font-semibold flex-shrink-0 whitespace-nowrap" title="Time from creation to first assignment">
              ⏱ {wait}
            </span>
          )}
          <span className="text-slate-300 text-[10px] flex-shrink-0 whitespace-nowrap">
            {new Date(ticket.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function CoverageTab({
  technician,
  viewMode,
  selectedDate,
  selectedWeek,
  selectedMonth,
  onPrevious,
  onNext,
  onToday,
}) {
  // Filter state — shared with MergedTimelineModal
  const [excludeCats, setExcludeCats] = useState(new Set());
  const [excludeText, setExcludeText] = useState('');
  const [includeCats, setIncludeCats] = useState(new Set());
  const [includeText, setIncludeText] = useState('');
  const [showMergedTimeline, setShowMergedTimeline] = useState(false);

  const av = technician.avoidance;

  if (!av) {
    return (
      <div className="text-center py-12">
        <p className="text-slate-400 text-sm">Coverage data is loading or unavailable.</p>
        <p className="text-slate-300 text-xs mt-1">Try refreshing the page if this persists.</p>
      </div>
    );
  }
  if (!av.applicable) {
    return (
      <div className="text-center py-12">
        <p className="text-slate-400 text-sm">
          {av.reason === 'weekend'
            ? 'No coverage window for weekends.'
            : 'Coverage analysis is not available for this period.'}
        </p>
      </div>
    );
  }

  const todayStr = new Date().toLocaleDateString('en-CA');
  const { totals } = av;
  const days = (av.days || []).filter((d) => d.date <= todayStr);

  const allPicked = days.flatMap((d) =>
    (d.tickets || []).filter((t) => t.pickedByTech).map((t) => ({ ...t, _day: d.date })),
  );
  const allNotPicked = days.flatMap((d) =>
    (d.tickets || []).filter((t) => !t.pickedByTech).map((t) => ({ ...t, _day: d.date })),
  );

  const filters = { excludeCats, excludeText, includeCats, includeText };
  const filteredNotPicked = allNotPicked.filter((t) => applyNotPickedFilters(t, filters));
  const filteredPicked = allPicked.filter((t) => applyPickedFilters(t, { includeCats, includeText }));
  const hiddenCount = allNotPicked.length - filteredNotPicked.length;

  // All unique categories across both lists for the dropdowns
  const allCategories = [
    ...new Set([...allPicked, ...allNotPicked].map((t) => t.ticketCategory).filter(Boolean)),
  ].sort();

  return (
    <div className="space-y-4">
      {/* Summary cards + Timeline button */}
      <div className="flex items-stretch gap-3">
        <div className="flex-1 grid grid-cols-3 gap-3">
          <div className="bg-white rounded-lg border border-slate-200 p-4 text-center">
            <div className="text-2xl font-bold text-slate-800">{totals.eligible}</div>
            <div className="text-xs text-slate-400 uppercase font-medium mt-1">Eligible (overnight)</div>
          </div>
          <div className="bg-white rounded-lg border-2 border-emerald-300 p-4 text-center">
            <div className="text-2xl font-bold text-emerald-700">{totals.picked}</div>
            <div className="text-xs text-slate-400 uppercase font-medium mt-1">
              Picked by {technician.name?.split(' ')[0]}
            </div>
          </div>
          <div className="bg-white rounded-lg border-2 border-amber-300 p-4 text-center">
            <div className="text-2xl font-bold text-amber-700">{totals.notPicked}</div>
            <div className="text-xs text-slate-400 uppercase font-medium mt-1">Not Picked</div>
          </div>
        </div>
        <button
          onClick={() => setShowMergedTimeline(true)}
          className="flex flex-col items-center justify-center gap-2 px-5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold transition-colors shadow-sm flex-shrink-0"
        >
          <Layers className="w-5 h-5" />
          <span className="text-xs font-semibold">Timeline</span>
        </button>
      </div>

      {/* Daily breakdown (weekly / monthly mode) */}
      {days.length > 1 && (
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-3">Daily Breakdown</h3>
          {viewMode === 'monthly' ? (
            /* Monthly: 5-column Mon–Fri grid, multi-row */
            <>
              <div className="grid grid-cols-5 gap-1.5 mb-1">
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((d) => (
                  <div key={d} className="text-[9px] font-bold uppercase tracking-wide text-center text-slate-400">{d}</div>
                ))}
              </div>
              {/* Build rows of weekdays */}
              {(() => {
                // Group days into rows (weeks), padding the first row
                const firstDow = (() => {
                  const d = new Date(days[0].date + 'T12:00:00');
                  return (d.getDay() + 6) % 7; // Mon=0, Fri=4
                })();
                const cells = [];
                for (let i = 0; i < firstDow; i++) cells.push(null);
                days.forEach((d) => cells.push(d));
                // Pad to complete the last row
                while (cells.length % 5 !== 0) cells.push(null);
                // Split into rows of 5
                const rows = [];
                for (let i = 0; i < cells.length; i += 5) rows.push(cells.slice(i, i + 5));
                return rows.map((row, ri) => (
                  <div key={ri} className="grid grid-cols-5 gap-1.5 mb-1.5">
                    {row.map((day, ci) => {
                      if (!day) return <div key={ci} className="rounded-lg border border-transparent p-2" />;
                      const dayPicked = (day.tickets || []).filter((t) => t.pickedByTech).length;
                      const dayTotal = (day.tickets || []).length;
                      const dayNotPicked = dayTotal - dayPicked;
                      const hInfo = getHolidayInfo(day.date);
                      const hTip = getHolidayTooltip(day.date);
                      const dayDate = new Date(day.date + 'T12:00:00');
                      const dayLabel = dayDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                      return (
                        <div
                          key={day.date}
                          className={`text-center p-2 rounded-lg border ${hInfo.isCanadian ? 'bg-rose-50 border-rose-300' : hInfo.isUS ? 'bg-indigo-50 border-indigo-200' : 'bg-slate-50 border-slate-200'}`}
                          title={hTip || undefined}
                        >
                          <div className="text-[9px] text-slate-300 mb-0.5">{dayLabel}</div>
                          {hInfo.isHoliday && (
                            <div className={`text-[7px] font-semibold mb-0.5 truncate ${hInfo.isCanadian ? 'text-rose-600' : 'text-indigo-500'}`}>
                              {hInfo.isCanadian ? `🍁` : `🇺🇸`}
                            </div>
                          )}
                          <div className="text-base font-bold text-slate-800">{dayTotal}</div>
                          <div className="flex items-center justify-center gap-1 mt-0.5">
                            <span className="text-[9px] font-bold text-emerald-600">{dayPicked}✓</span>
                            <span className="text-slate-200">|</span>
                            <span className="text-[9px] font-bold text-amber-600">{dayNotPicked}✗</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ));
              })()}
            </>
          ) : (
            /* Weekly: single row of 5 weekday cells */
            <div className="grid grid-cols-5 gap-2">
              {days.map((day) => {
                const dayDate = new Date(day.date + 'T12:00:00');
                const dayName = dayDate.toLocaleDateString('en-US', { weekday: 'short' });
                const dayLabel = dayDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                const dayPicked = (day.tickets || []).filter((t) => t.pickedByTech).length;
                const dayTotal = (day.tickets || []).length;
                const dayNotPicked = dayTotal - dayPicked;
                const hInfo = getHolidayInfo(day.date);
                const hTip = getHolidayTooltip(day.date);
                return (
                  <div
                    key={day.date}
                    className={`text-center p-3 rounded-lg border ${hInfo.isCanadian ? 'bg-rose-50 border-rose-300' : hInfo.isUS ? 'bg-indigo-50 border-indigo-200' : 'bg-slate-50 border-slate-200'}`}
                    title={hTip || undefined}
                  >
                    <div className={`text-[10px] font-bold uppercase ${hInfo.isCanadian ? 'text-rose-600' : hInfo.isUS ? 'text-indigo-500' : 'text-slate-400'}`}>{dayName}</div>
                    <div className="text-[9px] text-slate-300 mb-1">{dayLabel}</div>
                    {hInfo.isHoliday && (
                      <div className={`text-[8px] font-semibold mb-1 truncate ${hInfo.isCanadian ? 'text-rose-600' : 'text-indigo-500'}`}>
                        {hInfo.isCanadian ? `🍁 ${hInfo.canadianName}` : `🇺🇸 ${hInfo.usName}`}
                      </div>
                    )}
                    <div className="text-lg font-bold text-slate-800">{dayTotal}</div>
                    <div className="text-[10px] text-slate-300">eligible</div>
                    <div className="flex items-center justify-center gap-2 mt-1.5">
                      <span className="text-[10px] font-bold text-emerald-600">{dayPicked} ✓</span>
                      <span className="text-slate-200">|</span>
                      <span className="text-[10px] font-bold text-amber-600">{dayNotPicked} ✗</span>
                    </div>
                    <div className="text-[9px] text-slate-300 mt-1 truncate" title={day.windowLabel}>
                      {day.windowLabel}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Single day window label */}
      {days.length === 1 && days[0].windowLabel && (() => {
        const dayHoliday = getHolidayInfo(days[0].date);
        const holidayTip = getHolidayTooltip(days[0].date);
        return (
          <div className={`rounded-lg border px-4 py-2 flex items-center gap-3 ${dayHoliday.isCanadian ? 'bg-rose-50 border-rose-300' : 'bg-slate-50 border-slate-200'}`}>
            <span className="text-xs text-slate-500 font-medium">Coverage window:</span>
            <span className="text-xs text-slate-800 font-semibold">{days[0].windowLabel}</span>
            {holidayTip && (
              <span className={`text-xs font-semibold ${dayHoliday.isCanadian ? 'text-rose-700' : 'text-indigo-600'}`}>
                {holidayTip}
              </span>
            )}
          </div>
        );
      })()}

      {/* Full-width filter bar — affects both columns */}
      <div className="bg-white rounded-lg border border-slate-200 px-3 py-2">
        <FilterBar
          allCategories={allCategories}
          excludeCats={excludeCats}
          setExcludeCats={setExcludeCats}
          excludeText={excludeText}
          setExcludeText={setExcludeText}
          includeCats={includeCats}
          setIncludeCats={setIncludeCats}
          includeText={includeText}
          setIncludeText={setIncludeText}
        />
      </div>

      {/* Two-column: Picked | Not Picked */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        {/* LEFT — Picked */}
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          <div className="flex items-center px-3 py-2.5 border-b border-slate-100">
            <h3 className="text-xs font-semibold text-emerald-700 uppercase tracking-wider flex items-center gap-1.5">
              Picked by {technician.name?.split(' ')[0]}
              <span className="bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full text-[10px] font-bold">
                {filteredPicked.length}
              </span>
              {filteredPicked.length !== allPicked.length && (
                <span className="text-slate-400 text-[10px] font-normal normal-case">of {allPicked.length}</span>
              )}
            </h3>
          </div>
          {filteredPicked.length === 0 ? (
            <p className="text-slate-400 text-sm text-center py-8">
              {allPicked.length === 0 ? 'No tickets picked up in this window.' : 'All picked tickets hidden by include filter.'}
            </p>
          ) : (
            <div className="space-y-1 p-2 max-h-[600px] overflow-y-auto">
              {filteredPicked.map((t) => (
                <CoverageTicketRow key={t.id} ticket={t} showAssignee={false} />
              ))}
            </div>
          )}
        </div>

        {/* RIGHT — Not Picked */}
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          <div className="flex items-center px-3 py-2.5 border-b border-slate-100">
            <h3 className="text-xs font-semibold text-amber-700 uppercase tracking-wider flex items-center gap-1.5">
              Not Picked
              <span className="bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full text-[10px] font-bold">
                {filteredNotPicked.length}
              </span>
              {hiddenCount > 0 && (
                <span className="text-slate-400 text-[10px] font-normal normal-case">of {allNotPicked.length}</span>
              )}
            </h3>
          </div>
          {filteredNotPicked.length === 0 ? (
            <div className="p-4 text-center">
              <p className={`text-sm font-medium ${allNotPicked.length === 0 ? 'text-emerald-600' : 'text-slate-400'}`}>
                {allNotPicked.length === 0
                  ? 'All eligible tickets were picked up.'
                  : 'All tickets hidden by filters.'}
              </p>
            </div>
          ) : (
            <div className="space-y-1 p-2 max-h-[600px] overflow-y-auto">
              {filteredNotPicked.map((t) => (
                <CoverageTicketRow
                  key={t.id}
                  ticket={t}
                  showAssignee={true}
                  onExcludeCategory={(cat) => {
                    setExcludeCats((prev) => { const n = new Set(prev); n.add(cat); return n; });
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-5 text-[10px] text-slate-400 px-1">
        <div className="flex items-center gap-1"><Moon className="w-3 h-3 text-indigo-400" /> Overnight (before 5 AM ET)</div>
        <div className="flex items-center gap-1"><Sunrise className="w-3 h-3 text-amber-500" /> Early morning (5 AM ET+)</div>
        <span className="text-slate-200">|</span>
        <span>Click a category on a ticket to exclude it</span>
      </div>

      {/* Merged Timeline Modal */}
      {showMergedTimeline && (
        <MergedTimelineModal
          technician={technician}
          days={days}
          allPicked={allPicked}
          allNotPicked={allNotPicked}
          excludeCats={excludeCats}
          setExcludeCats={setExcludeCats}
          excludeText={excludeText}
          setExcludeText={setExcludeText}
          includeCats={includeCats}
          setIncludeCats={setIncludeCats}
          includeText={includeText}
          setIncludeText={setIncludeText}
          allCategories={allCategories}
          viewMode={viewMode}
          selectedDate={selectedDate}
          selectedWeek={selectedWeek}
          selectedMonth={selectedMonth}
          onClose={() => setShowMergedTimeline(false)}
          onPrevious={onPrevious}
          onNext={onNext}
          onToday={onToday}
        />
      )}
    </div>
  );
}
