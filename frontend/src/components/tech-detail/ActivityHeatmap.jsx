import { useMemo, useState } from 'react';
import { Flame } from 'lucide-react';
import { formatDateLocal } from './utils';

// ─────────────────────────────────────────────────────────────────────────────
// ActivityHeatmap — hand-rolled CSS-grid heatmap of tickets handled per day.
//
// Range follows the page's period filter (Auto): daily/weekly → the 7 days of
// the surrounding week as large labeled cells; monthly → a calendar day-grid.
// A manual override (Auto · W · M · Q · Y) adds quarterly (13 week-columns)
// and yearly (52 week-columns) views. Everything is fr-unit grid + aspect-
// square cells, so the strip ALWAYS fits its container — no horizontal
// overflow at any width (explicit requirement from the mockup review).
//
// Intensity rides the blue→violet tokens; zero-activity days are white with a
// slate border. Clicking any day rescopes the page to that day (daily view).
// ─────────────────────────────────────────────────────────────────────────────

const OVERRIDES = [
  { key: 'auto', label: 'Auto' },
  { key: 'W', label: 'W' },
  { key: 'M', label: 'M' },
  { key: 'Q', label: 'Q' },
  { key: 'Y', label: 'Y' },
];

// Blue→violet ramp on our tokens. Index 0 is the zero state.
const HEAT_CLASSES = [
  'bg-card border border-border',
  'bg-blue-100 dark:bg-blue-500/20',
  'bg-blue-300 dark:bg-blue-500/45',
  'bg-violet-400 dark:bg-violet-500/60',
  'bg-violet-600',
];

function heatClass(count, max) {
  if (!count) return HEAT_CLASSES[0];
  const ratio = count / Math.max(max, 1);
  if (ratio >= 0.75) return HEAT_CLASSES[4];
  if (ratio >= 0.5) return HEAT_CLASSES[3];
  if (ratio >= 0.25) return HEAT_CLASSES[2];
  return HEAT_CLASSES[1];
}

