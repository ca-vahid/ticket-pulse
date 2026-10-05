import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import FancySelect from '../common/FancySelect';
import { availabilityAPI } from '../../services/api';
import {
  BTN_QUIET, CARD, COVERAGE_BG, ErrorNote, HOLIDAY_BG, HOLIDAY_DOT, MONTHS, Toggle, WEEKEND_BG,
  fmtDay, parseDay, todayKey,
} from './availabilityUi';
import {
  WEEKDAY_LETTER, coverageByDay, coverageTone, entrySegments, groupPeople, isWeekend, monthRange, nextWeeksRange, rangeDays,
} from './calendarModel';
import {
  AgendaList, DayTypeLegend, Segmented, TeamAvatar, barLook, entryWords, personName, useRoster,
} from './teamViews';

/**
 * Wallchart (5 Oct 2026 redesign; was the plain month grid): people down,
 * days across, all seven days. Faces and names in a narrow sticky column,
 * rows grouped by office (or approval group), one bar per leave — solid when
 * approved, dashed when waiting (approvers only), hatched for part of a day —
 * split around weekends and holidays. A strip under the dates counts who is
 * away each day. Weekends are grey, holidays rose with their name, today
 * marked. Below `md` the same data is a list by day.
 *
 * View choices live in the address (?range=4w&group=group&office=2&month=2026-11)
 * so a view can be shared.
 */

function useViewParams() {
  const [params, setParams] = useSearchParams();
  const set = useCallback((patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined || v === '') next.delete(k);
      else next.set(k, String(v));
    }
    setParams(next, { replace: true });
  }, [params, setParams]);
  return [params, set];
}

