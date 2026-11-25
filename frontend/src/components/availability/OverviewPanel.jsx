import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react';
import { availabilityAPI } from '../../services/api';
import {
  CARD, COLOR_DOT, ErrorNote, REQUEST_STATUS, addDaysKey, fmtDay, fmtMinute, fmtRange, leaveLabel, parseDay, sitePlace, todayKey, trimNum,
} from './availabilityUi';
import {
  WEEKDAY_SHORT, collapseDuplicateEntries, daysUntil, isWeekend, nextWorkingDayKey, rangeDays, weekStartKey,
} from './calendarModel';
import { TeamAvatar, entryLabel, personName, useRoster } from './teamViews';

/**
 * Overview, the default tab (redesigned 15 Nov 2026, Vahid).
 *
 * The page ranks people by how much they affect the team: AWAY first (off all
 * day), then OUT FOR PART OF THE DAY (appointments, half days, with the
 * hours), and working from home or on site last and small, because those
 * people are still reachable. Days already past are not listed.
 *
 *   1. You and the team pulse: your balance, your next time away, one-click
 *      booking; beside it the people away on each of the next 20 working days.
 *   2. The week: a column per day; a multi-day absence is one bar across the
 *      top instead of a row per day.
 *   3. What is waiting for you, and what is coming up.
 */

const ART = '/brand/vacation-pulse';
const PULSE_DAYS = 20;
const AWAY_TEXT = 'text-rose-600 dark:text-rose-300';
const PART_TEXT = 'text-amber-700 dark:text-amber-300';

