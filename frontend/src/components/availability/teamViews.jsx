import { useEffect, useMemo, useState } from 'react';
import { PersonAvatar } from '../tickets/ticketUi';
import { availabilityAPI, getWorkspaceId } from '../../services/api';
import {
  COLOR_BAR, COLOR_BAR_PENDING, COLOR_DOT, ColorSwatch, HATCH, HOLIDAY_BG, WEEKEND_BG,
  fmtDay, fmtRange, nameFromEmail, parseDay, todayKey,
} from './availabilityUi';
import { WEEKDAY_SHORT } from './calendarModel';

/**
 * Shared pieces of the team views (Overview, Wallchart, Calendar — 5 Oct 2026):
 * the workspace roster (names, offices, approval groups, photos — fetched once
 * and kept for a few minutes), the person chip, a leave bar, the legend and
 * the by-day list used on narrow screens.
 */

const ROSTER_TTL_MS = 5 * 60 * 1000;
let rosterCache = { ws: null, at: 0, data: null, inflight: null };

/** Test hook: forget the cached roster. */
export function resetRosterCache() { rosterCache = { ws: null, at: 0, data: null, inflight: null }; }

function loadRoster(ws) {
  if (rosterCache.inflight && rosterCache.ws === ws) return rosterCache.inflight;
  const p = availabilityAPI.roster()
    .then((res) => {
      const d = res?.data || { people: [], groups: [], offices: [] };
      if (rosterCache.inflight === p) rosterCache = { ws, at: Date.now(), data: d, inflight: null };
      return d;
    })
    .catch(() => {
      if (rosterCache.inflight === p) rosterCache = { ...rosterCache, inflight: null };
      return null;
    });
  rosterCache = { ...rosterCache, ws, inflight: p };
  return p;
}

/**
 * The workspace roster, shared by every team view. Each render reads the
 * module cache directly, so a roster that lands while the page is busy
 * re-rendering for other data is never lost; the effect only asks for a
 * refresh when the cache is empty, stale or for another workspace.
 */
export function useRoster() {
  const ws = String(getWorkspaceId?.() ?? '');
  const [, setTick] = useState(0);
  const cached = rosterCache.data && rosterCache.ws === ws ? rosterCache.data : null;
  const stale = !cached || Date.now() - rosterCache.at > ROSTER_TTL_MS;
  useEffect(() => {
    if (!stale) return undefined;
    let live = true;
    loadRoster(ws).then(() => { if (live) setTick((n) => n + 1); });
    return () => { live = false; };
  }, [ws, stale]);
  const byEmail = useMemo(() => new Map((cached?.people || []).map((p) => [p.email, p])), [cached]);
  return { roster: cached, byEmail };
}

export function personName(email, byEmail, fallback = null) {
  return byEmail?.get(email)?.name || fallback || nameFromEmail(email);
}

export function TeamAvatar({ email, name, byEmail, size = 'h-6 w-6', textSize = 'text-[10px]' }) {
  return <PersonAvatar name={name || personName(email, byEmail)} photoUrl={byEmail?.get(email)?.photoUrl || null} size={size} textSize={textSize} />;
}

/** A leave's words for tooltips and screen readers. */
export function entryWords(entry, name) {
  const parts = [name, entry.label || 'Away', fmtRange(entry)];
  if (entry.status === 'pending') parts.push('waiting for approval');
  return parts.filter(Boolean).join(', ');
}

/** Class + style for a bar: solid when approved, dashed when waiting, hatched for part of a day. */
export function barLook(entry) {
  const color = entry.color || 'slate';
  const pending = entry.status === 'pending';
  const partial = entry.dayPart === 'am' || entry.dayPart === 'pm' || entry.dayPart === 'hours';
  const className = pending
    ? `border border-dashed bg-transparent ${COLOR_BAR_PENDING[color] || COLOR_BAR_PENDING.slate}`
    : COLOR_BAR[color] || COLOR_BAR.slate;
  return { className, style: partial && !pending ? HATCH : undefined };
}

