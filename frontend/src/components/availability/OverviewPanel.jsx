import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { availabilityAPI } from '../../services/api';
import {
  CARD, COLOR_DOT, COVERAGE_BG, ColorSwatch, ErrorNote, HATCH, REQUEST_STATUS, StatusDot,
  addDaysKey, fmtDay, fmtRange, parseDay, todayKey, trimNum,
} from './availabilityUi';
import {
  WEEKDAY_SHORT, coverageByDay, coverageTone, daysUntil, isWeekend, nextWorkingDayKey, rangeDays, weekStartKey,
} from './calendarModel';
import { TeamAvatar, personName, useRoster } from './teamViews';

/**
 * Overview (5 Oct 2026 — the default tab): who is out this week and when
 * they are back, my balance and my next time away, the holidays coming up,
 * and how many of the team are away on each of the next ten working days.
 */

const COVERAGE_DAYS = 10;

function OutThisWeek({ entries, byEmail, today, holidays, loading }) {
  const rows = useMemo(() => {
    const seen = new Set();
    return [...entries]
      .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.email.localeCompare(b.email))
      .filter((e) => {
        const key = `${e.email}|${e.startDate}|${e.label}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [entries]);
  if (loading && !rows.length) return <p className="py-4 text-sm text-muted-foreground">Loading…</p>;
  if (!rows.length) return <p className="py-4 text-sm text-foreground/85">Everyone is in this week.</p>;
  return (
    <ul className="divide-y divide-border/70" data-testid="out-this-week">
      {rows.map((e, i) => {
        const name = personName(e.email, byEmail);
        const away = !e.availability || e.availability === 'OFF';
        let when = null;
        if (e.startDate > today) when = `from ${WEEKDAY_SHORT[parseDay(e.startDate).getDay()]}`;
        else if (e.endDate < today) when = 'earlier this week';
        else if (away) when = `back ${WEEKDAY_SHORT[parseDay(nextWorkingDayKey(e.endDate, holidays)).getDay()]}`;
        else when = e.startDate === e.endDate ? 'today' : `until ${WEEKDAY_SHORT[parseDay(e.endDate).getDay()]}`;
        return (
          <li key={`${e.email}-${e.id ?? i}`} className="flex items-center gap-3 py-2.5">
            <TeamAvatar email={e.email} name={name} byEmail={byEmail} size="h-9 w-9" textSize="text-xs" />
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-medium text-foreground">{name}</p>
              <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                <span className={`h-1.5 w-1.5 rounded-full ${COLOR_DOT[e.color] || COLOR_DOT.slate}`} aria-hidden="true" />
                <span>{e.label || 'Away'}{e.status === 'pending' ? ' · waiting for approval' : ''}</span>
                <span aria-hidden="true">·</span>
                <span>{fmtRange(e)}</span>
              </p>
            </div>
            <span className={`ml-auto whitespace-nowrap text-xs ${e.endDate < today ? 'text-muted-foreground/70' : 'text-muted-foreground'}`}>{when}</span>
          </li>
        );
      })}
    </ul>
  );
}

function MyBalance({ me }) {
  const typeById = new Map((me.leaveTypes || []).map((t) => [t.id, t]));
  const balances = me.balances || [];
  if (!balances.length) return <p className="text-sm text-muted-foreground">No leave type tracks a balance for you.</p>;
  return (
    <div className="space-y-4">
      {balances.map((b) => {
        const type = typeById.get(b.leaveTypeId);
        const entitled = Number(b.entitled || 0) + Number(b.adjustments || 0);
        const pct = (v) => `${entitled > 0 ? Math.max(0, Math.min(100, (Number(v || 0) / entitled) * 100)) : 0}%`;
        return (
          <div key={`${b.leaveTypeId}-${b.year}`} className="space-y-2">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><ColorSwatch color={type?.color} />{b.name || type?.name} · {b.year}</p>
            <dl className="grid grid-cols-4 gap-2">
              <div><dd className="text-2xl font-semibold tabular-nums text-foreground">{trimNum(b.remaining)}</dd><dt className="text-[11px] text-muted-foreground">Left of {trimNum(entitled)}</dt></div>
              <div><dd className="text-2xl font-semibold tabular-nums text-foreground/85">{trimNum(b.taken)}</dd><dt className="text-[11px] text-muted-foreground">Taken</dt></div>
              <div><dd className="text-2xl font-semibold tabular-nums text-foreground/85">{trimNum(b.scheduled)}</dd><dt className="text-[11px] text-muted-foreground">Booked</dt></div>
              <div><dd className="text-2xl font-semibold tabular-nums text-foreground/85">{trimNum(b.pending)}</dd><dt className="text-[11px] text-muted-foreground">Waiting</dt></div>
            </dl>
            <div className="flex h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <span className={COLOR_DOT[type?.color] || COLOR_DOT.slate} style={{ width: pct(b.taken) }} />
              <span className={`${COLOR_DOT[type?.color] || COLOR_DOT.slate} opacity-50`} style={{ width: pct(b.scheduled) }} />
              <span className={`${COLOR_DOT[type?.color] || COLOR_DOT.slate} opacity-60`} style={{ ...HATCH, width: pct(b.pending) }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function OverviewPanel({ me }) {
  const today = todayKey();
  const weekFrom = weekStartKey(today);
  const weekTo = addDaysKey(weekFrom, 6);
  const to = addDaysKey(today, 21);
  const [data, setData] = useState(null);
  const [holidays, setHolidays] = useState(null);
  const [mine, setMine] = useState(null);
  const [error, setError] = useState(null);
  const { byEmail } = useRoster();

  useEffect(() => {
    let live = true;
    availabilityAPI.calendar({ from: weekFrom, to: to > weekTo ? to : weekTo })
      .then((res) => { if (live) { setData(res?.data || null); setError(null); } })
      .catch((err) => { if (live) setError(err?.message || 'Could not load who is out'); });
    availabilityAPI.upcomingHolidays(3)
      .then((res) => { if (live) setHolidays(Array.isArray(res?.data) ? res.data : []); })
      .catch(() => { if (live) setHolidays([]); });
    availabilityAPI.myRequests()
      .then((res) => { if (live) setMine(Array.isArray(res?.data) ? res.data : []); })
      .catch(() => { if (live) setMine([]); });
    return () => { live = false; };
  }, [weekFrom, weekTo, to]);

  const holidayNames = data?.holidayNames || {};
  const holidaySet = useMemo(() => new Set(Object.keys(data?.holidayNames || {})), [data]);
  const thisWeek = useMemo(() => (data?.entries || []).filter((e) => e.startDate <= weekTo && e.endDate >= weekFrom), [data, weekFrom, weekTo]);
  const workDays = useMemo(() => rangeDays(today, to).filter((d) => !isWeekend(d.dow) && !holidaySet.has(d.key)).slice(0, COVERAGE_DAYS), [today, to, holidaySet]);
  const coverage = useMemo(() => coverageByDay(data?.entries || [], workDays), [data, workDays]);
  const teamSize = (data?.people || []).length;
  const typeById = useMemo(() => new Map((me.leaveTypes || []).map((t) => [t.id, t])), [me.leaveTypes]);
  const nextMine = useMemo(() => (mine || [])
    .filter((r) => ['approved', 'pending'].includes(r.status) && r.endDate >= today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
    .slice(0, 2), [mine, today]);

  return (
    <div className="space-y-5">
      <ErrorNote>{error}</ErrorNote>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:items-start">
        <section className={CARD} aria-labelledby="ov-out">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <h2 id="ov-out" className="text-sm font-semibold text-foreground">Out this week</h2>
            <span className="text-xs text-muted-foreground">{fmtDay(weekFrom, { month: 'short', day: 'numeric' })} – {fmtDay(weekTo, { month: 'short', day: 'numeric' })}</span>
          </div>
          <OutThisWeek entries={thisWeek} byEmail={byEmail} today={today} holidays={holidaySet} loading={!data && !error} />
          <Link to="/availability/calendar" className="tp-focus-ring mt-2 inline-flex items-center gap-1 rounded-md text-xs font-medium text-primary hover:underline">
            Open the wallchart <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </section>

        <div className="space-y-5">
          <section className={CARD} aria-labelledby="ov-mine">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 id="ov-mine" className="text-sm font-semibold text-foreground">My time</h2>
              <Link to="/availability/my-time" className="tp-focus-ring inline-flex items-center gap-1 rounded-md text-xs font-medium text-primary hover:underline">
                Book time away <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </div>
            <MyBalance me={me} />
            {nextMine.length > 0 && (
              <div className="mt-4 border-t border-border/70 pt-3">
                <p className="mb-1 text-xs font-medium text-muted-foreground">Coming up for you</p>
                <ul className="space-y-1.5">
                  {nextMine.map((r) => {
                    const st = REQUEST_STATUS[r.status] || REQUEST_STATUS.approved;
                    return (
                      <li key={r.id} className="flex flex-wrap items-center gap-x-2 text-sm">
                        <ColorSwatch color={typeById.get(r.leaveTypeId)?.color} />
                        <span className="text-foreground">{typeById.get(r.leaveTypeId)?.name || 'Time away'}</span>
                        <span className="text-muted-foreground">{fmtRange(r)}</span>
                        <StatusDot tone={st.tone} label={st.label} className="ml-auto" />
                      </li>
                    );
                  })}
                </ul>
              </div>
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
                    <li key={h.date} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                      <span className="text-foreground">{h.name} <span className="text-muted-foreground">· {fmtDay(h.date)}</span></span>
                      <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>

      <section className={CARD} aria-labelledby="ov-cov">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-3">
          <h2 id="ov-cov" className="text-sm font-semibold text-foreground">Who is away, next {COVERAGE_DAYS} working days</h2>
          <span className="text-xs text-muted-foreground">of {teamSize} {teamSize === 1 ? 'person' : 'people'}; working from home or on site counts as working</span>
        </div>
        <ol className="grid grid-cols-5 gap-2 sm:grid-cols-10" data-testid="coverage-strip">
          {workDays.map((d) => {
            const out = coverage.get(d.key) || [];
            const tone = coverageTone(out.length, teamSize);
            const names = out.map((e) => personName(e, byEmail)).join(', ');
            return (
              <li key={d.key} className="flex flex-col items-center gap-1" title={out.length ? `${out.length} away: ${names}` : 'Nobody away'}>
                <span className={`grid h-8 w-full place-items-center rounded-md text-sm font-semibold tabular-nums ${COVERAGE_BG[tone]} ${tone === 'none' ? 'text-muted-foreground' : 'text-white'}`}>
                  {out.length}
                  <span className="sr-only"> away{names ? `: ${names}` : ''}</span>
                </span>
                <span className={`text-[11px] ${d.key === today ? 'font-semibold text-primary' : 'text-muted-foreground'}`}>{WEEKDAY_SHORT[d.dow]} {d.n}</span>
              </li>
            );
          })}
        </ol>
        {Object.keys(holidayNames).some((k) => k >= today && k <= to) && (
          <p className="mt-2 text-xs text-muted-foreground">
            Skipped: {Object.entries(holidayNames).filter(([k]) => k >= today && k <= to).map(([k, nm]) => `${nm} (${fmtDay(k)})`).join(', ')}
          </p>
        )}
      </section>
    </div>
  );
}
