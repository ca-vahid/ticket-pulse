import { addDaysKey, dayKey, parseDay } from './availabilityUi';

/**
 * Pure helpers for the team views (Overview, Wallchart, Calendar — 5 Oct
 * 2026). Days are 'YYYY-MM-DD' keys; nothing here touches the network.
 */

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAY_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** Every day from `from` to `to` inclusive: { key, n, dow, month }. */
export function rangeDays(from, to) {
  const out = [];
  for (let k = from; k <= to; k = addDaysKey(k, 1)) {
    const d = parseDay(k);
    out.push({ key: k, n: d.getDate(), dow: d.getDay(), month: d.getMonth() });
    if (out.length > 120) break;
  }
  return out;
}

export function monthRange(year, month) {
  return { from: dayKey(new Date(year, month, 1)), to: dayKey(new Date(year, month + 1, 0)) };
}

/** The Monday of the week holding `key`. */
export function weekStartKey(key) {
  const d = parseDay(key);
  const back = (d.getDay() + 6) % 7;
  return addDaysKey(key, -back);
}

/** This week's Monday through four weeks on (28 days). */
export function nextWeeksRange(todayKey, weeks = 4) {
  const from = weekStartKey(todayKey);
  return { from, to: addDaysKey(from, weeks * 7 - 1) };
}

export const isWeekend = (dow) => dow === 0 || dow === 6;

/** Monday-first weeks covering a month: [[7 day keys], …]. */
export function monthWeeks(year, month) {
  const { from, to } = monthRange(year, month);
  const weeks = [];
  for (let start = weekStartKey(from); start <= to; start = addDaysKey(start, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDaysKey(start, i)));
  }
  return weeks;
}

/**
 * Where an entry sits in a row of `days`: one or more { start, end, first }
 * index spans. A multi-day entry is split around weekends and holidays (it
 * does not count those days) so the bar shows the days actually taken; a
 * single-day entry stays where it is booked.
 */
export function entrySegments(entry, days, isNonWorking = () => false) {
  const single = entry.startDate === entry.endDate;
  const segs = [];
  let open = null;
  days.forEach((d, i) => {
    const inside = d.key >= entry.startDate && d.key <= entry.endDate && (single || !isNonWorking(d));
    if (inside) {
      if (!open) open = { start: i, end: i };
      else open.end = i;
    } else if (open) {
      segs.push(open);
      open = null;
    }
  });
  if (open) segs.push(open);
  return segs.map((s, i) => ({ ...s, first: i === 0 }));
}

/**
 * Who is away each day: approved entries whose type takes the person out
 * (availability OFF — working from home or on site still counts as working).
 * Returns Map dayKey → [email].
 */
export function coverageByDay(entries, days, isNonWorking = () => false) {
  const map = new Map(days.map((d) => [d.key, new Set()]));
  for (const e of entries || []) {
    if (e.status !== 'approved' || (e.availability && e.availability !== 'OFF')) continue;
    for (const d of days) {
      if (d.key < e.startDate || d.key > e.endDate) continue;
      if (e.startDate !== e.endDate && isNonWorking(d)) continue;
      map.get(d.key).add(e.email);
    }
  }
  return new Map([...map.entries()].map(([k, v]) => [k, [...v]]));
}

/** none / light / medium / heavy, by the share of the team away. */
export function coverageTone(count, size) {
  if (!count || !size) return 'none';
  const share = count / size;
  if (share < 0.15) return 'light';
  if (share < 0.3) return 'medium';
  return 'heavy';
}

/**
 * Rows grouped for the wallchart: by office (default) or approval group.
 * Someone in several groups appears under each. People without one go last.
 */
export function groupPeople(people, mode, { offices = [], groups = [], groupIdsOf = () => [] } = {}) {
  const sections = new Map();
  const add = (key, label, p, order) => {
    if (!sections.has(key)) sections.set(key, { key, label, order, people: [] });
    sections.get(key).people.push(p);
  };
  const officeName = new Map(offices.map((o) => [o.id, o.name]));
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  for (const p of people) {
    if (mode === 'group') {
      const ids = groupIdsOf(p).filter((id) => groupName.has(id));
      if (!ids.length) add('none', 'Not in an approval group', p, 1);
      for (const id of ids) add(`g${id}`, groupName.get(id), p, 0);
    } else {
      const name = officeName.get(p.officeId);
      if (name) add(`o${p.officeId}`, name, p, 0);
      else add('none', 'No office set', p, 1);
    }
  }
  return [...sections.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

/** The first working day after `key` (skips weekends and holidays). */
export function nextWorkingDayKey(key, holidays = new Set()) {
  let k = addDaysKey(key, 1);
  for (let i = 0; i < 30; i += 1) {
    const dow = parseDay(k).getDay();
    if (!isWeekend(dow) && !holidays.has(k)) return k;
    k = addDaysKey(k, 1);
  }
  return k;
}

/** Days from today to `key` (0 = today). */
export function daysUntil(todayKey, key) {
  return Math.round((parseDay(key) - parseDay(todayKey)) / 86400000);
}

/**
 * Lanes for the month view: each entry gets the first lane free across the
 * days it covers in this week. Returns [{ entry, start, end, lane }].
 */
export function weekLanes(entries, weekKeys) {
  const placed = [];
  const lanes = [];
  const sorted = [...(entries || [])].sort((a, b) => a.startDate.localeCompare(b.startDate) || b.endDate.localeCompare(a.endDate));
  for (const e of sorted) {
    const idx = weekKeys.map((k, i) => (k >= e.startDate && k <= e.endDate ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    const start = idx[0];
    const end = idx[idx.length - 1];
    let lane = 0;
    while (lanes[lane] && lanes[lane].some(([a, b]) => !(end < a || start > b))) lane += 1;
    (lanes[lane] = lanes[lane] || []).push([start, end]);
    placed.push({ entry: e, start, end, lane });
  }
  return placed;
}
