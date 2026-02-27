import { useState } from 'react';
import {
  Layers, ChevronLeft, ChevronRight, X, Moon, Sunrise, ExternalLink,
  Maximize2, Minimize2, CalendarDays,
} from 'lucide-react';
import { getHolidayInfo, getHolidayTooltip } from '../../utils/holidays';
import { PRIORITY_STRIP_COLORS, STATUS_COLORS, FRESHSERVICE_DOMAIN } from './constants';
import { fmtWaitTime } from './utils';
import FilterBar, { applyNotPickedFilters } from './FilterBar';

function localTimeToUTC(dateStr, timeStr, tz) {
  const [h, m] = timeStr.split(':');
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'shortOffset',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(probe);
  const tzNamePart = parts.find((p) => p.type === 'timeZoneName')?.value || '';
  const match = tzNamePart.match(/GMT([+-]?\d+)?:?(\d+)?/);
  let offsetMinutes = 0;
  if (match) {
    const hrs = parseInt(match[1] || '0', 10);
    const mins = parseInt(match[2] || '0', 10);
    offsetMinutes = hrs * 60 + (hrs < 0 ? -mins : mins);
  }
  const localMs = new Date(`${dateStr}T${h.padStart(2, '0')}:${m.padStart(2, '0')}:00Z`).getTime();
  return new Date(localMs - offsetMinutes * 60000);
}

