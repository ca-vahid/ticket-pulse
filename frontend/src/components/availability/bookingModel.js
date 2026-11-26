import { MONTHS, addDaysKey, fmtMinute, parseDay } from './availabilityUi';
import { isWeekend, monthWeeks, nextWorkingDayKey } from './calendarModel';

/**
 * Pure helpers for My time (redesign, QA 11-25 #1): the month picker's
 * selection, the booking summary words, the most-used leave types, and what
 * "Coming up" lists. Days are 'YYYY-MM-DD' keys; nothing here touches the
 * network.
 */

export const WEEKDAY_SHORT_UK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_SHORT = MONTHS.map((m) => m.slice(0, 3));

/** What Coming up lists, and what can still be cancelled: approved or waiting. */
export const LIVE_STATUSES = ['approved', 'pending'];

/**
 * The server's words for a booking that starts before today on a type that is
 * not "booked after the fact" (any type may still be booked in the past; it
 * goes to an approver).
 */
export const PAST_SENTENCE = 'It starts in the past, so an approver has to confirm it.';

/** "Mon 30 Nov – Fri 4 Dec · mornings": a request's dates and part of the day, in the form's one format. */
export function requestWords(r, { today = null } = {}) {
  const base = rangeWords(r.startDate, r.endDate, { today });
  const single = r.startDate === r.endDate;
  if (r.dayPart === 'am') return `${base} · ${single ? 'morning' : 'mornings'}`;
  if (r.dayPart === 'pm') return `${base} · ${single ? 'afternoon' : 'afternoons'}`;
  if (r.dayPart === 'hours' && r.startMinute != null) return `${base} · ${fmtMinute(r.startMinute)}–${fmtMinute(r.endMinute)}`;
  return base;
}

/** "Wed 25 Nov" (with the year when asked). */
export function shortDay(key, { year = false } = {}) {
  const d = parseDay(key);
  return `${WEEKDAY_SHORT_UK[d.getDay()]} ${d.getDate()} ${MONTH_SHORT[d.getMonth()]}${year ? ` ${d.getFullYear()}` : ''}`;
}

