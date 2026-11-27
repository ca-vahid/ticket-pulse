import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  COLOR_DOT, COLOR_TEXT, HOLIDAY_BG, MONTHS, WEEKEND_BG, addDaysKey, parseDay, todayKey,
} from './availabilityUi';
import { isWeekend } from './calendarModel';
import { WEEKDAY_LONG, dayLabel, monthCells } from './bookingModel';

/**
 * The inline month calendar of "Book time away" (QA 11-25 #1). Props in,
 * nothing fetched, so it renders on its own in a harness.
 *
 *   - a real grid (role="grid"): arrow keys move a day or a week, Home/End
 *     to the week's ends, Page Up/Down a month; Enter or Space picks;
 *   - picked days carry aria-selected; the range between the ends is filled;
 *   - dots under the days already booked (filled when approved, a hollow ring
 *     while waiting), coloured by type, with the words in the day's label and
 *     tooltip;
 *   - weekends and holidays are muted and say so; past days are quieter but
 *     can be picked (any type can be booked after the fact; it goes to an
 *     approver); today is outlined. A harness may pass `minKey` to disable
 *     the days before it, and the keyboard then stops at its month too.
 *
 * `onPick(key)` gets the day; the parent decides what a tap means (pickDay).
 */

const HEAD = [1, 2, 3, 4, 5, 6, 0];
const NAV_BTN = 'tp-focus-ring grid h-9 w-9 place-items-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40';

const NO_BOOKINGS = new Map();
const firstOfMonth = (key) => `${key.slice(0, 7)}-01`;

