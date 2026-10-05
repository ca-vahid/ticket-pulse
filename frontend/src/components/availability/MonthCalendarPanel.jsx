import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import FancySelect from '../common/FancySelect';
import { availabilityAPI } from '../../services/api';
import {
  BTN_QUIET, CARD, ErrorNote, HOLIDAY_BG, MONTHS, Toggle, WEEKEND_BG, parseDay, todayKey,
} from './availabilityUi';
import { isWeekend, monthWeeks, rangeDays, weekLanes } from './calendarModel';
import { AgendaList, DayTypeLegend, barLook, entryWords, personName, useRoster } from './teamViews';

/**
 * Calendar (5 Oct 2026): the month, Monday first, all seven days. Each leave
 * is a continuous bar with the person's name, stacked under the days it
 * covers; holidays name themselves; weekends are grey; today is marked.
 * A busy week shows the first lanes and "+N more". Narrow screens get the
 * list by day.
 */

const DAY_HEAD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MAX_LANES = 5;
const LANE_H = 22;
const TOP = 28;

export default function MonthCalendarPanel({ me }) {
  const today = todayKey();
  const now = parseDay(today);
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() });
  const [officeId, setOfficeId] = useState('');
  const [showPending, setShowPending] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const { roster, byEmail } = useRoster();

  const weeks = useMemo(() => monthWeeks(cursor.year, cursor.month), [cursor]);
  const from = weeks[0][0];
  const to = weeks[weeks.length - 1][6];
  const days = useMemo(() => rangeDays(from, to), [from, to]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    availabilityAPI.calendar({ from, to, ...(officeId ? { officeId } : {}) })
      .then((res) => { if (live) { setData(res?.data || null); setError(null); } })
      .catch((err) => { if (live) setError(err?.message || 'Could not load the calendar'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [from, to, officeId]);

  const holidayNames = useMemo(() => data?.holidayNames || {}, [data]);
  const canSeePending = Boolean(data?.canSeePending) || (data?.entries || []).some((e) => e.status === 'pending');
  const entries = useMemo(() => (data?.entries || []).filter((e) => showPending || e.status !== 'pending'), [data, showPending]);
  const monthIndex = cursor.month;

  const step = (k) => setCursor((c) => {
    const d = new Date(c.year, c.month + k, 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const officeOptions = [{ value: '', label: 'All offices' }, ...((roster?.offices || me.offices || []).map((o) => ({ value: String(o.id), label: o.name })))];
  const monthDays = days.filter((d) => d.month === monthIndex);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-1">
          <button type="button" className={BTN_QUIET} onClick={() => step(-1)} aria-label="Previous month"><ChevronLeft className="h-4 w-4" aria-hidden="true" /></button>
          <h2 className="min-w-[9.5rem] text-center text-sm font-semibold text-foreground" aria-live="polite">{MONTHS[cursor.month]} {cursor.year}</h2>
          <button type="button" className={BTN_QUIET} onClick={() => step(1)} aria-label="Next month"><ChevronRight className="h-4 w-4" aria-hidden="true" /></button>
          <button type="button" className={BTN_QUIET} onClick={() => setCursor({ year: now.getFullYear(), month: now.getMonth() })}>Today</button>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading" />}
          <div className="w-40"><FancySelect value={officeId} onChange={setOfficeId} options={officeOptions} aria-label="Office" /></div>
          {canSeePending && <Toggle checked={showPending} onChange={setShowPending} label="Show waiting requests" />}
        </div>
      </div>

      <ErrorNote>{error}</ErrorNote>

      <div className={`${CARD} hidden overflow-hidden p-0 md:block`} data-testid="month-calendar">
        <div className="grid grid-cols-7 border-b border-border">
          {DAY_HEAD.map((d, i) => (
            <div key={d} className={`px-2.5 py-2 text-[11px] font-semibold text-muted-foreground ${i >= 5 ? WEEKEND_BG : ''}`}>{d}</div>
          ))}
        </div>
        {weeks.map((week) => {
          const placed = weekLanes(entries, week);
          const shown = placed.filter((x) => x.lane < MAX_LANES);
          const hidden = placed.filter((x) => x.lane >= MAX_LANES);
          const lanes = Math.min(MAX_LANES, placed.reduce((m, x) => Math.max(m, x.lane + 1), 0));
          return (
            <div key={week[0]} className="relative grid grid-cols-7 border-b border-border/70 last:border-b-0" style={{ minHeight: `${Math.max(96, TOP + lanes * LANE_H + (hidden.length ? 22 : 8))}px` }}>
              {week.map((k) => {
                const d = parseDay(k);
                const holiday = holidayNames[k];
                const outside = d.getMonth() !== monthIndex;
                return (
                  <div key={k} className={`border-l border-border/60 px-2 pt-1.5 first:border-l-0 ${holiday ? HOLIDAY_BG : isWeekend(d.getDay()) ? WEEKEND_BG : ''} ${outside ? 'opacity-50' : ''}`}>
                    <span className={`inline-block rounded-md px-1 text-xs tabular-nums ${k === today ? 'bg-primary font-semibold text-primary-foreground' : 'text-muted-foreground'}`} aria-current={k === today ? 'date' : undefined}>{d.getDate()}</span>
                    {holiday && <span className="ml-1.5 align-middle text-[11px] font-medium text-rose-600 dark:text-rose-300">{holiday}</span>}
                  </div>
                );
              })}
              {shown.map(({ entry, start, end, lane }) => {
                const name = personName(entry.email, byEmail);
                const look = barLook(entry);
                const words = entryWords(entry, name);
                return (
                  <span
                    key={`${entry.id ?? entry.email}-${entry.startDate}-${start}`}
                    role="img"
                    aria-label={words}
                    title={words}
                    className={`absolute flex items-center overflow-hidden whitespace-nowrap rounded-md px-2 text-[11.5px] font-medium ${look.className}`}
                    style={{ ...look.style, top: `${TOP + lane * LANE_H}px`, height: `${LANE_H - 3}px`, left: `calc(${start} * 100% / 7 + 4px)`, width: `calc(${end - start + 1} * 100% / 7 - 8px)` }}
                  >
                    {name}
                  </span>
                );
              })}
              {hidden.length > 0 && (
                <span
                  className="absolute bottom-1 left-2 text-[11px] text-muted-foreground"
                  title={hidden.map((x) => entryWords(x.entry, personName(x.entry.email, byEmail))).join('\n')}
                >
                  +{hidden.length} more this week
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className={`${CARD} md:hidden`}>
        <AgendaList days={monthDays} entries={entries} byEmail={byEmail} holidayNames={holidayNames} />
      </div>

      <DayTypeLegend entries={entries} showPending={canSeePending && showPending} />
    </div>
  );
}
