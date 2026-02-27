import { Moon, Sunrise } from 'lucide-react';
import { TimelineSeparator, MergedSeparator, DayHeader, EmptyDayGap } from './TimelineSeparators';
import TimelineTicketRow from './TimelineTicketRow';

/**
 * TimelineCore — shared, headless timeline list renderer.
 *
 * Receives pre-built, pre-filtered, pre-collapsed timeline items and renders them.
 * Does NOT own scroll, modal wrapper, filter bar, or header controls — callers handle those.
 *
 * Props:
 *   timelineItems      — output of collapseMarkers(buildTimeline(...))
 *   defaultFirstName   — agent first name shown in "✓ Name" badge (single-tech mode)
 *   onExcludeCategory  — callback(category) forwarded to each ticket row
 *   className          — CSS classes for the outer scroll container
 *   emptyMessage       — text to show when timelineItems is empty
 */
export default function TimelineCore({
  timelineItems,
  defaultFirstName,
  onExcludeCategory,
  className,
  emptyMessage,
  showFullDate,
}) {
  if (!timelineItems || timelineItems.length === 0) {
    return (
      <div className={className || 'flex-1 overflow-y-auto px-5 py-2'}>
        <div className="flex items-center justify-center h-full min-h-[200px]">
          <p className="text-slate-400 text-sm">{emptyMessage || 'No tickets to display.'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={className || 'flex-1 overflow-y-auto px-5 py-2'}>
      <div className="space-y-0.5">
        {timelineItems.map((item, idx) => {
          if (item._emptyDayGap) {
            return <EmptyDayGap key={item.key} startDate={item.startDate} endDate={item.endDate} count={item.count} />;
          }
          if (item._dayHeader) {
            return (
              <DayHeader
                key={item.key}
                dateStr={item.dateStr}
                dayPicked={item.dayPicked}
                dayNotPicked={item.dayNotPicked}
                dayTotal={item.dayTotal}
                techStats={item.techStats}
              />
            );
          }
          if (item._mergedMarkers) {
            return <MergedSeparator key={item.key} markers={item.markers} />;
          }
          if (item._marker) {
            return <TimelineSeparator key={item.key} label={item.label} color={item.color} />;
          }
          return (
            <TimelineTicketRow
              key={`${item.id}-${idx}`}
              ticket={item}
              defaultFirstName={defaultFirstName}
              onExcludeCategory={onExcludeCategory}
              idx={idx}
              showFullDate={showFullDate}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * TimelineLegend — shared footer legend.
 * Pass techConfigs for multi-tech colour key.
 */
export function TimelineLegend({ techConfigs }) {
  const isMultiTech = techConfigs && techConfigs.length > 1;
  return (
    <div className="flex flex-wrap items-center gap-4 text-[10px] text-slate-400">
      {isMultiTech
        ? techConfigs.map((tc) => (
          <div key={tc.id} className="flex items-center gap-1">
            <span className={`w-2 h-2 rounded-full ${tc.accent?.bg || 'bg-emerald-500'} inline-block`} />
            {tc.firstName} picked
          </div>
        ))
        : (
          <>
            <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> Picked</div>
            <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-slate-400 inline-block" /> Not picked</div>
          </>
        )}
      <div className="flex items-center gap-1"><Moon className="w-3 h-3 text-indigo-400" /> Overnight</div>
      <div className="flex items-center gap-1"><Sunrise className="w-3 h-3 text-amber-500" /> Morning</div>
      <div className="flex items-center gap-1"><span className="w-4 h-0.5 bg-emerald-400 inline-block rounded" /> on</div>
      <div className="flex items-center gap-1"><span className="w-4 h-0.5 bg-blue-400 inline-block rounded" /> HQ on</div>
      <div className="flex items-center gap-1"><span className="w-4 h-0.5 bg-red-400 inline-block rounded" /> off</div>
    </div>
  );
}