/** "October 2026": the month `n` away from the one in view. */
const monthName = (view, n) => {
  const d = new Date(view.year, view.month + n, 1);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

const monthOf = (key) => {
  const d = parseDay(key);
  return { year: d.getFullYear(), month: d.getMonth() };
};
const sameMonth = (key, view) => {
  const d = parseDay(key);
  return d.getFullYear() === view.year && d.getMonth() === view.month;
};

export default function MonthPicker({
  start = null,
  end = null,
  onPick,
  today = todayKey(),
  minKey = null,
  holidays = {},
  booked = NO_BOOKINGS,
  labelledBy = null,
  single = false,
}) {
  const uid = useId().replace(/:/g, '');
  const headingId = `mp-${uid}-month`;
  const [view, setView] = useState(() => monthOf(start || today));
  const [focusKey, setFocusKey] = useState(() => start || today);
  const wantFocus = useRef(false);
  const gridRef = useRef(null);

  // A pick made elsewhere (a shortcut, a request being changed) brings its month into view.
  useEffect(() => {
    if (!start) return;
    setFocusKey(start);
    setView((v) => (sameMonth(start, v) ? v : monthOf(start)));
  }, [start]);

  const weeks = useMemo(() => monthCells(view.year, view.month), [view]);
  const tabKey = sameMonth(focusKey, view) ? focusKey : weeks.flat().find((c) => c.inMonth)?.key;

  useEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    gridRef.current?.querySelector(`[data-day="${focusKey}"]`)?.focus();
  }, [focusKey, view]);

  const step = (n) => {
    const d = new Date(view.year, view.month + n, 1);
    const next = { year: d.getFullYear(), month: d.getMonth() };
    setView(next);
    // Keep the day of the month where it exists.
    const day = Math.min(parseDay(focusKey).getDate(), new Date(next.year, next.month + 1, 0).getDate());
    setFocusKey(`${next.year}-${String(next.month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  };

  const moveTo = (key) => {
    // As the Previous button: never into a month before `minKey`'s.
    if (minKey && key < firstOfMonth(minKey)) return;
    wantFocus.current = true;
    setFocusKey(key);
    if (!sameMonth(key, view)) setView(monthOf(key));
  };

  const isDisabled = (key) => Boolean(minKey && key < minKey);

  const onKeyDown = (e, key) => {
    const dow = (parseDay(key).getDay() + 6) % 7; // Monday = 0
    const map = {
      ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -dow, End: 6 - dow,
    };
    if (e.key in map) {
      e.preventDefault();
      moveTo(addDaysKey(key, map[e.key]));
      return;
    }
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      const d = parseDay(key);
      const t = new Date(d.getFullYear(), d.getMonth() + (e.key === 'PageUp' ? -1 : 1), 1);
      const day = Math.min(d.getDate(), new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate());
      moveTo(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!isDisabled(key)) onPick?.(key);
    }
  };

  const lo = start && end ? (start <= end ? start : end) : start;
  const hi = start && end ? (start <= end ? end : start) : start;
  const prevDisabled = Boolean(minKey && `${view.year}-${String(view.month + 1).padStart(2, '0')}` <= minKey.slice(0, 7));

  return (
    <div className="min-w-0" data-testid="month-picker">
      <div className="mb-1 flex items-center justify-between gap-2">
        <button type="button" className={NAV_BTN} onClick={() => step(-1)} disabled={prevDisabled} aria-label={`Previous month, ${monthName(view, -1)}`}>
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        {/* The month heading is announced when it changes (its own polite region; the pick summary has the card's other one). */}
        <h3 id={headingId} className="text-sm font-semibold text-foreground" aria-live="polite" data-testid="month-picker-month">{MONTHS[view.month]} {view.year}</h3>
        <button type="button" className={NAV_BTN} onClick={() => step(1)} aria-label={`Next month, ${monthName(view, 1)}`}>
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <table
        ref={gridRef}
        role="grid"
        aria-multiselectable={single ? undefined : 'true'}
        aria-labelledby={labelledBy ? `${labelledBy} ${headingId}` : headingId}
        className="w-full table-fixed border-collapse"
      >
        <thead>
          <tr>
            {HEAD.map((n) => (
              <th key={n} scope="col" abbr={WEEKDAY_LONG[n]} className={`pb-1 text-center text-xs font-medium ${n === 0 || n === 6 ? 'text-muted-foreground/75' : 'text-muted-foreground'}`}>
                {WEEKDAY_LONG[n].slice(0, 3)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0].key}>
              {week.map(({ key, inMonth }) => {
                // Phone cells stay 44 px tall (tap targets). From sm up the month spans its
                // container (QA 11-26 #1) with 40 px rows: about 300 px for the whole grid.
                if (!inMonth) return <td key={key} className="h-11 p-0 sm:h-10" />;
                const d = parseDay(key);
                const holiday = holidays[key] || null;
                const offDay = isWeekend(d.getDay()) || Boolean(holiday);
                const disabled = isDisabled(key);
                const marks = booked.get(key) || [];
                const inRange = Boolean(lo && key >= lo && key <= hi);
                const isEnd = key === lo || key === hi;
                const between = inRange && !isEnd;
                const isToday = key === today;
                const tip = [holiday, ...marks.map((m) => `${m.name} ${m.status === 'pending' ? 'waiting for approval' : 'booked'}`)].filter(Boolean).join(' · ');
                // The range band runs edge to edge; its ends are rounded.
                const band = inRange && lo !== hi
                  ? `bg-primary/10 dark:bg-primary/20 ${key === lo ? 'rounded-l-md' : ''} ${key === hi ? 'rounded-r-md' : ''}`
                  : '';
                const past = key < today;
                // Three looks, each AA and each named in the day's label:
                //   past days         plain muted numbers, no shading ("past");
                //   weekends/holidays shaded as on the other calendars (WEEKEND_BG / HOLIDAY_BG),
                //                     numbers a little softer than working days ("weekend" / "holiday");
                //   working days      full-strength numbers.
                // Inside a picked range the band shows instead of the shading.
                const shade = offDay && !past && !inRange ? (holiday ? HOLIDAY_BG : WEEKEND_BG) : '';
                const face = isEnd && inRange
                  ? 'bg-primary text-primary-foreground font-semibold'
                  : disabled
                    ? 'text-muted-foreground/45'
                    : past
                      ? `text-muted-foreground ${between ? '' : 'hover:bg-muted'}`
                      : offDay
                        ? `text-foreground/70 ${shade} ${between ? '' : 'hover:bg-muted'}`
                        : `text-foreground ${between ? '' : 'hover:bg-muted'}`;
                return (
                  <td
                    key={key}
                    role="gridcell"
                    data-day={key}
                    tabIndex={key === tabKey ? 0 : -1}
                    aria-selected={inRange}
                    aria-disabled={disabled || undefined}
                    aria-label={dayLabel(key, { today, holiday, booked: marks, disabled, inRange: between })}
                    title={tip || undefined}
                    onClick={() => { if (!disabled) { setFocusKey(key); onPick?.(key); } }}
                    onKeyDown={(e) => onKeyDown(e, key)}
                    className={`tp-focus-ring h-11 cursor-pointer p-0 align-middle outline-none sm:h-10 ${band} ${disabled ? 'cursor-not-allowed' : ''}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`mx-auto flex h-10 w-full max-w-[2.75rem] flex-col items-center justify-center rounded-md text-sm tabular-nums sm:h-9 sm:max-w-[4.5rem] ${face} ${isToday && !(isEnd && inRange) ? 'ring-1 ring-inset ring-primary' : ''}`}
                    >
                      <span className="leading-none">{d.getDate()}</span>
                      <span className="mt-1 flex h-2 items-center gap-0.5">
                        {marks.slice(0, 3).map((m, i) => (
                          <span
                            key={`${m.name}-${m.status}-${i}`}
                            data-dot={m.status === 'pending' ? 'waiting' : 'booked'}
                            className={`h-2 w-2 rounded-full ${m.status === 'pending'
                              // Waiting: a hollow ring in the type's colour; booked: a filled dot.
                              ? `border-[1.5px] border-current ${COLOR_TEXT[m.color] || COLOR_TEXT.slate} ${isEnd && inRange ? 'bg-primary-foreground' : 'bg-transparent'}`
                              : `${COLOR_DOT[m.color] || COLOR_DOT.slate} ${isEnd && inRange ? 'ring-1 ring-primary-foreground' : ''}`}`}
                          />
                        ))}
                      </span>
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground" data-testid="month-picker-legend">
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-muted-foreground/70" aria-hidden="true" />Booked</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full border-[1.5px] border-muted-foreground/70" aria-hidden="true" />Waiting for approval</span>
        <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded-sm ring-1 ring-inset ring-primary" aria-hidden="true" />Today</span>
        <span className="inline-flex items-center gap-1"><span className={`h-3 w-3 rounded-sm ring-1 ring-inset ring-border ${WEEKEND_BG}`} aria-hidden="true" />Weekend</span>
        <span className="inline-flex items-center gap-1"><span className={`h-3 w-3 rounded-sm ring-1 ring-inset ring-rose-200 dark:ring-rose-500/30 ${HOLIDAY_BG}`} aria-hidden="true" />Holiday</span>
        <span>Grey numbers: past days</span>
      </p>
    </div>
  );
}