const isPartial = (e) => ['am', 'pm', 'hours'].includes(e.dayPart) || e.availability === 'PARTIAL';
const isRemote = (e) => !isPartial(e) && (e.availability === 'WFH' || e.availability === 'ONSITE');
const isAway = (e) => !isPartial(e) && (!e.availability || e.availability === 'OFF');
const partWords = (e) => {
  if (e.dayPart === 'am') return 'morning';
  if (e.dayPart === 'pm') return 'afternoon';
  if (e.dayPart === 'hours' && e.startMinute != null) return `${fmtMinute(e.startMinute)}–${fmtMinute(e.endMinute)}`;
  return 'part of the day';
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The pictogram for a leave type, by what it is. */
export function pictogramFor(type) {
  const key = `${type?.key || ''} ${type?.name || ''}`.toLowerCase();
  if (/sick|medical leave|illness/.test(key)) return 'sick';
  if (type?.availability === 'WFH' || /home|remote/.test(key)) return 'wfh';
  if (type?.availability === 'ONSITE' || /site|field|travel/.test(key)) return 'site';
  if (type?.unit === 'hour' || /appoint|personal|errand/.test(key)) return 'appointment';
  return 'vacation';
}

function Pictogram({ name, className = 'h-5 w-5' }) {
  return <img src={`${ART}/${name}.webp`} alt="" aria-hidden="true" draggable="false" className={`shrink-0 select-none object-contain ${className}`} />;
}

/**
 * One week as columns. Returns { days, lanes, perDay } where a lane is an
 * all-day absence covering two or more of the days shown, and perDay holds
 * the rest: { away, part, remote, waiting, out } per day key.
 */
export function buildWeek(entries, weekFrom, today, holidaySet) {
  const all = rangeDays(weekFrom, addDaysKey(weekFrom, 6));
  const touches = (d) => (entries || []).some((e) => e.startDate <= d.key && e.endDate >= d.key && (e.startDate === e.endDate || e.startDate === d.key || e.endDate === d.key));
  const days = all.filter((d) => !isWeekend(d.dow) || d.key === today || touches(d));
  const nonWorking = (d) => isWeekend(d.dow) || holidaySet.has(d.key);
  const perDay = new Map(days.map((d) => [d.key, { away: [], part: [], remote: [], waiting: 0, out: new Set() }]));
  const lanes = [];
  const rows = [];
  const seen = new Set();
  const sorted = [...(entries || [])].sort((a, b) => a.startDate.localeCompare(b.startDate) || b.endDate.localeCompare(a.endDate) || a.email.localeCompare(b.email));
  for (const e of sorted) {
    if (!['approved', 'pending'].includes(e.status) || e.availability === 'NONE') continue;
    const dupe = `${e.email}|${e.startDate}|${e.endDate}|${e.label}`;
    if (seen.has(dupe)) continue;
    seen.add(dupe);
    const single = e.startDate === e.endDate;
    const covered = days.map((d, i) => (d.key >= e.startDate && d.key <= e.endDate && (single || !nonWorking(d)) ? i : -1)).filter((i) => i >= 0);
    if (!covered.length) continue;
    const kind = isAway(e) ? 'away' : isPartial(e) ? 'part' : isRemote(e) ? 'remote' : 'away';
    for (const i of covered) {
      const cell = perDay.get(days[i].key);
      if (e.status === 'pending') cell.waiting += 1;
      else if (kind === 'away') cell.out.add(e.email);
    }
    if (kind === 'away' && covered.length >= 2) {
      const start = covered[0];
      const end = covered[covered.length - 1];
      let row = 0;
      while (rows[row] && rows[row].some(([a, b]) => !(end < a || start > b))) row += 1;
      (rows[row] = rows[row] || []).push([start, end]);
      lanes.push({ entry: e, start, end, row });
      for (const i of covered) perDay.get(days[i].key).away.push({ entry: e, inLane: true });
    } else {
      for (const i of covered) perDay.get(days[i].key)[kind].push({ entry: e, inLane: false });
    }
  }
  return { days, lanes, perDay, laneRows: rows.length };
}

function Ring({ share, over }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  const used = over ? c : Math.max(0, Math.min(1, share)) * c;
  return (
    <svg viewBox="0 0 56 56" className={`h-12 w-12 shrink-0 ${over ? 'text-rose-500' : 'text-emerald-500'}`} aria-hidden="true">
      <circle cx="28" cy="28" r={r} fill="none" strokeWidth="6" className="stroke-border" />
      {used > 0 && <circle cx="28" cy="28" r={r} fill="none" strokeWidth="6" stroke="currentColor" strokeLinecap="round" strokeDasharray={`${used} ${c}`} transform="rotate(-90 28 28)" />}
    </svg>
  );
}

function MyBalances({ me }) {
  const typeById = new Map((me.leaveTypes || []).map((t) => [t.id, t]));
  const balances = me.balances || [];
  if (!balances.length) return <p className="text-sm text-muted-foreground">No leave type tracks a balance for you.</p>;
  return (
    <ul className="flex flex-wrap gap-x-7 gap-y-3" data-testid="my-balances">
      {balances.map((b) => {
        const name = b.name || typeById.get(b.leaveTypeId)?.name || 'Time away';
        const entitled = Number(b.entitled || 0) + Number(b.adjustments || 0);
        const remaining = Number(b.remaining || 0);
        const over = remaining < 0;
        const used = Number(b.taken || 0) + Number(b.scheduled || 0);
        const extra = [Number(b.scheduled) > 0 ? `${trimNum(b.scheduled)} booked` : null, Number(b.pending) > 0 ? `${trimNum(b.pending)} waiting` : null].filter(Boolean).join(', ');
        return (
          <li key={`${b.leaveTypeId}-${b.year}`} className="flex items-center gap-3">
            <Ring share={entitled > 0 ? used / entitled : 0} over={over} />
            <span className="leading-tight">
              <span className={`block text-lg font-semibold tabular-nums ${over ? AWAY_TEXT : 'text-foreground'}`}>
                {trimNum(Math.abs(remaining))} {over ? 'over' : 'left'}
              </span>
              <span className="block text-xs text-muted-foreground">{name} · {trimNum(b.taken)} of {trimNum(entitled)} taken{extra ? ` · ${extra}` : ''}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function TeamPulse({ entries, today, holidaySet, teamSize, byEmail }) {
  const days = useMemo(() => rangeDays(today, addDaysKey(today, 45)).filter((d) => !isWeekend(d.dow) && !holidaySet.has(d.key)).slice(0, PULSE_DAYS), [today, holidaySet]);
  const counts = useMemo(() => days.map((d) => {
    const out = new Set();
    for (const e of entries || []) {
      if (e.status !== 'approved' || !isAway(e) || d.key < e.startDate || d.key > e.endDate) continue;
      out.add(e.email);
    }
    return { day: d, emails: [...out] };
  }), [days, entries]);
  const max = Math.max(1, ...counts.map((c) => c.emails.length));
  const peak = counts.reduce((best, c) => (c.emails.length > (best?.emails.length || 0) ? c : best), null);
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Team pulse</p>
          <h2 id="ov-pulse" className="text-sm font-semibold text-foreground">People away, next {days.length} working days</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          {peak && peak.emails.length > 0
            ? <>most on <span className={`font-semibold ${AWAY_TEXT}`}>{fmtDay(peak.day.key)}</span> · {peak.emails.length} of {teamSize || '?'} away</>
            : 'Nobody is booked away.'}
        </p>
      </div>
      <ol className="mt-3 grid items-end gap-1" style={{ gridTemplateColumns: `repeat(${Math.max(1, counts.length)}, minmax(0, 1fr))`, height: '5.5rem' }} data-testid="coverage-strip">
        {counts.map(({ day, emails }) => {
          const names = emails.map((em) => personName(em, byEmail)).join(', ');
          const hot = peak && emails.length === peak.emails.length && emails.length > 1;
          return (
            <li key={day.key} className="flex h-full flex-col justify-end" title={`${fmtDay(day.key)}: ${emails.length ? `${emails.length} away: ${names}` : 'nobody away'}`}>
              <span
                className={`block w-full rounded-t-[4px] rounded-b-[2px] ${emails.length === 0 ? 'bg-border' : hot ? 'bg-gradient-to-b from-rose-500 to-amber-400' : 'bg-gradient-to-b from-violet-500 to-teal-500 opacity-85'} ${day.key === today ? 'ring-2 ring-primary ring-offset-2 ring-offset-card' : ''}`}
                style={{ height: emails.length === 0 ? '3px' : `${Math.max(14, (emails.length / max) * 100)}%` }}
              />
              <span className="sr-only">{fmtDay(day.key)}: {emails.length} away{names ? `: ${names}` : ''}</span>
            </li>
          );
        })}
      </ol>
      <div className="mt-1 grid gap-1 text-[10px] text-muted-foreground" style={{ gridTemplateColumns: `repeat(${Math.max(1, counts.length)}, minmax(0, 1fr))` }} aria-hidden="true">
        {counts.map(({ day }, i) => (
          <span key={day.key} className={`whitespace-nowrap ${day.key === today ? 'font-semibold text-primary' : ''}`}>
            {i === 0 || day.dow === 1 ? `${WEEKDAY_SHORT[day.dow]} ${day.n}` : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

function DayItem({ entry, kind, byEmail, holidays, phoneOnly = false }) {
  const name = personName(entry.email, byEmail);
  const pending = entry.status === 'pending';
  const back = WEEKDAY_SHORT[parseDay(nextWorkingDayKey(entry.endDate, holidays)).getDay()];
  return (
    <li className={`flex min-w-0 items-center gap-2 ${phoneOnly ? 'sm:hidden' : ''}`}>
      <TeamAvatar email={entry.email} name={name} byEmail={byEmail} size="h-7 w-7" textSize="text-[10px]" />
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-[13px] font-medium text-foreground">{name}</span>
        <span className={`block truncate text-xs ${pending ? 'text-muted-foreground' : kind === 'part' ? PART_TEXT : AWAY_TEXT}`}>
          {entryLabel(entry)} · {kind === 'part' ? partWords(entry) : <span>back {back}</span>}
          {pending ? ' · waiting for approval' : ''}
        </span>
      </span>
    </li>
  );
}

function WeekBoard({ week, today, byEmail, holidays, holidayNames, teamSize }) {
  const { days, lanes, perDay, laneRows } = week;
  const cols = { gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` };
  return (
    <div data-testid="out-this-week">
      {lanes.length > 0 && (
        <div className="hidden gap-y-1.5 border-b border-border/70 px-2 py-2.5 sm:grid" style={{ ...cols, gridTemplateRows: `repeat(${laneRows}, auto)` }} aria-hidden="true">
          {lanes.map(({ entry, start, end, row }) => {
            const pending = entry.status === 'pending';
            return (
              <div
                key={`${entry.email}-${entry.id ?? entry.startDate}`}
                className={`mx-1 flex min-w-0 items-center gap-2 rounded-lg py-1 pl-1 pr-2.5 text-xs ${pending ? 'border border-dashed border-input text-muted-foreground' : 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-200'}`}
                style={{ gridColumn: `${start + 1} / span ${end - start + 1}`, gridRow: row + 1 }}
              >
                <TeamAvatar email={entry.email} name={personName(entry.email, byEmail)} byEmail={byEmail} size="h-6 w-6" textSize="text-[10px]" />
                <span className="truncate">
                  <span className="font-semibold">{personName(entry.email, byEmail)}</span>
                  <span className="opacity-85"> · {entryLabel(entry)}{pending ? ' · waiting for approval' : ''} · back {fmtDay(nextWorkingDayKey(entry.endDate, holidays))}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}
      <div>
        <div className="grid grid-cols-1 divide-y divide-border/70 sm:grid-cols-none sm:divide-x sm:divide-y-0 sm:[grid-template-columns:var(--cols)]" style={{ '--cols': cols.gridTemplateColumns }}>
          {days.map((d) => {
            const cell = perDay.get(d.key);
            const holiday = holidayNames[d.key];
            const out = cell.out.size;
            const inCount = Math.max(0, teamSize - out);
            const thin = teamSize > 0 && out / teamSize >= 0.2;
            const remotePeople = [...new Map(cell.remote.filter((r) => r.entry.status === 'approved').map((r) => [r.entry.email, r.entry])).values()];
            const allHome = remotePeople.every((e) => e.availability === 'WFH');
            const laneOnly = cell.away.filter((a) => a.inLane);
            const ownAway = cell.away.filter((a) => !a.inLane);
            const nothing = !ownAway.length && !cell.part.length;
            return (
              <section key={d.key} className={`min-w-0 px-3 py-3 ${d.key < today ? 'opacity-60' : ''}`} aria-label={fmtDay(d.key, { weekday: 'long', month: 'long', day: 'numeric' })}>
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className={`text-[13px] font-semibold ${d.key === today ? 'text-primary' : 'text-foreground'}`}>
                    {WEEKDAY_SHORT[d.dow]} {d.n}{d.key === today ? ' · today' : ''}
                  </h3>
                  {teamSize > 0 && !holiday && <span className={`text-[11px] tabular-nums ${thin ? PART_TEXT : 'text-muted-foreground'}`}>{inCount} of {teamSize} in</span>}
                </div>
                {teamSize > 0 && !holiday && (
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                    <span className={`block h-full ${thin ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${(inCount / teamSize) * 100}%` }} />
                  </div>
                )}
                {holiday && <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><Pictogram name="holiday" className="h-5 w-5" />{holiday}</p>}
                {/* Offices keep different holidays: anyone booked that day still shows. */}
                {(!holiday || !nothing || laneOnly.length > 0) && (
                  <ul className="mt-2.5 space-y-2.5">
                    {laneOnly.map(({ entry }) => <DayItem key={`l-${entry.email}-${entry.id ?? entry.startDate}`} entry={entry} kind="away" byEmail={byEmail} holidays={holidays} phoneOnly />)}
                    {ownAway.map(({ entry }) => <DayItem key={`a-${entry.email}-${entry.id ?? entry.startDate}`} entry={entry} kind="away" byEmail={byEmail} holidays={holidays} />)}
                    {cell.part.map(({ entry }) => <DayItem key={`p-${entry.email}-${entry.id ?? entry.startDate}-${entry.startMinute ?? entry.dayPart}`} entry={entry} kind="part" byEmail={byEmail} holidays={holidays} />)}
                    {nothing && !holiday && <li className={`text-xs text-muted-foreground ${laneOnly.length ? 'hidden sm:block' : ''}`}>{laneOnly.length ? 'Nobody else is out.' : 'Nobody is out.'}</li>}
                  </ul>
                )}
                {remotePeople.length > 0 && !holiday && (
                  <p className="mt-3 flex items-center gap-2 border-t border-dashed border-border pt-2 text-[11px] text-muted-foreground" title={remotePeople.map((e) => `${personName(e.email, byEmail)} (${e.label ? entryLabel(e) : 'remote'})`).join(', ')}>
                    <span className="flex -space-x-1.5">
                      {remotePeople.slice(0, 3).map((e) => (
                        <span key={e.email} className="rounded-full ring-2 ring-card"><TeamAvatar email={e.email} name={personName(e.email, byEmail)} byEmail={byEmail} size="h-5 w-5" textSize="text-[8px]" /></span>
                      ))}
                    </span>
                    <span>{remotePeople.length} {allHome ? 'at home' : 'working remotely'}</span>
                    <span className="sr-only">: {remotePeople.map((e) => personName(e.email, byEmail)).join(', ')}</span>
                  </p>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function OverviewPanel({ me, base = '/availability', onBook = null }) {
  const today = todayKey();
  const [weekOffset, setWeekOffset] = useState(0);
  const weekFrom = addDaysKey(weekStartKey(today), weekOffset * 7);
  const weekTo = addDaysKey(weekFrom, 6);
  const pulseTo = addDaysKey(today, 45);
  const from = weekFrom < today ? weekFrom : today;
  const to = weekTo > pulseTo ? weekTo : pulseTo;
  const [data, setData] = useState(null);
  const [holidays, setHolidays] = useState(null);
  const [mine, setMine] = useState(null);
  const [approvals, setApprovals] = useState(null);
  const [error, setError] = useState(null);
  const { byEmail } = useRoster();

  useEffect(() => {
    let live = true;
    availabilityAPI.calendar({ from, to })
      .then((res) => { if (live) { setData(res?.data || null); setError(null); } })
      .catch((err) => { if (live) setError(err?.message || 'Could not load who is out'); });
    return () => { live = false; };
  }, [from, to]);
  useEffect(() => {
    let live = true;
    availabilityAPI.upcomingHolidays(3)
      .then((res) => { if (live) setHolidays(Array.isArray(res?.data) ? res.data : []); })
      .catch(() => { if (live) setHolidays([]); });
    availabilityAPI.myRequests()
      .then((res) => { if (live) setMine(Array.isArray(res?.data) ? res.data : []); })
      .catch(() => { if (live) setMine([]); });
    return () => { live = false; };
  }, []);
  const pendingApprovals = Number(me.pendingApprovals) || 0;
  useEffect(() => {
    if (!pendingApprovals || typeof availabilityAPI.approvals !== 'function') { setApprovals(null); return undefined; }
    let live = true;
    Promise.resolve().then(() => availabilityAPI.approvals())
      .then((res) => { if (live) setApprovals((Array.isArray(res?.data) ? res.data : []).filter((r) => r.mine !== false)); })
      .catch(() => { if (live) setApprovals([]); });
    return () => { live = false; };
  }, [pendingApprovals]);

  const holidayNames = useMemo(() => data?.holidayNames || {}, [data]);
  const holidaySet = useMemo(() => new Set(Object.keys(holidayNames)), [holidayNames]);
  // 25 Nov 2026: a visit booked in Vacation Tracker and here counts once.
  const entries = useMemo(() => collapseDuplicateEntries(data?.entries), [data]);
  const teamSize = (data?.people || []).length;
  const typeById = useMemo(() => new Map((me.leaveTypes || []).map((t) => [t.id, t])), [me.leaveTypes]);
  const weekEntries = useMemo(() => entries.filter((e) => e.startDate <= weekTo && e.endDate >= weekFrom), [entries, weekFrom, weekTo]);
  const week = useMemo(() => buildWeek(weekEntries, weekFrom, today, holidaySet), [weekEntries, weekFrom, today, holidaySet]);

  const nextMine = useMemo(() => (mine || [])
    .filter((r) => ['approved', 'pending'].includes(r.status) && r.endDate >= today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))[0] || null, [mine, today]);
  const firstName = String(me.person?.name || '').trim().split(/\s+/)[0] || null;
  const quickTypes = useMemo(() => [...(me.leaveTypes || [])]
    .filter((t) => t.isActive !== false)
    .sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999))
    .slice(0, 4), [me.leaveTypes]);

  // The week's one-line summary: today when today is on screen, and the thinnest day.
  const todayCell = week.perDay.get(today);
  const awayToday = todayCell ? todayCell.out.size : 0;
  const partToday = todayCell ? new Set(todayCell.part.filter((p) => p.entry.status === 'approved').map((p) => p.entry.email)).size : 0;
  const busiest = week.days.filter((d) => d.key >= today).reduce((best, d) => {
    const n = week.perDay.get(d.key).out.size;
    return n > (best?.n || 1) ? { day: d, n } : best;
  }, null);

  // Coming up: all-day absences that start after the week on screen.
  const comingUp = useMemo(() => {
    const seen = new Set();
    return entries
      .filter((e) => e.status === 'approved' && isAway(e) && e.startDate > weekTo && e.startDate > today)
      .sort((a, b) => a.startDate.localeCompare(b.startDate))
      .filter((e) => { const k = `${e.email}|${e.startDate}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 4);
  }, [entries, weekTo, today]);

  const linkClass = 'tp-focus-ring inline-flex items-center gap-1 rounded-md text-xs font-medium text-primary hover:underline';
  const stepBtn = 'tp-focus-ring grid h-7 w-7 place-items-center rounded-md border border-border bg-card text-muted-foreground hover:text-foreground disabled:opacity-40';

  return (
    <div className="space-y-5">
      <ErrorNote>{error}</ErrorNote>

      {/* 1. You and the team pulse */}
      <section className="relative overflow-hidden rounded-xl border border-border bg-card shadow-subtle" aria-label="Your time and the team pulse">
        <img src={`${ART}/hero-light.webp`} alt="" aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover object-right opacity-90 dark:hidden" />
        <img src={`${ART}/hero-dark.webp`} alt="" aria-hidden="true" className="pointer-events-none absolute inset-0 hidden h-full w-full select-none object-cover object-right opacity-80 dark:block" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-card via-card/90 to-card/10" aria-hidden="true" />
        <div className="relative grid lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
          <div className="p-4 sm:p-5">
            <p className="flex items-center gap-2.5">
              <img src={`${ART}/emblem.webp`} alt="" aria-hidden="true" className="h-8 w-8 select-none" draggable="false" />
              <span className="text-sm font-semibold tracking-tight text-foreground">Vacation Pulse</span>
              <span className="text-xs text-muted-foreground">{fmtDay(today, { weekday: 'long', month: 'long', day: 'numeric' })}</span>
            </p>
            <h2 className="mt-3 text-lg font-semibold leading-snug tracking-tight text-foreground" data-testid="my-next">
              {mine === null ? <span className="invisible">Loading</span> : nextMine ? (
                <>
                  Your next time away: {leaveLabel(typeById.get(nextMine.leaveTypeId)?.name || 'time away', sitePlace(nextMine, me.offices))}, {fmtRange(nextMine)}
                  {nextMine.status === 'pending' && <span className="text-sm font-normal text-muted-foreground"> · {REQUEST_STATUS.pending.label.toLowerCase()}</span>}
                </>
              ) : `Nothing booked for you${firstName ? `, ${firstName}` : ''}.`}
            </h2>
            <div className="mt-4"><MyBalances me={me} /></div>
            {quickTypes.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2" aria-label="Book time away">
                {quickTypes.map((t) => {
                  const cls = 'tp-focus-ring inline-flex items-center gap-2 rounded-lg border border-border bg-card py-1.5 pl-2 pr-3 text-xs font-medium text-foreground/85 hover:border-blue-300 hover:text-blue-700 dark:hover:border-blue-500/40 dark:hover:text-blue-200';
                  const inner = <><Pictogram name={pictogramFor(t)} />{t.name}</>;
                  return onBook
                    ? <button key={t.id} type="button" className={cls} onClick={() => onBook(t.id)} title={`Book ${t.name}`}>{inner}</button>
                    : <Link key={t.id} to={`${base}/my-time`} state={{ bookType: t.id }} className={cls} title={`Book ${t.name}`}>{inner}</Link>;
                })}
              </div>
            )}
          </div>
          <div className="border-t border-border bg-card/45 p-4 backdrop-blur-[2px] sm:p-5 lg:border-l lg:border-t-0" aria-labelledby="ov-pulse">
            <TeamPulse entries={entries} today={today} holidaySet={holidaySet} teamSize={teamSize} byEmail={byEmail} />
          </div>
        </div>
      </section>

      {/* 2. The week */}
      <section className="overflow-hidden rounded-xl border border-border bg-card shadow-subtle" aria-labelledby="ov-week">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border/70 px-4 py-3">
          <h2 id="ov-week" className="text-sm font-semibold text-foreground">{weekOffset === 0 ? 'This week' : weekOffset === 1 ? 'Next week' : weekOffset === -1 ? 'Last week' : 'Week'}</h2>
          <span className="inline-flex items-center gap-1.5">
            <button type="button" className={stepBtn} onClick={() => setWeekOffset((n) => n - 1)} disabled={weekOffset <= -4} aria-label="Week before"><ChevronLeft className="h-4 w-4" aria-hidden="true" /></button>
            <span className="min-w-[7.5rem] text-center text-xs font-medium tabular-nums text-foreground/85">{fmtDay(weekFrom, { month: 'short', day: 'numeric' })} – {fmtDay(addDaysKey(weekFrom, 4), { month: 'short', day: 'numeric' })}</span>
            <button type="button" className={stepBtn} onClick={() => setWeekOffset((n) => n + 1)} disabled={weekOffset >= 12} aria-label="Week after"><ChevronRight className="h-4 w-4" aria-hidden="true" /></button>
            {weekOffset !== 0 && <button type="button" className="tp-focus-ring ml-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-primary hover:underline" onClick={() => setWeekOffset(0)}>This week</button>}
          </span>
          <p className="text-xs text-muted-foreground" data-testid="week-summary">
            {!data && !error ? 'Loading…' : todayCell ? (
              awayToday || partToday ? (
                <>
                  {awayToday > 0 && <span className={`font-semibold ${AWAY_TEXT}`}>{awayToday} away</span>}
                  {awayToday > 0 && partToday > 0 && ' and '}
                  {partToday > 0 && <span className={`font-semibold ${PART_TEXT}`}>{partToday} out for part of the day</span>}
                  {' '}today
                </>
              ) : 'Everyone is in today'
            ) : null}
            {busiest && <>{todayCell ? ' · ' : ''}most away on <span className="font-semibold text-foreground">{fmtDay(busiest.day.key, { weekday: 'long' })}</span> ({busiest.n})</>}
          </p>
          <Link to={`${base}/calendar`} className={`${linkClass} ml-auto`}>Wallchart <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></Link>
        </div>
        <WeekBoard week={week} today={today} byEmail={byEmail} holidays={holidaySet} holidayNames={holidayNames} teamSize={teamSize} />
      </section>

      {/* 3. Waiting for you, and what is coming up */}
      <div className={`grid gap-5 ${approvals?.length ? 'lg:grid-cols-3' : 'lg:grid-cols-2'} lg:items-start`}>
        {approvals?.length > 0 && (
          <section className={CARD} aria-labelledby="ov-wait">
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <h2 id="ov-wait" className="text-sm font-semibold text-foreground">Waiting for you</h2>
              <span className="text-xs text-muted-foreground">{plural(approvals.length, 'request', 'requests')}</span>
            </div>
            <ul className="divide-y divide-border/70" data-testid="overview-approvals">
              {approvals.slice(0, 3).map((r) => {
                const name = r.name || personName(r.email, byEmail);
                const why = (r.decision?.fired || []).find((f) => f.message)?.message || null;
                return (
                  <li key={r.id} className="flex items-center gap-2.5 py-2.5">
                    <TeamAvatar email={r.email} name={name} byEmail={byEmail} size="h-7 w-7" textSize="text-[10px]" />
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block truncate text-sm font-medium text-foreground">{name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{leaveLabel(typeById.get(r.leaveTypeId)?.name, sitePlace(r, me.offices))} · {fmtRange(r)}</span>
                      {why && <span className={`block truncate text-xs ${PART_TEXT}`}>{why}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
            <Link to={`${base}/approvals`} className={`${linkClass} mt-1`}>Review{approvals.length > 3 ? ` all ${approvals.length}` : ''} <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></Link>
          </section>
        )}

        <section className={CARD} aria-labelledby="ov-next">
          <h2 id="ov-next" className="mb-1 text-sm font-semibold text-foreground">Away after this week</h2>
          {!comingUp.length ? (
            <p className="py-2 text-sm text-muted-foreground">{data ? 'Nobody is booked away in the next six weeks.' : 'Loading…'}</p>
          ) : (
            <ul className="divide-y divide-border/70" data-testid="coming-up">
              {comingUp.map((e) => {
                const name = personName(e.email, byEmail);
                const n = daysUntil(today, e.startDate);
                return (
                  <li key={`${e.email}-${e.startDate}`} className="flex items-center gap-2.5 py-2.5">
                    <TeamAvatar email={e.email} name={name} byEmail={byEmail} size="h-7 w-7" textSize="text-[10px]" />
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block truncate text-sm font-medium text-foreground">{name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        <span className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle ${COLOR_DOT[e.color] || COLOR_DOT.slate}`} aria-hidden="true" />
                        {entryLabel(e)} · {fmtRange(e)}
                      </span>
                    </span>
                    <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{n === 1 ? 'tomorrow' : `in ${n} days`}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className={CARD} aria-labelledby="ov-hol">
          <h2 id="ov-hol" className="mb-1 text-sm font-semibold text-foreground">Holidays coming up</h2>
          {holidays === null ? (
            <p className="py-2 text-sm text-muted-foreground">Loading…</p>
          ) : !holidays.length ? (
            <p className="py-2 text-sm text-muted-foreground">No holidays in the next year.</p>
          ) : (
            <ul className="divide-y divide-border/70" data-testid="upcoming-holidays">
              {holidays.map((h) => {
                const n = daysUntil(today, h.date);
                return (
                  <li key={h.date} className="flex items-center gap-2.5 py-2.5 text-sm">
                    <Pictogram name="holiday" className="h-6 w-6" />
                    <span className="min-w-0 flex-1 text-foreground">{h.name} <span className="text-muted-foreground">· {fmtDay(h.date)}</span></span>
                    <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
