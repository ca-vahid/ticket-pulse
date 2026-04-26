import { CalendarDays, MoreHorizontal } from 'lucide-react';
import { getHolidayInfo, getHolidayTooltip } from '../../utils/holidays';

/** Single horizontal separator with a coloured label in the centre.
 *  Splits "Karen off · 5pm VAN" so names are plain and the time+tz
 *  part gets a distinct pill badge.
 */
export function TimelineSeparator({ label, color }) {
  const textColor = color.replace('bg-', 'text-');
  const borderColor = color.replace('bg-', 'border-');
  const sepIdx = label.indexOf(' · ');

  let content;
  if (sepIdx !== -1) {
    const nameAction = label.slice(0, sepIdx);
    const timeTz = label.slice(sepIdx + 3);
    content = (
      <>
        <span className={`${textColor}`}>{nameAction}</span>
        <span className={`ml-1.5 px-1.5 py-0.5 rounded border ${borderColor} ${textColor} bg-white/60`}>
          {timeTz}
        </span>
      </>
    );
  } else {
    content = <span className={textColor}>{label}</span>;
  }

  return (
    <div className="flex items-center gap-2 py-1.5 my-1">
      <div className={`flex-1 h-px ${color}`} />
      <span className="flex min-w-0 flex-wrap items-center justify-center text-center text-[10px] font-bold uppercase tracking-wider">
        {content}
      </span>
      <div className={`flex-1 h-px ${color}`} />
    </div>
  );
}

/** Multiple consecutive markers collapsed into one compact line.
 *  Groups markers that share the same suffix (e.g. "off · 5pm VAN") to avoid
 *  repeating "KAREN OFF · 5PM VAN · ZOE OFF · 5PM VAN · …" for 17 agents.
 *  Instead renders "Karen, Zoe, … OFF · 5PM VAN".
 */
export function MergedSeparator({ markers }) {
  const groups = [];
  const groupMap = new Map();

  for (const m of markers) {
    const sepIdx = m.label.indexOf(' · ');
    if (sepIdx === -1) {
      groups.push({ names: null, suffix: m.label, color: m.color });
      continue;
    }
    const namePart = m.label.slice(0, sepIdx);
    const suffix = m.label.slice(sepIdx + 3);
    const action = namePart.includes(' on') ? 'on' : namePart.includes(' off') ? 'off' : '';
    const name = namePart.replace(/ on$| off$/, '');
    const gKey = `${action}|${suffix}|${m.color}`;

    if (!groupMap.has(gKey)) {
      const g = { names: [name], action, suffix, color: m.color };
      groupMap.set(gKey, g);
      groups.push(g);
    } else {
      groupMap.get(gKey).names.push(name);
    }
  }

  return (
    <div className="flex items-center gap-2 py-1 my-0.5">
      <div className="flex-1 h-px bg-slate-200" />
      <div className="flex min-w-0 flex-shrink flex-wrap items-center justify-center gap-0">
        {groups.map((g, i) => {
          const textColor = g.color.replace('bg-', 'text-');
          const borderColor = g.color.replace('bg-', 'border-');
          return (
            <span key={i} className="flex items-center">
              {i > 0 && <span className="text-slate-300 mx-2 text-[10px]">·</span>}
              <span className={`flex flex-wrap items-center justify-center text-center text-[9px] font-bold uppercase tracking-wider ${textColor}`}>
                {g.names
                  ? (
                    <>
                      <span>{g.names.join(', ')} {g.action}</span>
                      <span className={`ml-1.5 px-1.5 py-0.5 rounded border ${borderColor} ${textColor} bg-white/60`}>
                        {g.suffix}
                      </span>
                    </>
                  )
                  : g.suffix}
              </span>
            </span>
          );
        })}
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
      className={`flex flex-wrap items-center gap-2 sm:gap-3 py-2 mt-3 mb-1 border-b-2 first:mt-0 ${
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
      <div className="flex w-full flex-wrap items-center gap-2 text-[10px] sm:ml-auto sm:w-auto">
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
    <div className="flex items-center gap-2 sm:gap-3 py-2 my-1">
      <div className="flex-1 border-t border-dashed border-slate-200" />
      <div className="flex min-w-0 items-center gap-1.5 text-center text-slate-300">
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
