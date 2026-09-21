import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react';

/**
 * One "When" control for list filters (Approvals, 20 Sep 2026): the usual
 * presets (today, last 7 / 30 / 90 days, this month…) and a range calendar in
 * the same popover, instead of two bare date inputs. The value is a single
 * string that survives a URL round-trip: a preset key ('30d', 'this_month'…)
 * or a custom range 'YYYY-MM-DD..YYYY-MM-DD'. `resolveWhen()` turns either
 * into the from / to the API takes.
 */
const DAY = 24 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, '0');
export const toDateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromDateKey = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null; };
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export const WHEN_PRESETS = [
  { key: 'today', label: 'Today', range: (t) => [t, t] },
  { key: 'yesterday', label: 'Yesterday', range: (t) => { const y = new Date(t.getTime() - DAY); return [y, y]; } },
  { key: '7d', label: 'Last 7 days', range: (t) => [new Date(t.getTime() - 6 * DAY), t] },
  { key: '30d', label: 'Last 30 days', range: (t) => [new Date(t.getTime() - 29 * DAY), t] },
  { key: '90d', label: 'Last 90 days', range: (t) => [new Date(t.getTime() - 89 * DAY), t] },
  { key: 'this_month', label: 'This month', range: (t) => [new Date(t.getFullYear(), t.getMonth(), 1), t], group: 'Calendar' },
  { key: 'last_month', label: 'Last month', range: (t) => [new Date(t.getFullYear(), t.getMonth() - 1, 1), new Date(t.getFullYear(), t.getMonth(), 0)], group: 'Calendar' },
  { key: 'this_quarter', label: 'This quarter', range: (t) => [new Date(t.getFullYear(), Math.floor(t.getMonth() / 3) * 3, 1), t], group: 'Calendar' },
  { key: 'this_year', label: 'This year', range: (t) => [new Date(t.getFullYear(), 0, 1), t], group: 'Calendar' },
];

const shortDay = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const rangeLabel = (a, b) => {
  if (toDateKey(a) === toDateKey(b)) return shortDay(a);
  const sameMonth = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
  return sameMonth ? `${shortDay(a)} – ${b.getDate()}` : `${shortDay(a)} – ${shortDay(b)}`;
};