function getPTTimeOfDay(utcDateStr) {
  const d = new Date(utcDateStr);
  return d.toLocaleTimeString('en-US', {
    timeZone: 'America/Los_Angeles', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function getPTDateStr(utcDate) {
  return new Date(utcDate).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function TimelineSeparator({ label, color }) {
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

function DayHeader({ dateStr, dayPicked, dayNotPicked, dayTotal }) {
  const d = new Date(dateStr + 'T12:00:00');
  const label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const hInfo = getHolidayInfo(dateStr);
  const hTip = getHolidayTooltip(dateStr);
  return (
    <div
      className={`flex items-center gap-3 py-2 mt-3 mb-1 border-b-2 first:mt-0 ${hInfo.isCanadian ? 'border-rose-400 bg-rose-50/50' : hInfo.isUS ? 'border-indigo-400 bg-indigo-50/50' : 'border-slate-300'}`}
      title={hTip || undefined}
    >
      <CalendarDays className={`w-4 h-4 flex-shrink-0 ${hInfo.isCanadian ? 'text-rose-600' : 'text-indigo-600'}`} />
      <span className={`text-sm font-bold ${hInfo.isCanadian ? 'text-rose-900' : 'text-slate-800'}`}>{label}</span>
      {hInfo.isHoliday && (
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${hInfo.isCanadian ? 'bg-rose-100 text-rose-700 border border-rose-300' : 'bg-indigo-100 text-indigo-700 border border-indigo-300'}`}>
          {hInfo.isCanadian ? `🍁 ${hInfo.canadianName}` : `🇺🇸 ${hInfo.usName}`}
        </span>
      )}
      <div className="flex items-center gap-2 ml-auto text-[10px]">
        <span className="text-slate-400">{dayTotal} eligible</span>
        <span className="text-emerald-600 font-semibold">{dayPicked} picked</span>
        <span className="text-amber-600 font-semibold">{dayNotPicked} not</span>
      </div>
    </div>
  );
}

function isOvernight(ticket) {
  if (!ticket._day) return true;
  const cutoff = new Date(ticket._day + 'T10:00:00Z');
  return new Date(ticket.createdAt) < cutoff;
}

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
  onClose,
  onPrevious,
  onNext,
  onToday,
}) {
  const [mergedViewMode, setMergedViewMode] = useState('rolling');
  const [fullscreen, setFullscreen] = useState(false);

  const techStart = technician.workStartTime || '09:00';
  const techEnd = technician.workEndTime || '17:00';
  const techTz = technician.timezone || 'America/Los_Angeles';
  const tzCity = techTz.split('/').pop().replace(/_/g, ' ');
  const firstName = technician.name?.split(' ')[0] || 'Agent';

  const extendedAll = days.flatMap((d) =>
    (d.extendedTickets || []).map((t) => ({ ...t, _day: d.date, _picked: t.pickedByTech, _section: 'after9am' })),
  );
  const coverageAll = [
    ...allPicked.map((t) => ({ ...t, _picked: true, _section: 'coverage' })),
    ...allNotPicked.map((t) => ({ ...t, _picked: false, _section: 'coverage' })),
  ];
  const allMerged = [...coverageAll, ...extendedAll].sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
  );

  const filters = { excludeCats, excludeText, includeCats, includeText };
  const mergedFiltered = allMerged.filter((t) => {
    if (!t._picked) return applyNotPickedFilters(t, filters);
    return true;
  });

  const mergedExcludedCount = allMerged.filter((t) => !t._picked).length
    - mergedFiltered.filter((t) => !t._picked).length;
  const mergedPickedCount = mergedFiltered.filter((t) => t._picked).length;
  const mergedNotPickedCount = mergedFiltered.filter((t) => !t._picked).length;
  const isWeeklyView = days.length > 1;

  const insertMarkersForDay = (tickets, dateStr) => {
    const agentStart = localTimeToUTC(dateStr, techStart, techTz);
    const hqOnline = new Date(days.find((d) => d.date === dateStr)?.windowEnd || `${dateStr}T17:00:00Z`);
    const agentEnd = localTimeToUTC(dateStr, techEnd, techTz);
    const items = [];
    let sI = false, hI = false, eI = false, lastPTDate = null;

    for (const ticket of tickets) {
      const created = new Date(ticket.createdAt);
      const ptDate = getPTDateStr(created);

      if (lastPTDate && ptDate !== lastPTDate) {
        const d2 = new Date(created);
        const isWkend = d2.getDay() === 0 || d2.getDay() === 6;
        const label = d2.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
        const hInfo = getHolidayInfo(ptDate);
        const holidayLabel = hInfo.isCanadian ? ` — 🍁 ${hInfo.canadianName}` : hInfo.isUS ? ` — 🇺🇸 ${hInfo.usName}` : '';
        items.push({
          _marker: true, key: `daychange-${ptDate}`,
          label: `${label}${isWkend ? ' (Weekend)' : ''}${holidayLabel}`,
          color: isWkend ? 'bg-slate-400' : hInfo.isCanadian ? 'bg-rose-400' : hInfo.isUS ? 'bg-indigo-400' : 'bg-indigo-300',
        });
      }
      lastPTDate = ptDate;

      if (!sI && created >= agentStart) { items.push({ _marker: true, key: `start-${dateStr}`, label: `${firstName} Online — ${techStart} ${tzCity}`, color: 'bg-emerald-400' }); sI = true; }
      if (!hI && created >= hqOnline) { items.push({ _marker: true, key: `hq-${dateStr}`, label: 'Vancouver Online — 9:00 AM PT', color: 'bg-blue-400' }); hI = true; }
      if (!eI && created >= agentEnd) { items.push({ _marker: true, key: `end-${dateStr}`, label: `${firstName} Off — ${techEnd} ${tzCity}`, color: 'bg-red-400' }); eI = true; }
      items.push(ticket);
    }
    if (!sI) items.push({ _marker: true, key: `start-${dateStr}`, label: `${firstName} Online — ${techStart} ${tzCity}`, color: 'bg-emerald-400' });
    if (!hI) items.push({ _marker: true, key: `hq-${dateStr}`, label: 'Vancouver Online — 9:00 AM PT', color: 'bg-blue-400' });
    if (!eI) items.push({ _marker: true, key: `end-${dateStr}`, label: `${firstName} Off — ${techEnd} ${tzCity}`, color: 'bg-red-400' });
    return items;
  };

  const buildCombinedTimeline = (tickets) => {
    const refDate = days[0]?.date || '2026-01-05';
    const agentStartUTC = localTimeToUTC(refDate, techStart, techTz);
    const agentEndUTC = localTimeToUTC(refDate, techEnd, techTz);
    const agentStartPT = getPTTimeOfDay(agentStartUTC.toISOString());
    const agentEndPT = getPTTimeOfDay(agentEndUTC.toISOString());
    const hqOnlinePT = '09:00:00';

    const sorted = [...tickets].sort((a, b) => getPTTimeOfDay(a.createdAt).localeCompare(getPTTimeOfDay(b.createdAt)));
    const items = [];
    let lastHour = null, startInserted = false, endInserted = false, hqInserted = false;

    for (const ticket of sorted) {
      const ptTime = getPTTimeOfDay(ticket.createdAt);
      const hour = parseInt(ptTime.split(':')[0], 10);
      if (hour !== lastHour) {
        const h12 = hour === 0 ? '12 AM' : hour < 12 ? `${hour} AM` : hour === 12 ? '12 PM' : `${hour - 12} PM`;
        items.push({ _marker: true, key: `hour-${hour}`, label: h12, color: hour < 9 ? 'bg-slate-300' : hour < 17 ? 'bg-indigo-300' : 'bg-slate-300' });
        lastHour = hour;
      }
      if (!startInserted && ptTime >= agentStartPT) {
        const startH = parseInt(agentStartPT.split(':')[0], 10);
        const startM = agentStartPT.split(':')[1];
        const s12 = startH < 12 ? `${startH}:${startM} AM` : startH === 12 ? `12:${startM} PM` : `${startH - 12}:${startM} PM`;
        items.push({ _marker: true, key: 'combined-agent-start', label: `${firstName} Online — ${s12} PT`, color: 'bg-emerald-400' });
        startInserted = true;
      }
      if (!hqInserted && ptTime >= hqOnlinePT) { items.push({ _marker: true, key: 'combined-hq-online', label: 'Vancouver Online — 9:00 AM PT', color: 'bg-blue-400' }); hqInserted = true; }
      if (!endInserted && ptTime >= agentEndPT) {
        const endH = parseInt(agentEndPT.split(':')[0], 10);
        const endM = agentEndPT.split(':')[1];
        const e12 = endH < 12 ? `${endH}:${endM} AM` : endH === 12 ? `12:${endM} PM` : `${endH - 12}:${endM} PM`;
        items.push({ _marker: true, key: 'combined-agent-end', label: `${firstName} Off — ${e12} PT`, color: 'bg-red-400' });
        endInserted = true;
      }
      items.push(ticket);
    }
    if (!startInserted) items.push({ _marker: true, key: 'combined-agent-start', label: `${firstName} Online — ${techStart} ${tzCity}`, color: 'bg-emerald-400' });
    if (!hqInserted) items.push({ _marker: true, key: 'combined-hq-online', label: 'Vancouver Online — 9:00 AM PT', color: 'bg-blue-400' });
    if (!endInserted) items.push({ _marker: true, key: 'combined-agent-end', label: `${firstName} Off — ${techEnd} ${tzCity}`, color: 'bg-red-400' });
    return items;
  };

  const buildTimeline = () => {
    if (!isWeeklyView) return insertMarkersForDay(mergedFiltered, days[0]?.date || '');
    if (mergedViewMode === 'combined') return buildCombinedTimeline(mergedFiltered);
    const result = [];
    for (const day of days) {
      const dayTickets = mergedFiltered.filter((t) => t._day === day.date);
      const dayPicked = dayTickets.filter((t) => t._picked).length;
      const dayTotal = dayTickets.length;
      result.push({ _dayHeader: true, key: `dh-${day.date}`, dateStr: day.date, dayPicked, dayNotPicked: dayTotal - dayPicked, dayTotal });
      result.push(...insertMarkersForDay(dayTickets, day.date));
    }
    return result;
  };

  const timelineItems = buildTimeline();

  const dateLabel = viewMode === 'weekly'
    ? (() => {
      const ws = technician.weekStart ? new Date(technician.weekStart + 'T12:00:00') : selectedWeek ? new Date(selectedWeek) : null;
      const we = technician.weekEnd ? new Date(technician.weekEnd + 'T12:00:00') : ws ? (() => { const d = new Date(ws); d.setDate(d.getDate() + 6); return d; })() : null;
      if (!ws) return 'This Week';
      return `${ws.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${we.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    })()
    : (() => {
      const d = selectedDate ? new Date(selectedDate + 'T12:00:00') : new Date();
      return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    })();

  const addExcludeCat = (cat) => setExcludeCats((prev) => { const n = new Set(prev); n.add(cat); return n; });

  return (
    <div
      className={`fixed inset-0 z-50 ${fullscreen ? 'bg-white overflow-hidden' : 'bg-black/50 backdrop-blur-sm flex items-start justify-center p-4 pt-6 overflow-y-auto'}`}
      onClick={fullscreen ? undefined : onClose}
    >
      <div
        className={`bg-white flex flex-col ${fullscreen ? 'w-full h-full' : 'rounded-xl shadow-2xl w-full max-w-6xl max-h-[92vh]'}`}
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
            {isWeeklyView && (
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
            <button onClick={onPrevious} className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors" title="Previous">
              <ChevronLeft className="w-4 h-4 text-slate-500" />
            </button>
            <span className="text-xs font-medium text-slate-600 min-w-[110px] text-center">{dateLabel}</span>
            <button onClick={onNext} className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors" title="Next">
              <ChevronRight className="w-4 h-4 text-slate-500" />
            </button>
            <button onClick={onToday} className="px-2 py-1 text-[10px] font-medium text-blue-600 hover:bg-blue-50 rounded transition-colors border border-blue-200">
              {viewMode === 'weekly' ? 'This Week' : 'Today'}
            </button>
            <div className="w-px h-5 bg-slate-200" />
            <div className="flex items-center gap-2 text-xs">
              <span className="flex items-center gap-1 text-emerald-600 font-semibold">
                <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> Picked {mergedPickedCount}
              </span>
              <span className="flex items-center gap-1 text-slate-400 font-semibold">
                <span className="w-2 h-2 rounded-full bg-slate-400 inline-block" /> Not picked {mergedNotPickedCount}
              </span>
              {mergedExcludedCount > 0 && <span className="text-slate-300">({mergedExcludedCount} hidden)</span>}
            </div>
            <button onClick={() => setFullscreen((f) => !f)} className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors" title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
              {fullscreen ? <Minimize2 className="w-4 h-4 text-slate-400" /> : <Maximize2 className="w-4 h-4 text-slate-400" />}
            </button>
            <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors">
              <X className="w-4 h-4 text-slate-400" />
            </button>
          </div>
        </div>

        {/* Filter bar — single compact line */}
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

        {/* Timeline */}
        <div className="flex-1 overflow-y-auto px-5 py-2">
          <div className="space-y-0.5">
            {timelineItems.map((item, idx) => {
              if (item._dayHeader) {
                return <DayHeader key={item.key} dateStr={item.dateStr} dayPicked={item.dayPicked} dayNotPicked={item.dayNotPicked} dayTotal={item.dayTotal} />;
              }
              if (item._marker) {
                return <TimelineSeparator key={item.key} label={item.label} color={item.color} />;
              }
              const ticket = item;
              const picked = ticket._picked;
              const overnight = isOvernight(ticket);
              const wait = fmtWaitTime(ticket);
              const isExtended = ticket._section === 'after9am';
              return (
                <div
                  key={`${ticket.id}-${idx}`}
                  className={`border rounded overflow-hidden transition-all ${
                    picked
                      ? (isExtended ? 'bg-emerald-50/40 border-emerald-200' : 'bg-emerald-50 border-emerald-200')
                      : (isExtended ? 'bg-slate-50 border-slate-200 opacity-60' : 'bg-slate-100 border-slate-300 opacity-75')
                  }`}
                >
                  <div className="flex items-stretch">
                    <div className={`${PRIORITY_STRIP_COLORS[ticket.priority] || 'bg-slate-300'} w-1 flex-shrink-0`} />
                    <div className={`w-1 flex-shrink-0 ${picked ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                    <div className="flex-1 px-2 py-1.5 flex items-center gap-1.5 min-w-0">
                      {overnight
                        ? <Moon className="w-3 h-3 text-indigo-400 flex-shrink-0" />
                        : <Sunrise className="w-3 h-3 text-amber-500 flex-shrink-0" />}
                      <span className="text-slate-400 text-[10px] flex-shrink-0 whitespace-nowrap w-[68px]">
                        {new Date(ticket.createdAt).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Los_Angeles' })}{' '}
                        {new Date(ticket.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Los_Angeles' })}
                      </span>
                      <a
                        href={`https://${FRESHSERVICE_DOMAIN}/a/tickets/${ticket.freshserviceTicketId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:text-blue-800 flex-shrink-0"
                      >
                        <ExternalLink className="w-3 h-3" />
                      </a>
                      <span className={`font-medium text-xs truncate min-w-0 flex-1 ${picked ? 'text-slate-900' : 'text-slate-500'}`}>
                        {ticket.subject}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${picked ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' : 'bg-slate-200 text-slate-600'}`}>
                        {picked ? `✓ ${firstName}` : '✗ Not picked'}
                      </span>
                      <span className={`${STATUS_COLORS[ticket.status] || 'bg-slate-100 text-slate-600'} px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0`}>
                        {ticket.status}
                      </span>
                      {ticket.ticketCategory && (
                        <button
                          onClick={() => addExcludeCat(ticket.ticketCategory)}
                          className="px-1.5 py-0.5 rounded text-[10px] flex-shrink-0 truncate max-w-[100px] bg-slate-100 text-slate-600 hover:bg-red-50 hover:text-red-600 hover:line-through cursor-pointer"
                          title={`Click to hide "${ticket.ticketCategory}"`}
                        >
                          {ticket.ticketCategory}
                        </button>
                      )}
                      {!picked && ticket.assignedTechName && (
                        <span className="text-slate-500 font-semibold text-[10px] flex-shrink-0 whitespace-nowrap">
                          → {ticket.assignedTechName}
                        </span>
                      )}
                      {wait && (
                        <span className="bg-slate-100 text-slate-600 border border-slate-200 px-1.5 py-0.5 rounded text-[10px] font-semibold flex-shrink-0 whitespace-nowrap" title="Time to first assignment">
                          ⏱ {wait}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer legend */}
        <div className="px-5 py-2 border-t border-slate-200 flex items-center gap-5 text-[10px] text-slate-400 flex-shrink-0">
          <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> Picked</div>
          <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-slate-400 inline-block" /> Not picked</div>
          <div className="flex items-center gap-1"><Moon className="w-3 h-3 text-indigo-400" /> Overnight</div>
          <div className="flex items-center gap-1"><Sunrise className="w-3 h-3 text-amber-500" /> Morning</div>
          <div className="flex items-center gap-1"><span className="w-4 h-0.5 bg-emerald-400 inline-block rounded" /> {firstName} online</div>
          <div className="flex items-center gap-1"><span className="w-4 h-0.5 bg-blue-400 inline-block rounded" /> HQ online</div>
          <div className="flex items-center gap-1"><span className="w-4 h-0.5 bg-red-400 inline-block rounded" /> {firstName} off</div>
        </div>
      </div>
    </div>
  );
}
