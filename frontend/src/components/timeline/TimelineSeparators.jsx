import { CalendarDays, MoreHorizontal } from 'lucide-react';
import { getHolidayInfo, getHolidayTooltip } from '../../utils/holidays';

/** Single horizontal separator with a coloured label in the centre */
export function TimelineSeparator({ label, color }) {
  return (
    <div className="flex items-center gap-2 py-1.5 my-1">
      <div className={`flex-1 h-px ${color}`} />
      <span className={`text-[10px] font-bold uppercase tracking-wider whitespace-nowrap ${color.replace('bg-', 'text-')}`}>
        {label}
      </span>
      <div className={`flex-1 h-px ${color}`} />
    </div>
  );
}

/** Multiple consecutive markers collapsed into one compact line */
export function MergedSeparator({ markers }) {
  return (
    <div className="flex items-center gap-2 py-1 my-0.5">
      <div className="flex-1 h-px bg-slate-200" />
      <div className="flex items-center gap-0 flex-shrink-0">
        {markers.map((m, i) => (
          <span key={i} className="flex items-center">
            {i > 0 && <span className="text-slate-300 mx-2 text-[10px]">·</span>}
            <span className={`text-[9px] font-bold uppercase tracking-wider whitespace-nowrap ${m.color.replace('bg-', 'text-')}`}>
              {m.label}
            </span>
          </span>
        ))}
      </div>
      <div className="flex-1 h-px bg-slate-200" />
    </div>
  );
}

/** Day header shown in rolling (day-by-day) mode with holiday indicators and per-day stats */
export function DayHeader({ dateStr, dayPicked, dayNotPicked, dayTotal, techStats }) {
  const d = new Date(dateStr + 'T12:00:00');
  const label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const hInfo = getHolidayInfo(dateStr);
  const hTip = getHolidayTooltip(dateStr);

  return (
    <div
      className={`flex items-center gap-3 py-2 mt-3 mb-1 border-b-2 first:mt-0 ${
        hInfo.isCanadian
          ? 'border-rose-400 bg-rose-50/50'
          : hInfo.isUS
            ? 'border-indigo-400 bg-indigo-50/50'
            : 'border-slate-300'
      }`}
      title={hTip || undefined}
    >
      <CalendarDays className={`w-4 h-4 flex-shrink-0 ${hInfo.isCanadian ? 'text-rose-600' : 'text-indigo-600'}`} />
      <span className={`text-sm font-bold ${hInfo.isCanadian ? 'text-rose-900' : 'text-slate-800'}`}>{label}</span>
      {hInfo.isHoliday && (
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
          hInfo.isCanadian
            ? 'bg-rose-100 text-rose-700 border border-rose-300'
            : 'bg-indigo-100 text-indigo-700 border border-indigo-300'
        }`}>
          {hInfo.isCanadian ? `🍁 ${hInfo.canadianName}` : `🇺🇸 ${hInfo.usName}`}
        </span>
      )}
      <div className="flex items-center gap-2 ml-auto text-[10px]">
        <span className="text-slate-400">{dayTotal} eligible</span>
        <span className="text-emerald-600 font-semibold">{dayPicked} picked</span>
        <span className="text-amber-600 font-semibold">{dayNotPicked} not</span>
        {/* Per-tech breakdown in multi-tech mode */}
        {techStats && techStats.length > 1 && (
          <span className="flex items-center gap-1 ml-1">
            {techStats.map((ts) => (
              <span key={ts.techId} className={`${ts.accent.badge} px-1 py-0.5 rounded text-[9px] font-bold`}>
                {ts.firstName}: {ts.picked}
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

/** Compact separator for consecutive days with no matching tickets */
export function EmptyDayGap({ startDate, endDate, count }) {
  const fmt = (ds) => {
    const d = new Date(ds + 'T12:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  const rangeLabel = startDate === endDate
    ? fmt(startDate)
    : `${fmt(startDate)} – ${fmt(endDate)}`;

  return (
    <div className="flex items-center gap-3 py-2 my-1">
      <div className="flex-1 border-t border-dashed border-slate-200" />
      <div className="flex items-center gap-1.5 text-slate-300">
        <MoreHorizontal className="w-3.5 h-3.5" />
        <span className="text-[10px] font-medium">
          {count} day{count > 1 ? 's' : ''} · {rangeLabel} · no matching tickets
        </span>
        <MoreHorizontal className="w-3.5 h-3.5" />
      </div>
      <div className="flex-1 border-t border-dashed border-slate-200" />
    </div>
  );
}