/** '' → any time; a preset key or 'a..b' → { from, to } as YYYY-MM-DD plus a label for the button. */
export function resolveWhen(value, now = new Date()) {
  const v = String(value || '').trim();
  if (!v) return { from: '', to: '', label: 'Any time', custom: false };
  const today = startOfDay(now);
  const preset = WHEN_PRESETS.find((p) => p.key === v);
  if (preset) { const [a, b] = preset.range(today); return { from: toDateKey(a), to: toDateKey(b), label: preset.label, custom: false }; }
  const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(v);
  if (m) {
    const a = fromDateKey(m[1]); const b = fromDateKey(m[2]);
    if (a && b) { const [lo, hi] = a <= b ? [a, b] : [b, a]; return { from: toDateKey(lo), to: toDateKey(hi), label: rangeLabel(lo, hi), custom: true }; }
  }
  return { from: '', to: '', label: 'Any time', custom: false };
}

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
function monthGrid(year, month) {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7; // Monday first
  const start = new Date(year, month, 1 - lead);
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

export default function WhenFilter({ value, onChange, label = 'When', className = '' }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const resolved = useMemo(() => resolveWhen(value), [value]);
  const today = startOfDay(new Date());
  // Calendar state: month shown, and the range being picked (start, then end).
  const [view, setView] = useState(() => { const d = fromDateKey(resolved.from) || today; return { y: d.getFullYear(), m: d.getMonth() }; });
  const [pick, setPick] = useState({ a: null, b: null });
  const [hover, setHover] = useState(null);

  useEffect(() => {
    if (!open) return undefined;
    const a = fromDateKey(resolved.from); const b = fromDateKey(resolved.to);
    setPick(resolved.custom ? { a, b } : { a: null, b: null });
    const d = b || a || today;
    setView({ y: d.getFullYear(), m: d.getMonth() });
    const onDoc = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const choosePreset = (key) => { onChange(key); setOpen(false); };
  const clickDay = (d) => {
    if (!pick.a || pick.b) setPick({ a: d, b: null });
    else setPick(d < pick.a ? { a: d, b: pick.a } : { a: pick.a, b: d });
  };
  const apply = () => {
    const a = pick.a; const b = pick.b || pick.a;
    if (!a) return;
    onChange(`${toDateKey(a <= b ? a : b)}..${toDateKey(a <= b ? b : a)}`);
    setOpen(false);
  };
  const days = monthGrid(view.y, view.m);
  const lo = pick.a && (pick.b || hover) ? (pick.b ? pick.a : (hover < pick.a ? hover : pick.a)) : pick.a;
  const hi = pick.a && (pick.b || hover) ? (pick.b ? pick.b : (hover < pick.a ? pick.a : hover)) : pick.a;
  const monthName = new Date(view.y, view.m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const active = Boolean(value);
  const listId = 'when-filter-presets';

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${label}: ${resolved.label}`}
        className={`tp-focus-ring inline-flex h-9 w-full items-center gap-1.5 rounded-lg border px-2.5 text-sm ${active ? 'border-blue-300 bg-blue-50 font-semibold text-blue-700 dark:border-blue-500/40 dark:bg-blue-500/15 dark:text-blue-200' : 'border-input bg-card text-foreground'}`}
      >
        <CalendarDays className={`h-3.5 w-3.5 flex-shrink-0 ${active ? '' : 'text-muted-foreground/75'}`} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-left">{resolved.label}</span>
        {active ? (
          <span role="button" tabIndex={0} aria-label={`Clear ${label.toLowerCase()} filter`} onClick={(e) => { e.stopPropagation(); onChange(''); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onChange(''); } }} className="tp-focus-ring rounded p-0.5 hover:bg-blue-100 dark:hover:bg-blue-500/20"><X className="h-3.5 w-3.5" aria-hidden="true" /></span>
        ) : <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/60" aria-hidden="true" />}
      </button>
      {open && (
        <div role="dialog" aria-label={`${label} filter`} className="tp-card absolute right-0 top-full z-30 mt-1 flex max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl shadow-soft animate-popIn sm:flex-row">
          <ul id={listId} className="flex flex-row flex-wrap gap-0.5 border-b border-border/60 p-1.5 sm:w-44 sm:flex-col sm:flex-nowrap sm:border-b-0 sm:border-r" aria-label="Quick ranges">
            <li>
              <button type="button" onClick={() => choosePreset('')} className={`tp-focus-ring flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[13px] ${!value ? 'bg-blue-50 font-semibold text-blue-700 dark:bg-blue-500/15 dark:text-blue-200' : 'text-foreground/85 hover:bg-muted'}`}>Any time</button>
            </li>
            {WHEN_PRESETS.map((p, i) => (
              <li key={p.key} className={p.group && WHEN_PRESETS[i - 1]?.group !== p.group ? 'sm:mt-1.5 sm:border-t sm:border-border/60 sm:pt-1.5' : ''}>
                <button type="button" onClick={() => choosePreset(p.key)} className={`tp-focus-ring flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[13px] ${value === p.key ? 'bg-blue-50 font-semibold text-blue-700 dark:bg-blue-500/15 dark:text-blue-200' : 'text-foreground/85 hover:bg-muted'}`}>
                  {p.label}
                  {value === p.key && <Check className="ml-auto h-3.5 w-3.5" aria-hidden="true" />}
                </button>
              </li>
            ))}
          </ul>
          <div className="w-[268px] p-3" onMouseLeave={() => setHover(null)}>
            <div className="mb-1.5 flex items-center justify-between">
              <button type="button" onClick={() => setView((v) => ({ y: v.m === 0 ? v.y - 1 : v.y, m: (v.m + 11) % 12 }))} aria-label="Previous month" className="tp-focus-ring rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><ChevronLeft className="h-4 w-4" aria-hidden="true" /></button>
              <span className="text-[13px] font-semibold text-foreground">{monthName}</span>
              <button type="button" onClick={() => setView((v) => ({ y: v.m === 11 ? v.y + 1 : v.y, m: (v.m + 1) % 12 }))} aria-label="Next month" className="tp-focus-ring rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><ChevronRight className="h-4 w-4" aria-hidden="true" /></button>
            </div>
            <div className="grid grid-cols-7 gap-y-0.5 text-center text-xs" role="grid" aria-label={monthName}>
              {WEEKDAYS.map((w) => <span key={w} className="py-1 text-[10px] font-semibold text-muted-foreground/75">{w}</span>)}
              {days.map((d) => {
                const k = toDateKey(d);
                const inMonth = d.getMonth() === view.m;
                const isA = lo && toDateKey(lo) === k; const isB = hi && toDateKey(hi) === k;
                const inside = lo && hi && d > lo && d < hi;
                const future = d > today;
                return (
                  <button
                    key={k}
                    type="button"
                    role="gridcell"
                    aria-selected={isA || isB || inside || undefined}
                    disabled={future}
                    onClick={() => clickDay(d)}
                    onMouseEnter={() => { if (pick.a && !pick.b) setHover(d); }}
                    className={`tp-focus-ring h-8 tabular-nums disabled:opacity-30 ${isA || isB ? 'bg-blue-600 font-semibold text-white' : inside ? 'bg-blue-50 text-blue-900 dark:bg-blue-500/20 dark:text-blue-100' : 'hover:bg-muted'} ${isA && !(isB && !inside) ? 'rounded-l-md' : ''} ${isB ? 'rounded-r-md' : ''} ${isA && isB ? 'rounded-md' : ''} ${!isA && !isB && !inside ? 'rounded-md' : ''} ${inMonth ? 'text-foreground/85' : 'text-muted-foreground/50'} ${toDateKey(today) === k && !isA && !isB ? 'font-semibold underline decoration-blue-400 underline-offset-2' : ''}`}
                  >
                    {d.getDate()}
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="truncate">{pick.a ? <><strong className="font-semibold text-foreground">{rangeLabel(pick.a, pick.b || pick.a)}</strong>{pick.b ? ` · ${Math.round((startOfDay(pick.b) - startOfDay(pick.a)) / DAY) + 1} days` : ' · pick the end'}</> : 'Pick a start day'}</span>
              <button type="button" onClick={apply} disabled={!pick.a} className="tp-focus-ring inline-flex h-7 items-center rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-blue-700 disabled:opacity-50">Apply</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