function mondayOf(date) {
  const d = new Date(date);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function labelFor(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

/** Week view: 7 large labeled cells (Mon → Sun of the anchor week). */
function WeekGrid({ countByDay, anchor, todayStr, selectedStr, onSelectDay }) {
  const monday = mondayOf(anchor);
  const days = Array.from({ length: 7 }, (_, i) => formatDateLocal(addDays(monday, i)));
  const max = Math.max(...days.map((d) => countByDay.get(d) || 0), 1);
  return (
    <div className="grid grid-cols-7 gap-1.5">
      {days.map((dateStr) => {
        const count = countByDay.get(dateStr) || 0;
        const future = dateStr > todayStr;
        const isSelected = dateStr === selectedStr;
        const dow = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
        return (
          <button
            key={dateStr}
            type="button"
            disabled={future}
            onClick={() => onSelectDay(dateStr)}
            title={`${labelFor(dateStr)} · ${count} handled`}
            className={`tp-focus-ring flex min-w-0 flex-col items-center justify-center rounded-lg py-2 transition-colors ${
              future ? 'bg-muted/50 opacity-40' : heatClass(count, max)
            } ${isSelected ? 'ring-2 ring-blue-500 ring-offset-1' : ''} ${!future ? 'cursor-pointer hover:ring-1 hover:ring-blue-300' : ''}`}
          >
            <span className={`text-[9px] font-bold uppercase tracking-wide ${count / max >= 0.5 && count > 0 ? 'text-white/80' : 'text-muted-foreground/75'}`}>
              {dow}
            </span>
            <span className={`text-sm font-bold tabular-nums ${count === 0 || future ? 'text-muted-foreground/50' : count / max >= 0.5 ? 'text-white' : 'text-foreground'}`}>
              {future ? '' : count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Month view: classic calendar day-grid for the anchor month. */
function MonthGrid({ countByDay, anchor, todayStr, selectedStr, onSelectDay }) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1, 12, 0, 0);
  const daysInMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
  const offset = (first.getDay() + 6) % 7;
  const cells = [
    ...Array.from({ length: offset }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => formatDateLocal(addDays(first, i))),
  ];
  const max = Math.max(...cells.map((d) => (d ? countByDay.get(d) || 0 : 0)), 1);
  return (
    <div>
      <div className="mb-1 grid grid-cols-7 gap-1">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d} className="text-center text-[9px] font-bold uppercase tracking-wide text-muted-foreground/75">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((dateStr, idx) => {
          if (!dateStr) return <div key={`pad-${idx}`} />;
          const count = countByDay.get(dateStr) || 0;
          const future = dateStr > todayStr;
          const isSelected = dateStr === selectedStr;
          return (
            <button
              key={dateStr}
              type="button"
              disabled={future}
              onClick={() => onSelectDay(dateStr)}
              title={`${labelFor(dateStr)} · ${count} handled`}
              className={`tp-focus-ring flex aspect-square min-w-0 items-center justify-center rounded-md text-[10px] font-semibold tabular-nums transition-colors ${
                future ? 'bg-muted/50 opacity-40' : heatClass(count, max)
              } ${isSelected ? 'ring-2 ring-blue-500 ring-offset-1' : ''} ${
                count === 0 || future ? 'text-muted-foreground/50' : count / max >= 0.5 ? 'text-white' : 'text-foreground/85'
              } ${!future ? 'cursor-pointer hover:ring-1 hover:ring-blue-300' : ''}`}
            >
              {new Date(dateStr + 'T12:00:00').getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Quarter/Year view: N week-columns × 7 weekday rows, GitHub style. */
function WeekColumnsGrid({ countByDay, anchor, weeks, todayStr, selectedStr, onSelectDay }) {
  const endMonday = mondayOf(anchor);
  const startMonday = addDays(endMonday, -7 * (weeks - 1));
  const columns = Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: 7 }, (_, i) => formatDateLocal(addDays(startMonday, w * 7 + i))),
  );
  const max = Math.max(
    ...columns.flat().map((d) => countByDay.get(d) || 0),
    1,
  );
  // Month label whenever a column starts a new month.
  const monthLabels = columns.map((col, idx) => {
    const m = new Date(col[0] + 'T12:00:00').toLocaleDateString('en-US', { month: 'short' });
    if (idx === 0) return m;
    const prev = new Date(columns[idx - 1][0] + 'T12:00:00').toLocaleDateString('en-US', { month: 'short' });
    return m === prev ? '' : m;
  });
  return (
    <div className="min-w-0">
      <div
        className="mb-0.5 grid gap-[2px]"
        style={{ gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` }}
        aria-hidden="true"
      >
        {monthLabels.map((label, idx) => (
          <div key={idx} className="overflow-visible whitespace-nowrap text-[8px] font-semibold uppercase text-muted-foreground/75">
            {label}
          </div>
        ))}
      </div>
      <div
        className="grid gap-[2px]"
        style={{ gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` }}
      >
        {columns.map((col, w) => (
          <div key={w} className="grid min-w-0 grid-rows-7 gap-[2px]">
            {col.map((dateStr) => {
              const count = countByDay.get(dateStr) || 0;
              const future = dateStr > todayStr;
              const isSelected = dateStr === selectedStr;
              return (
                <button
                  key={dateStr}
                  type="button"
                  disabled={future}
                  onClick={() => onSelectDay(dateStr)}
                  title={`${labelFor(dateStr)} · ${count} handled`}
                  aria-label={`${labelFor(dateStr)}: ${count} handled`}
                  className={`tp-focus-ring aspect-square w-full min-w-0 rounded-[3px] transition-colors ${
                    future ? 'bg-muted/50 opacity-40' : heatClass(count, max)
                  } ${isSelected ? 'ring-2 ring-blue-500' : ''} ${!future ? 'cursor-pointer hover:ring-1 hover:ring-blue-400' : ''}`}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ActivityHeatmap({
  days = [],                 // [{ date: 'YYYY-MM-DD', count }]
  viewMode = 'daily',        // page period: daily | weekly | monthly
  selectedDate = null,       // YYYY-MM-DD | null (today)
  selectedWeek = null,       // Date (Monday) | null
  selectedMonth = null,      // Date (1st of month) | null
  onSelectDay,               // (dateStr) => void
  isLoading = false,
}) {
  const [override, setOverride] = useState('auto');

  const countByDay = useMemo(
    () => new Map((days || []).map((d) => [d.date, d.count])),
    [days],
  );

  const todayStr = formatDateLocal(new Date());
  const selectedStr = viewMode === 'daily' ? (selectedDate || todayStr) : null;

  // Anchor date the ranges are computed around, derived from the page period.
  const anchor = viewMode === 'weekly' && selectedWeek
    ? new Date(selectedWeek)
    : viewMode === 'monthly' && selectedMonth
      ? new Date(selectedMonth)
      : selectedDate
        ? new Date(selectedDate + 'T12:00:00')
        : new Date();

  const effective = override === 'auto'
    ? (viewMode === 'monthly' ? 'M' : 'W')
    : override;

  // Q/Y anchor at "now or the anchor, whichever is later-capped": use the
  // anchor week so navigating back in time shifts the long views too.
  const rangeLabel = effective === 'W'
    ? 'Week'
    : effective === 'M'
      ? anchor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      : effective === 'Q'
        ? 'Last 13 weeks'
        : 'Last 52 weeks';

  return (
    <section className="tp-card rounded-xl p-3" aria-label="Activity heatmap">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/75">
          <Flame className="h-3.5 w-3.5 text-violet-400" aria-hidden="true" />
          Activity
          <span className="normal-case tracking-normal text-muted-foreground/50">· {rangeLabel}</span>
        </h3>
        <div className="flex rounded-md bg-muted p-0.5 text-[10px] font-bold">
          {OVERRIDES.map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => setOverride(o.key)}
              aria-pressed={override === o.key}
              title={o.key === 'auto' ? 'Follow the page period' : `${{ W: 'Week', M: 'Month', Q: 'Quarter (13 weeks)', Y: 'Year (52 weeks)' }[o.key]} view`}
              className={`tp-focus-ring rounded px-1.5 py-0.5 transition-colors ${
                override === o.key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground/75 hover:text-muted-foreground'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="flex h-16 items-center justify-center text-xs text-muted-foreground/75">Loading activity…</div>
      ) : effective === 'W' ? (
        <WeekGrid countByDay={countByDay} anchor={anchor} todayStr={todayStr} selectedStr={selectedStr} onSelectDay={onSelectDay} />
      ) : effective === 'M' ? (
        <MonthGrid countByDay={countByDay} anchor={anchor} todayStr={todayStr} selectedStr={selectedStr} onSelectDay={onSelectDay} />
      ) : (
        <WeekColumnsGrid
          countByDay={countByDay}
          anchor={anchor}
          weeks={effective === 'Q' ? 13 : 52}
          todayStr={todayStr}
          selectedStr={selectedStr}
          onSelectDay={onSelectDay}
        />
      )}

      <div className="mt-2 flex items-center justify-end gap-1 text-[9px] text-muted-foreground/75">
        Less
        {HEAT_CLASSES.map((cls) => (
          <span key={cls} className={`inline-block h-2.5 w-2.5 rounded-[3px] ${cls}`} aria-hidden="true" />
        ))}
        More
      </div>
    </section>
  );
}
