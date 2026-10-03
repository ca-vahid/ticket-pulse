import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import FancySelect from '../common/FancySelect';
import { PersonAvatar } from '../tickets/ticketUi';
import { availabilityAPI } from '../../services/api';
import {
  BTN_QUIET, CARD, COLOR_DOT, COLOR_FILL, COLOR_STRIPE, ColorSwatch, ErrorNote, MONTHS, STRIPES, Toggle,
  dayKey, fmtRange, nameFromEmail, parseDay, todayKey,
} from './availabilityUi';

/**
 * Team calendar: one row per person, one column per day of the month.
 * Weekends and holidays are tinted columns; an entry fills its cell in the
 * leave type's colour (a half day fills half the cell, an hours entry a low
 * bar), pending entries are striped and outlined. The grid scrolls sideways
 * inside its card only — never the page.
 */

const WEEKDAY_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function monthDays(year, month) {
  const out = [];
  const d = new Date(year, month, 1);
  while (d.getMonth() === month) {
    out.push({ key: dayKey(d), n: d.getDate(), dow: d.getDay() });
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function Cell({ entry }) {
  const color = entry.color || 'slate';
  const pending = entry.status === 'pending';
  const shape = entry.dayPart === 'am' ? 'inset-y-0.5 left-0.5 right-1/2'
    : entry.dayPart === 'pm' ? 'inset-y-0.5 left-1/2 right-0.5'
      : entry.dayPart === 'hours' ? 'bottom-0.5 left-0.5 right-0.5 h-1.5'
        : 'inset-0.5';
  const look = pending
    ? `border border-dashed ${COLOR_STRIPE[color] || COLOR_STRIPE.slate}`
    : COLOR_FILL[color] || COLOR_FILL.slate;
  return <span aria-hidden="true" className={`absolute rounded-[3px] ${shape} ${look}`} style={pending ? STRIPES : undefined} />;
}

export default function TeamCalendarPanel({ me, groups = null }) {
  const now = new Date();
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() });
  const [officeId, setOfficeId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [onlyAway, setOnlyAway] = useState(false);
  const [data, setData] = useState(null);
  const [outToday, setOutToday] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const days = useMemo(() => monthDays(cursor.year, cursor.month), [cursor]);
  const from = days[0].key;
  const to = days[days.length - 1].key;
  const today = todayKey();

  useEffect(() => {
    let live = true;
    setLoading(true);
    availabilityAPI.calendar({ from, to, ...(officeId ? { officeId } : {}), ...(groupId ? { groupId } : {}) })
      .then((res) => { if (live) { setData(res?.data || null); setError(null); } })
      .catch((err) => { if (live) setError(err?.message || 'Could not load the team calendar'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [from, to, officeId, groupId]);

  useEffect(() => {
    availabilityAPI.outToday()
      .then((res) => setOutToday(Array.isArray(res?.data) ? res.data : []))
      .catch(() => setOutToday([]));
  }, []);

  const holidays = useMemo(() => new Set(data?.holidays || []), [data]);
  const offDay = useCallback((d) => d.dow === 0 || d.dow === 6 || holidays.has(d.key), [holidays]);

  // email -> dayKey -> entries
  const grid = useMemo(() => {
    const map = new Map();
    for (const e of data?.entries || []) {
      if (!map.has(e.email)) map.set(e.email, new Map());
      const row = map.get(e.email);
      const single = e.startDate === e.endDate;
      for (const d of days) {
        if (d.key < e.startDate || d.key > e.endDate) continue;
        if (!single && offDay(d)) continue;
        if (!row.has(d.key)) row.set(d.key, []);
        row.get(d.key).push(e);
      }
    }
    return map;
  }, [data, days, offDay]);

  const nameByEmail = useMemo(() => new Map((data?.people || []).map((p) => [p.email, p.name || nameFromEmail(p.email)])), [data]);
  const people = useMemo(() => {
    const all = data?.people || [];
    return onlyAway ? all.filter((p) => grid.get(p.email)?.size) : all;
  }, [data, onlyAway, grid]);

  const legend = useMemo(() => {
    const seen = new Map();
    for (const e of data?.entries || []) if (e.label && !seen.has(e.label)) seen.set(e.label, e.color);
    return [...seen.entries()];
  }, [data]);

  const step = (n) => setCursor((c) => {
    const d = new Date(c.year, c.month + n, 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const officeOptions = [{ value: '', label: 'All offices' }, ...(me.offices || []).map((o) => ({ value: String(o.id), label: o.name }))];
  const groupOptions = groups ? [{ value: '', label: 'All approval groups' }, ...groups.filter((g) => g.isActive !== false).map((g) => ({ value: String(g.id), label: g.name }))] : null;

  return (
    <div className="space-y-4">
      <section aria-label="Who's out today" className="text-sm" data-testid="out-today">
        <h2 className="mb-1.5 text-xs font-medium text-muted-foreground">Out today · {parseDay(today).toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' })}</h2>
        {outToday === null ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : !outToday.length ? (
          <p className="text-foreground/85">Everyone is in today.</p>
        ) : (
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            {outToday.map((e, i) => {
              const name = nameByEmail.get(e.email) || nameFromEmail(e.email);
              return (
                <li key={`${e.email}-${e.id ?? i}`} className="inline-flex items-center gap-2" title={fmtRange(e)}>
                  <PersonAvatar name={name} size="h-6 w-6" />
                  <span className="text-foreground">{name}</span>
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <span className={`h-1.5 w-1.5 rounded-full ${COLOR_DOT[e.color] || COLOR_DOT.slate}`} aria-hidden="true" />
                    {e.label || 'Away'}{e.status === 'pending' ? ' (pending)' : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <button type="button" className={BTN_QUIET} onClick={() => step(-1)} aria-label="Previous month"><ChevronLeft className="h-4 w-4" aria-hidden="true" /></button>
          <h2 className="min-w-[9.5rem] text-center text-sm font-semibold text-foreground" aria-live="polite">{MONTHS[cursor.month]} {cursor.year}</h2>
          <button type="button" className={BTN_QUIET} onClick={() => step(1)} aria-label="Next month"><ChevronRight className="h-4 w-4" aria-hidden="true" /></button>
          <button type="button" className={BTN_QUIET} onClick={() => setCursor({ year: now.getFullYear(), month: now.getMonth() })}>Today</button>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading" />}
          <div className="w-44"><FancySelect value={officeId} onChange={setOfficeId} options={officeOptions} aria-label="Office" /></div>
          {groupOptions && <div className="w-48"><FancySelect value={groupId} onChange={setGroupId} options={groupOptions} aria-label="Approval group" /></div>}
          <Toggle checked={onlyAway} onChange={setOnlyAway} label="Only people who are away" />
        </div>
      </div>

      <ErrorNote>{error}</ErrorNote>

      <div className={`${CARD} p-0`}>
        <div className="settings-scrollbar overflow-x-auto" data-testid="team-calendar-scroll">
          <table className="w-max min-w-full border-separate border-spacing-0 text-xs" aria-label={`Team calendar, ${MONTHS[cursor.month]} ${cursor.year}`}>
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 z-10 min-w-[11rem] border-b border-border bg-card px-3 py-2 text-left font-medium text-muted-foreground">Person</th>
                {days.map((d) => (
                  <th
                    key={d.key}
                    scope="col"
                    title={holidays.has(d.key) ? 'Holiday' : undefined}
                    className={`w-7 min-w-[1.75rem] border-b border-border px-0 py-1 text-center font-normal ${offDay(d) ? 'bg-muted/70' : ''} ${d.key === today ? 'text-primary' : 'text-muted-foreground'}`}
                  >
                    <span className="block text-[10px] leading-none">{WEEKDAY_LETTER[d.dow]}</span>
                    <span className={`block pt-0.5 tabular-nums ${d.key === today ? 'font-semibold' : ''}`}>{d.n}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {people.map((p) => {
                const row = grid.get(p.email);
                const name = p.name || nameFromEmail(p.email);
                return (
                  <tr key={p.email} data-testid={`cal-row-${p.email}`}>
                    <th scope="row" className="sticky left-0 z-10 border-b border-border bg-card px-3 py-1 text-left font-normal">
                      <span className="flex items-center gap-2">
                        <PersonAvatar name={name} size="h-5 w-5" textSize="text-[9px]" />
                        <span className="max-w-[9rem] truncate text-sm text-foreground">{name}</span>
                      </span>
                    </th>
                    {days.map((d) => {
                      const entries = row?.get(d.key) || [];
                      const title = entries.map((e) => `${e.label || 'Away'}${e.status === 'pending' ? ' (pending)' : ''} · ${fmtRange(e)}`).join('\n');
                      return (
                        <td
                          key={d.key}
                          title={title || undefined}
                          data-testid={`cal-cell-${p.email}-${d.key}`}
                          data-entry={entries.length ? entries.map((e) => e.label || 'Away').join(', ') : undefined}
                          className={`relative h-8 border-b border-border p-0 ${offDay(d) ? 'bg-muted/70' : ''} ${d.key === today ? 'bg-primary/[0.06]' : ''}`}
                        >
                          {entries.slice(0, 2).map((e, i) => <Cell key={`${e.id ?? 'x'}-${i}`} entry={e} />)}
                          {entries.length > 0 && <span className="sr-only">{title}</span>}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {!people.length && !loading && (
                <tr>
                  <td colSpan={days.length + 1} className="px-3 py-8 text-center text-sm text-muted-foreground">
                    {onlyAway ? 'Nobody is away this month.' : 'No people to show.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {legend.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
          {legend.map(([label, color]) => <li key={label} className="inline-flex items-center gap-1.5"><ColorSwatch color={color} />{label}</li>)}
          <li className="inline-flex items-center gap-1.5">
            <span className={`inline-block h-2.5 w-2.5 rounded-sm border border-dashed ${COLOR_STRIPE.slate}`} style={STRIPES} aria-hidden="true" />Pending
          </li>
          <li className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-muted" aria-hidden="true" />Weekend or holiday</li>
        </ul>
      )}
    </div>
  );
}