/** "Wednesday 25 November". */
export function longDay(key) {
  const d = parseDay(key);
  return `${WEEKDAY_LONG[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/**
 * A calendar day's accessible name: "Wednesday 25 November, today, Working
 * from home booked" (plus weekend / holiday, the range, not available).
 */
export function dayLabel(key, { today, holiday, booked = [], disabled, inRange }) {
  const d = parseDay(key);
  const parts = [longDay(key)];
  if (key === today) parts.push('today');
  else if (today && key < today) parts.push('past');
  if (holiday) parts.push(`holiday: ${holiday}`);
  else if (isWeekend(d.getDay())) parts.push('weekend');
  for (const b of booked) parts.push(`${b.name} ${b.status === 'pending' ? 'waiting for approval' : 'booked'}`);
  if (inRange) parts.push('in the range');
  if (disabled) parts.push('not available');
  return parts.join(', ');
}

/**
 * The dates of a pick in words: "Wed 25 Nov", "Mon 1 – Fri 5 Dec",
 * "Mon 30 Nov – Fri 4 Dec"; the year only when the range crosses one or is
 * not this year. `joiner` is " to " for screen readers.
 */
export function rangeWords(start, end, { today = null, joiner = ' – ' } = {}) {
  if (!start) return '';
  const e = end || start;
  const ys = start.slice(0, 4);
  const ye = e.slice(0, 4);
  const showYear = ys !== ye || (today && ys !== today.slice(0, 4));
  if (start === e) return shortDay(start, { year: showYear });
  const sameMonth = start.slice(0, 7) === e.slice(0, 7);
  if (sameMonth && !showYear) {
    const d = parseDay(start);
    return `${WEEKDAY_SHORT_UK[d.getDay()]} ${d.getDate()}${joiner}${shortDay(e)}`;
  }
  return `${shortDay(start, { year: showYear })}${joiner}${shortDay(e, { year: showYear })}`;
}

/** Working days from start to end: weekends and holidays are skipped (the dry run's rule). */
export function countWorkingDays(start, end, holidaySet = new Set()) {
  if (!start || !end || end < start) return 0;
  let n = 0;
  for (let k = start, i = 0; k <= end && i < 400; k = addDaysKey(k, 1), i += 1) {
    if (!isWeekend(parseDay(k).getDay()) && !holidaySet.has(k)) n += 1;
  }
  return n;
}

/**
 * A tap on a day. `sel` is { start, end, open }: `open` means one day is
 * picked and the next tap makes it a range. Tapping a day before the first
 * swaps the ends; tapping the same day keeps the single day; a tap after a
 * finished pick starts over. `single` (an hours type) never makes a range.
 */
export function pickDay(sel, key, { single = false } = {}) {
  if (single || !sel?.start || !sel.open) return { start: key, end: key, open: !single };
  if (key === sel.start) return { start: key, end: key, open: false };
  return key < sel.start ? { start: key, end: sel.start, open: false } : { start: sel.start, end: key, open: false };
}

/**
 * The person's most-used leave types: the types they booked most often
 * (approved or waiting requests in the leave year the API returns), ties and
 * the rest in the admins' sort order. Always `n` types when there are that many.
 */
export function mostUsedTypes(types = [], requests = [], n = 4) {
  const count = new Map();
  for (const r of requests || []) {
    if (!LIVE_STATUSES.includes(r.status)) continue;
    count.set(r.leaveTypeId, (count.get(r.leaveTypeId) || 0) + 1);
  }
  const order = new Map(types.map((t, i) => [t.id, i]));
  return [...types]
    .sort((a, b) => (count.get(b.id) || 0) - (count.get(a.id) || 0) || order.get(a.id) - order.get(b.id))
    .slice(0, n);
}

/** Coming up: approved or waiting requests that are not over, soonest first. Never cancelled or denied. */
export function upcomingRequests(requests = [], today) {
  return (requests || [])
    .filter((r) => LIVE_STATUSES.includes(r.status) && r.endDate >= today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.endDate.localeCompare(b.endDate));
}

/** Everything else: over, cancelled or denied, newest first. */
export function pastRequests(requests = [], today) {
  return (requests || [])
    .filter((r) => !(LIVE_STATUSES.includes(r.status) && r.endDate >= today))
    .sort((a, b) => b.startDate.localeCompare(a.startDate));
}

/**
 * Days the person already has booked: Map dayKey → [{ name, color, status }].
 * A multi-day booking marks its working days only (as the team views draw
 * it); a single day is marked where it is booked.
 */
export function bookedByDay(requests = [], typeById = new Map(), { excludeId = null, holidaySet = new Set() } = {}) {
  const map = new Map();
  for (const r of requests || []) {
    if (!LIVE_STATUSES.includes(r.status) || r.id === excludeId || !r.startDate) continue;
    const type = typeById.get(r.leaveTypeId);
    const single = r.startDate === r.endDate;
    const mark = { name: type?.name || 'Time away', color: type?.color || 'slate', status: r.status };
    for (let k = r.startDate, i = 0; k <= r.endDate && i < 370; k = addDaysKey(k, 1), i += 1) {
      if (!single && (isWeekend(parseDay(k).getDay()) || holidaySet.has(k))) continue;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(mark);
    }
  }
  return map;
}

/** Monday-first weeks for the month picker: [[{ key, inMonth }] x7]. */
export function monthCells(year, month) {
  return monthWeeks(year, month).map((week) => week.map((key) => ({ key, inMonth: parseDay(key).getMonth() === month })));
}

/** The next working day after today (skips weekends and holidays). */
export function tomorrowKey(today, holidaySet = new Set()) {
  return nextWorkingDayKey(today, holidaySet);
}

/** Monday to Friday of next week. */
export function nextWeekRange(today) {
  const d = parseDay(today);
  const toMonday = ((8 - d.getDay()) % 7) || 7;
  const monday = addDaysKey(today, toMonday);
  return { start: monday, end: addDaysKey(monday, 4) };
}

/** "back Mon": the first working day after an all-day absence. */
export function backDay(endDate, holidaySet = new Set()) {
  // 26 Nov 2026: "back Mon 4 Jan", never a bare "back Mon" a week or a year away.
  return shortDay(nextWorkingDayKey(endDate, holidaySet));
}
