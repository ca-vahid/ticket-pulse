import { useState } from 'react';
import { Layers, ChevronLeft, ChevronRight, X, Maximize2, Minimize2 } from 'lucide-react';
import FilterBar, { applyNotPickedFilters, applyPickedFilters } from './FilterBar';
import TimelineCore, { TimelineLegend } from '../timeline/TimelineCore';
import {
  mergeTicketsForTimeline,
  buildTimeline,
  collapseMarkers,
  techConfigsFromTechnician,
} from '../timeline/timelineUtils';

/**
 * MergedTimelineModal — single-technician timeline modal.
 * All rendering is delegated to shared timeline/* modules.
 * This component owns: modal wrapper, header controls, filter bar, date label, legend.
 */
export default function MergedTimelineModal({
  technician,
  days,
  allPicked,
  allNotPicked,
  excludeCats,
  setExcludeCats,
  excludeText,
  setExcludeText,
  includeCats,
  setIncludeCats,
  includeText,
  setIncludeText,
  allCategories,
  viewMode,
  selectedDate,
  selectedWeek,
  selectedMonth,
  onClose,
  onPrevious,
  onNext,
  onToday,
}) {
  const [mergedViewMode, setMergedViewMode] = useState('rolling');
  const [fullscreen, setFullscreen] = useState(false);

  // Build techConfigs from the single technician (same API as multi-tech Explorer)
  const techConfigs = techConfigsFromTechnician(technician);
  const { firstName } = techConfigs[0];

  // Merge + sort all tickets
  const allMerged = mergeTicketsForTimeline(days, allPicked, allNotPicked);

  // Apply filters
  const filters = { excludeCats, excludeText, includeCats, includeText };
  const mergedFiltered = allMerged.filter((t) => {
    if (t._picked) return applyPickedFilters(t, { includeCats, includeText });
    return applyNotPickedFilters(t, filters);
  });

  const mergedExcludedCount =
    allMerged.filter((t) => !t._picked).length -
    mergedFiltered.filter((t) => !t._picked).length;
  const mergedPickedCount = mergedFiltered.filter((t) => t._picked).length;
  const mergedNotPickedCount = mergedFiltered.filter((t) => !t._picked).length;
  const isMultiDay = days.length > 1;

  // Build timeline items via shared utility
  const rawItems = buildTimeline(days, mergedFiltered, mergedViewMode, techConfigs);
  const timelineItems = collapseMarkers(rawItems);

  // Date label for the nav bar
  const dateLabel =
    viewMode === 'monthly'
      ? (() => {
        const m = selectedMonth || new Date();
        return m.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      })()
      : viewMode === 'weekly'
        ? (() => {
          const ws = technician.weekStart
            ? new Date(technician.weekStart + 'T12:00:00')
            : selectedWeek
              ? new Date(selectedWeek)
              : null;
          const we = technician.weekEnd
            ? new Date(technician.weekEnd + 'T12:00:00')
            : ws
              ? (() => { const d = new Date(ws); d.setDate(d.getDate() + 6); return d; })()
              : null;
          if (!ws) return 'This Week';
          return `${ws.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${we.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
        })()
        : (() => {
          const d = selectedDate ? new Date(selectedDate + 'T12:00:00') : new Date();
          return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        })();

  const addExcludeCat = (cat) =>
    setExcludeCats((prev) => { const n = new Set(prev); n.add(cat); return n; });

  return (
    <div
      className={`fixed inset-0 z-50 ${
        fullscreen
          ? 'bg-white overflow-hidden'
          : 'bg-black/50 backdrop-blur-sm flex items-start justify-center p-4 pt-6 overflow-y-auto'
      }`}
      onClick={fullscreen ? undefined : onClose}
    >
      <div
        className={`bg-white flex flex-col ${
          fullscreen ? 'w-full h-full' : 'rounded-xl shadow-2xl w-full max-w-6xl max-h-[92vh]'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 flex-shrink-0">
          <div className="flex items-center gap-3">
            <Layers className="w-5 h-5 text-blue-600" />
            <div>
              <h2 className="text-sm font-bold text-slate-900">Merged Timeline — {technician.name}</h2>
              <p className="text-[11px] text-slate-400">
                {days.length === 1
                  ? days[0].windowLabel
                  : `${days[0]?.windowLabel?.split('→')[0]}→ … → ${days[days.length - 1]?.windowLabel?.split('→')[1]}`}
                {' '}+ extended to 5 PM PT
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Day-by-Day / Combined toggle (multi-day only) */}
            {isMultiDay && (
              <>
                <div className="flex bg-slate-100 rounded-lg p-0.5 text-[11px] font-semibold">
                  <button
                    onClick={() => setMergedViewMode('rolling')}
                    className={`px-2.5 py-1 rounded-md transition-all ${mergedViewMode === 'rolling' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                  >
                    Day by Day
                  </button>
                  <button
                    onClick={() => setMergedViewMode('combined')}
                    className={`px-2.5 py-1 rounded-md transition-all ${mergedViewMode === 'combined' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                  >
                    Combined
                  </button>
                </div>
                <div className="w-px h-5 bg-slate-200" />
              </>
            )}

            {/* Date navigation */}
            <button onClick={onPrevious} className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors" title="Previous">
              <ChevronLeft className="w-4 h-4 text-slate-500" />
            </button>
            <span className="text-xs font-medium text-slate-600 min-w-[140px] text-center">{dateLabel}</span>
            <button onClick={onNext} className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors" title="Next">
              <ChevronRight className="w-4 h-4 text-slate-500" />
            </button>
            <button
              onClick={onToday}
              className="px-2 py-1 text-[10px] font-medium text-blue-600 hover:bg-blue-50 rounded transition-colors border border-blue-200"
            >
              {viewMode === 'monthly' ? 'This Month' : viewMode === 'weekly' ? 'This Week' : 'Today'}
            </button>

            <div className="w-px h-5 bg-slate-200" />

            {/* Counts */}
            <div className="flex items-center gap-2 text-xs">
              <span className="flex items-center gap-1 text-emerald-600 font-semibold">
                <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> Picked {mergedPickedCount}
              </span>
              <span className="flex items-center gap-1 text-slate-400 font-semibold">
                <span className="w-2 h-2 rounded-full bg-slate-400 inline-block" /> Not picked {mergedNotPickedCount}
              </span>
              {mergedExcludedCount > 0 && (
                <span className="text-slate-300">({mergedExcludedCount} hidden)</span>
              )}
            </div>

            <button
              onClick={() => setFullscreen((f) => !f)}
              className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors"
              title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            >
              {fullscreen
                ? <Minimize2 className="w-4 h-4 text-slate-400" />
                : <Maximize2 className="w-4 h-4 text-slate-400" />}
            </button>
            <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors">
              <X className="w-4 h-4 text-slate-400" />
            </button>
          </div>
        </div>

        {/* Filter bar */}
        <div className="px-5 py-2 border-b border-slate-100 flex-shrink-0">
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

        {/* Timeline — rendered by shared TimelineCore */}
        <TimelineCore
          timelineItems={timelineItems}
          defaultFirstName={firstName}
          onExcludeCategory={addExcludeCat}
          className="flex-1 overflow-y-auto px-5 py-2"
          emptyMessage="No tickets match the current filters."
          showFullDate={isMultiDay}
        />

        {/* Footer legend */}
        <div className="px-5 py-2 border-t border-slate-200 flex-shrink-0">
          <TimelineLegend techConfigs={techConfigs} />
        </div>
      </div>
    </div>
  );
}