export function DayTypeLegend({ entries = [], showPending = false, className = '' }) {
  const types = useMemo(() => {
    const seen = new Map();
    for (const e of entries) if (e.label && !seen.has(e.label)) seen.set(e.label, e.color);
    return [...seen.entries()];
  }, [entries]);
  return (
    <ul className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground ${className}`} aria-label="Legend">
      {types.map(([label, color]) => <li key={label} className="inline-flex items-center gap-1.5"><ColorSwatch color={color} />{label}</li>)}
      {showPending && (
        <li className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-3.5 rounded-sm border border-dashed border-muted-foreground/70" aria-hidden="true" />Waiting for approval
        </li>
      )}
      <li className="inline-flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-3.5 rounded-sm bg-muted-foreground/40" style={HATCH} aria-hidden="true" />Part of a day
      </li>
      <li className="inline-flex items-center gap-1.5"><span className={`inline-block h-2.5 w-3.5 rounded-sm border border-border ${WEEKEND_BG}`} aria-hidden="true" />Weekend</li>
      <li className="inline-flex items-center gap-1.5"><span className={`inline-block h-2.5 w-3.5 rounded-sm border border-rose-200 dark:border-rose-500/30 ${HOLIDAY_BG}`} aria-hidden="true" />Holiday</li>
    </ul>
  );
}

/**
 * Narrow screens: the same entries as a list by day (from today when the
 * range includes today). Weekends without anyone away are skipped.
 */
export function AgendaList({ days, entries, byEmail, holidayNames = {}, emptyText = 'Nobody is away in this period.' }) {
  const today = todayKey();
  const start = days.some((d) => d.key === today) ? today : days[0]?.key;
  const list = days
    .filter((d) => d.key >= start)
    .map((d) => ({
      day: d,
      items: (entries || []).filter((e) => d.key >= e.startDate && d.key <= e.endDate
        && (e.startDate === e.endDate || !(d.dow === 0 || d.dow === 6 || holidayNames[d.key]))),
    }))
    .filter((x) => x.items.length || holidayNames[x.day.key]);
  if (!list.length) return <p className="py-6 text-center text-sm text-muted-foreground">{emptyText}</p>;
  return (
    <div className="space-y-4" data-testid="availability-agenda">
      {list.map(({ day, items }) => (
        <section key={day.key} aria-label={fmtDay(day.key, { weekday: 'long', month: 'long', day: 'numeric' })}>
          <h3 className="mb-1 text-xs font-semibold text-muted-foreground">
            {day.key === today ? 'Today · ' : ''}{WEEKDAY_SHORT[day.dow]} {parseDay(day.key).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}
            {holidayNames[day.key] && <span className="ml-2 font-medium text-rose-600 dark:text-rose-300">{holidayNames[day.key]}</span>}
          </h3>
          <ul className="divide-y divide-border/70">
            {items.map((e, i) => {
              const name = personName(e.email, byEmail);
              return (
                <li key={`${e.email}-${e.id ?? i}`} className="flex items-center gap-3 py-2">
                  <TeamAvatar email={e.email} name={name} byEmail={byEmail} size="h-8 w-8" textSize="text-[11px]" />
                  <div className="min-w-0 leading-tight">
                    <p className="truncate text-sm text-foreground">{name}</p>
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className={`h-1.5 w-1.5 rounded-full ${COLOR_DOT[e.color] || COLOR_DOT.slate}`} aria-hidden="true" />
                      {e.label || 'Away'}{e.status === 'pending' ? ' · waiting' : ''}
                      {e.dayPart === 'am' ? ' · morning' : e.dayPart === 'pm' ? ' · afternoon' : ''}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** A quiet segmented control (text only, the pressed option tinted). */
export function Segmented({ value, onChange, options, label }) {
  return (
    <div role="group" aria-label={label} className="inline-flex overflow-hidden rounded-md border border-border text-xs">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`tp-focus-ring px-2.5 py-1.5 ${value === o.value ? 'bg-primary/10 font-semibold text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