export default function TeamCalendarPanel({ me }) {
  const today = todayKey();
  const [params, setParam] = useViewParams();
  const range = params.get('range') === '4w' ? '4w' : 'month';
  const groupMode = params.get('group') === 'group' ? 'group' : 'office';
  const officeId = params.get('office') || '';
  const monthParam = /^\d{4}-\d{2}$/.test(params.get('month') || '') ? params.get('month') : null;
  const cursor = useMemo(() => {
    if (monthParam) { const [y, m] = monthParam.split('-').map(Number); return { year: y, month: m - 1 }; }
    const d = parseDay(today);
    return { year: d.getFullYear(), month: d.getMonth() };
  }, [monthParam, today]);

  const [onlyAway, setOnlyAway] = useState(false);
  const [showPending, setShowPending] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const { roster, byEmail } = useRoster();

  const { from, to } = range === '4w' ? nextWeeksRange(today) : monthRange(cursor.year, cursor.month);
  const days = useMemo(() => rangeDays(from, to), [from, to]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    availabilityAPI.calendar({ from, to, ...(officeId ? { officeId } : {}) })
      .then((res) => { if (live) { setData(res?.data || null); setError(null); } })
      .catch((err) => { if (live) setError(err?.message || 'Could not load the wallchart'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [from, to, officeId]);

  const holidayNames = useMemo(() => data?.holidayNames || Object.fromEntries((data?.holidays || []).map((k) => [k, 'Holiday'])), [data]);
  const isNonWorking = useCallback((d) => isWeekend(d.dow) || Boolean(holidayNames[d.key]), [holidayNames]);
  const canSeePending = Boolean(data?.canSeePending) || (data?.entries || []).some((e) => e.status === 'pending');
  const entries = useMemo(() => (data?.entries || []).filter((e) => showPending || e.status !== 'pending'), [data, showPending]);
  const entriesByEmail = useMemo(() => {
    const m = new Map();
    for (const e of entries) {
      if (!m.has(e.email)) m.set(e.email, []);
      m.get(e.email).push(e);
    }
    return m;
  }, [entries]);
  const coverage = useMemo(() => coverageByDay(entries, days, isNonWorking), [entries, days, isNonWorking]);

  const people = useMemo(() => {
    const all = (data?.people || []).map((p) => ({ ...p, name: personName(p.email, byEmail, p.name) }));
    return onlyAway ? all.filter((p) => entriesByEmail.get(p.email)?.length) : all;
  }, [data, onlyAway, entriesByEmail, byEmail]);
  const teamSize = (data?.people || []).length;

  const groupsAvailable = (roster?.groups || []).length > 0;
  const sections = useMemo(() => groupPeople(people, groupsAvailable ? groupMode : 'office', {
    offices: roster?.offices || me.offices || [],
    groups: roster?.groups || [],
    groupIdsOf: (p) => byEmail.get(p.email)?.groupIds || [],
  }), [people, groupMode, groupsAvailable, roster, me.offices, byEmail]);

  const step = (n) => {
    const d = new Date(cursor.year, cursor.month + n, 1);
    setParam({ month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, range: null });
  };
  const goToday = () => setParam({ month: null });

  const officeOptions = [{ value: '', label: 'All offices' }, ...((roster?.offices || me.offices || []).map((o) => ({ value: String(o.id), label: o.name })))];
  const title = range === '4w'
    ? `${fmtDay(from, { month: 'short', day: 'numeric' })} – ${fmtDay(to, { month: 'short', day: 'numeric' })}`
    : `${MONTHS[cursor.month]} ${cursor.year}`;
  const gridCols = `minmax(10.5rem, 12rem) repeat(${days.length}, minmax(1.75rem, 1fr))`;
  const n = days.length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-1">
          <button type="button" className={BTN_QUIET} onClick={() => step(-1)} aria-label="Previous month" disabled={range === '4w'}><ChevronLeft className="h-4 w-4" aria-hidden="true" /></button>
          <h2 className="min-w-[9.5rem] text-center text-sm font-semibold text-foreground" aria-live="polite">{title}</h2>
          <button type="button" className={BTN_QUIET} onClick={() => step(1)} aria-label="Next month" disabled={range === '4w'}><ChevronRight className="h-4 w-4" aria-hidden="true" /></button>
          <button type="button" className={BTN_QUIET} onClick={goToday}>Today</button>
        </div>
        <Segmented label="Range" value={range} onChange={(v) => setParam({ range: v === '4w' ? '4w' : null, month: null })}
          options={[{ value: 'month', label: 'Month' }, { value: '4w', label: 'Next 4 weeks' }]} />
        {groupsAvailable && (
          <Segmented label="Group rows by" value={groupMode} onChange={(v) => setParam({ group: v === 'group' ? 'group' : null })}
            options={[{ value: 'office', label: 'By office' }, { value: 'group', label: 'By approval group' }]} />
        )}
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading" />}
          <div className="w-40"><FancySelect value={officeId} onChange={(v) => setParam({ office: v || null })} options={officeOptions} aria-label="Office" /></div>
          {canSeePending && <Toggle checked={showPending} onChange={setShowPending} label="Show waiting requests" />}
          <Toggle checked={onlyAway} onChange={setOnlyAway} label="Only people who are away" />
        </div>
      </div>

      <ErrorNote>{error}</ErrorNote>

      <div className={`${CARD} hidden p-0 md:block`}>
        <div className="settings-scrollbar overflow-x-auto" data-testid="team-calendar-scroll">
          <div role="grid" aria-label={`Wallchart, ${title}`} aria-rowcount={people.length + 1} className="min-w-max text-xs" style={{ display: 'grid', gridTemplateColumns: gridCols }}>
            {/* dates */}
            <div role="row" style={{ display: 'contents' }}>
              <div role="columnheader" className="sticky left-0 z-20 flex items-end border-b border-border bg-card px-3 pb-1.5 text-[11px] text-muted-foreground">
                {teamSize} {teamSize === 1 ? 'person' : 'people'}
              </div>
              {days.map((d) => {
                const holiday = holidayNames[d.key];
                const isToday = d.key === today;
                return (
                  <div
                    key={d.key}
                    role="columnheader"
                    aria-current={isToday ? 'date' : undefined}
                    title={holiday ? `${fmtDay(d.key)} · ${holiday}` : fmtDay(d.key)}
                    className={`relative border-b border-border pb-1 pt-2 text-center leading-none ${holiday ? HOLIDAY_BG : isWeekend(d.dow) ? WEEKEND_BG : ''}`}
                  >
                    {holiday && <span className={`absolute right-1 top-1 h-1.5 w-1.5 rounded-full ${HOLIDAY_DOT}`} aria-hidden="true" />}
                    <span className="block text-[10px] text-muted-foreground">{WEEKDAY_LETTER[d.dow]}</span>
                    <span className={`mx-auto mt-1 block w-6 rounded-md py-0.5 tabular-nums ${isToday ? 'bg-primary font-semibold text-primary-foreground' : 'text-foreground/85'}`}>{d.n}</span>
                    {holiday && <span className="sr-only">{holiday}</span>}
                  </div>
                );
              })}
            </div>
            {/* who is away each day */}
            <div role="row" style={{ display: 'contents' }} data-testid="wallchart-coverage">
              <div role="rowheader" className="sticky left-0 z-20 bg-card px-3 py-1 text-[11px] text-muted-foreground">Away</div>
              {days.map((d) => {
                const out = coverage.get(d.key) || [];
                const tone = isNonWorking(d) ? 'none' : coverageTone(out.length, teamSize);
                const names = out.map((e) => personName(e, byEmail)).join(', ');
                return (
                  <div key={d.key} role="gridcell" className="px-[3px] py-1.5" title={out.length ? `${out.length} away: ${names}` : 'Nobody away'}>
                    <span className={`block h-1.5 rounded-full ${COVERAGE_BG[tone]}`} aria-hidden="true" />
                    <span className="sr-only">{out.length ? `${out.length} away: ${names}` : 'Nobody away'}</span>
                  </div>
                );
              })}
            </div>
            {sections.map((section) => (
              <div key={section.key} style={{ display: 'contents' }}>
                {sections.length > 1 && (
                  <div role="row" style={{ display: 'contents' }}>
                    <div role="rowheader" className="sticky left-0 z-10 col-span-1 bg-card px-3 pb-1 pt-4 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{section.label}</div>
                    <div aria-hidden="true" style={{ gridColumn: `2 / span ${n}` }} />
                  </div>
                )}
                {section.people.map((p) => (
                  <div key={`${section.key}-${p.email}`} role="row" style={{ display: 'contents' }} data-testid={`cal-row-${p.email}`}>
                    <div role="rowheader" className="sticky left-0 z-10 flex h-10 items-center gap-2 border-t border-border/60 bg-card px-3">
                      <TeamAvatar email={p.email} name={p.name} byEmail={byEmail} size="h-6 w-6" />
                      <span className="truncate text-[13px] text-foreground">{p.name}</span>
                    </div>
                    <div className="relative h-10 border-t border-border/60" style={{ gridColumn: `2 / span ${n}`, display: 'grid', gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
                      {days.map((d) => (
                        <div
                          key={d.key}
                          role="gridcell"
                          data-testid={`cal-cell-${p.email}-${d.key}`}
                          className={`${holidayNames[d.key] ? HOLIDAY_BG : isWeekend(d.dow) ? WEEKEND_BG : ''} ${d.key === today ? 'bg-primary/[0.07]' : ''}`}
                        />
                      ))}
                      {(entriesByEmail.get(p.email) || []).flatMap((e, ei) => entrySegments(e, days, isNonWorking).map((seg) => {
                        const look = barLook(e);
                        const len = seg.end - seg.start + 1;
                        const half = e.dayPart === 'am' || e.dayPart === 'pm';
                        const leftDays = seg.start + (e.dayPart === 'pm' ? 0.5 : 0);
                        const widthDays = half ? 0.5 : len;
                        const hours = e.dayPart === 'hours';
                        const words = entryWords(e, p.name);
                        return (
                          <span
                            key={`${e.id ?? ei}-${seg.start}`}
                            role="img"
                            aria-label={words}
                            title={words}
                            data-testid={`cal-bar-${p.email}-${days[seg.start].key}`}
                            data-status={e.status}
                            className={`absolute flex items-center overflow-hidden whitespace-nowrap rounded-md px-1.5 text-[11px] font-medium ${look.className} ${hours ? 'bottom-1.5 h-1.5 px-0' : 'top-1/2 h-6 -translate-y-1/2'}`}
                            style={{ ...look.style, left: `calc(${leftDays} * 100% / ${n} + 2px)`, width: `calc(${widthDays} * 100% / ${n} - 4px)` }}
                          >
                            {!hours && seg.first && len >= 2 ? (e.label || 'Away') : ''}
                          </span>
                        );
                      }))}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
          {!people.length && !loading && (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">{onlyAway ? 'Nobody is away in this period.' : 'No people to show.'}</p>
          )}
        </div>
      </div>

      <div className={`${CARD} md:hidden`}>
        <AgendaList days={days} entries={entries} byEmail={byEmail} holidayNames={holidayNames} />
      </div>

      <DayTypeLegend entries={entries} showPending={canSeePending && showPending} />
    </div>
  );
}
