/**
 * The on-call page's arithmetic (plans/URGENT_RESPONSE_PLAN.md): a colour per
 * person, "how long is left", the month grids, and the calendar file. Pure —
 * every moment is passed in. Local dates ('yyyy-MM-dd') come from the API
 * already resolved in the workspace zone, so nothing here converts zones.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const ms = (value) => (value instanceof Date ? value : new Date(value)).getTime();
export const sameId = (a, b) => a != null && b != null && String(a) === String(b);
export const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

/**
 * Hues for people, by their place in the rotation. Red and amber are left out:
 * on this page they mean "nobody" and "needs cover".
 */
const PERSON_HUES = [221, 172, 262, 330, 199, 142, 291, 12];

/** id → hue, in rotation order first, then anybody else who appears (a cover from outside the order). */
export function hueMap(order = [], otherIds = []) {
  const map = new Map();
  for (const id of [...(Array.isArray(order) ? order : []), ...(Array.isArray(otherIds) ? otherIds : [])]) {
    if (id == null || map.has(String(id))) continue;
    map.set(String(id), PERSON_HUES[map.size % PERSON_HUES.length]);
  }
  return map;
}

export const hueOf = (hues, id) => (id == null ? null : hues?.get(String(id)) ?? null);

/** Inline colours that read on both themes: a see-through tint, and a solid for bars and dots. */
export function tint(hue, strength = 0.16) {
  return hue == null ? 'hsl(var(--muted))' : `hsl(${hue} 80% 55% / ${strength})`;
}
export function solid(hue) {
  return hue == null ? 'hsl(var(--muted-foreground) / 0.45)' : `hsl(${hue} 68% 52%)`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "2 days 3 hours", "5 hours 10 minutes", "12 minutes", "less than a minute"; '' when it is over. */
export function durationWords(fromMs, toMs) {
  const left = toMs - fromMs;
  if (!(left > 0)) return '';
  if (left < MINUTE) return 'less than a minute';
  // To the minute, rounded up: a second after the hour is still "19 hours", not "18 hours".
  const whole = Math.ceil(left / MINUTE) * MINUTE;
  const days = Math.floor(whole / DAY);
  const hours = Math.floor((whole % DAY) / HOUR);
  const minutes = Math.floor((whole % HOUR) / MINUTE);
  if (days > 0) return hours ? `${plural(days, 'day')} ${plural(hours, 'hour')}` : plural(days, 'day');
  if (hours > 0) return minutes ? `${plural(hours, 'hour')} ${plural(minutes, 'minute')}` : plural(hours, 'hour');
  return plural(minutes, 'minute');
}

/** How far through a stretch we are, 0 to 1. */
export function progressOf(startsAt, endsAt, now) {
  const from = ms(startsAt);
  const to = ms(endsAt);
  if (!(to > from)) return 0;
  return Math.min(1, Math.max(0, (ms(now) - from) / (to - from)));
}

/** "This week", "Next week", "In 3 weeks" — by place in the list (the first week holds today). */
export function weekWord(position) {
  if (position <= 0) return 'This week';
  if (position === 1) return 'Next week';
  return `In ${position} weeks`;
}

/** "tomorrow", "in 5 days", "in 3 weeks" — rounded the way people say it; 'now' once it has started. */
export function startsInWords(startsAt, now) {
  const left = ms(startsAt) - ms(now);
  if (left <= 0) return 'now';
  if (left < HOUR) return `in ${plural(Math.max(1, Math.round(left / MINUTE)), 'minute')}`;
  if (left < DAY) return `in ${plural(Math.round(left / HOUR), 'hour')}`;
  const days = Math.round(left / DAY);
  if (days === 1) return 'tomorrow';
  if (days < 14) return `in ${days} days`;
  return `in ${Math.round(days / 7)} weeks`;
}

/** The stretches of every week in one list, oldest first. */
export function allSegments(weeks = []) {
  return (Array.isArray(weeks) ? weeks : []).flatMap((week) => {
    const segments = Array.isArray(week.segments) && week.segments.length
      ? week.segments
      : [{ technicianId: week.scheduled?.id ?? null, startsAt: week.startsAt, endsAt: week.endsAt, cover: false }];
    return segments.map((segment) => ({ ...segment, weekIndex: week.index }));
  });
}

/** The stretch that holds `now` (with the neighbours of the same person merged in), or null. */
export function currentStretch(weeks, now) {
  const list = allSegments(weeks);
  const t = ms(now);
  const at = list.findIndex((segment) => ms(segment.startsAt) <= t && t < ms(segment.endsAt));
  if (at < 0) return null;
  let first = at;
  let last = at;
  while (first > 0 && sameId(list[first - 1].technicianId, list[at].technicianId)) first -= 1;
  while (last < list.length - 1 && sameId(list[last + 1].technicianId, list[at].technicianId)) last += 1;
  return { technicianId: list[at].technicianId, startsAt: list[first].startsAt, endsAt: list[last].endsAt, cover: list[at].cover === true };
}

/**
 * The signed-in person's turn: the stretch they hold now, otherwise the next
 * one they hold (their own week, or a cover they took).
 * @returns {{ startsAt, endsAt, cover: boolean, now: boolean }|null}
 */
export function myTurn(weeks, myId, now) {
  if (myId == null) return null;
  const t = ms(now);
  const mine = allSegments(weeks).filter((segment) => sameId(segment.technicianId, myId) && ms(segment.endsAt) > t);
  if (!mine.length) return null;
  // Two stretches of mine that touch (a cover running into my own week) are one turn.
  const turn = { ...mine[0] };
  for (const segment of mine.slice(1)) {
    if (ms(segment.startsAt) !== ms(turn.endsAt)) break;
    turn.endsAt = segment.endsAt;
  }
  return { startsAt: turn.startsAt, endsAt: turn.endsAt, cover: turn.cover === true, now: ms(turn.startsAt) <= t };
}

/** The first week from now on that is this person's own, for the rotation strip. */
export function nextOwnWeek(weeks, technicianId) {
  return (Array.isArray(weeks) ? weeks : []).find((week) => sameId(week.scheduled?.id, technicianId)) || null;
}

// ---- local dates ('yyyy-MM-dd') -------------------------------------------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT_MONTHS = MONTHS.map((m) => m.slice(0, 3));
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dateParts(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  return { year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

/** '2026-10-12' → "Mon 12 Oct" */
export function dayWords(dateStr) {
  const p = dateParts(dateStr);
  return p ? `${SHORT_DAYS[p.weekday]} ${p.day} ${SHORT_MONTHS[p.month - 1]}` : '';
}

/** The local date of an instant in a zone, 'yyyy-MM-dd' (the viewer's zone when the name is unknown). */
export function localDateOf(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const read = (zone) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...(zone ? { timeZone: zone } : {}) }).format(date);
  try { return read(timeZone); } catch { return read(null); }
}

/**
 * The days grouped into month grids, weeks starting on Monday.
 * @returns {Array<{ key: 'yyyy-MM', label: 'October 2026', rows: Array<Array<object|null>> }>}
 */
export function monthGrids(days = []) {
  const months = [];
  for (const day of Array.isArray(days) ? days : []) {
    const p = dateParts(day?.date);
    if (!p) continue;
    const key = day.date.slice(0, 7);
    let month = months[months.length - 1];
    if (!month || month.key !== key) {
      month = { key, label: `${MONTHS[p.month - 1]} ${p.year}`, cells: [] };
      months.push(month);
      // Pad to the Monday before the first day we have.
      for (let i = 0; i < (p.weekday + 6) % 7; i += 1) month.cells.push(null);
    }
    month.cells.push({ ...day, day: p.day, weekday: p.weekday });
  }
  return months.map(({ key, label, cells }) => {
    const padded = [...cells];
    while (padded.length % 7) padded.push(null);
    const rows = [];
    for (let i = 0; i < padded.length; i += 7) rows.push(padded.slice(i, i + 7));
    return { key, label, rows };
  });
}

// ---- the calendar file -----------------------------------------------------

const icsStamp = (value) => new Date(ms(value)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const icsText = (text) => String(text ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');

/** RFC 5545 wants lines of at most 75 octets; longer ones continue on a line that starts with a space. */
function fold(line) {
  if (line.length <= 73) return [line];
  const out = [line.slice(0, 73)];
  for (let i = 73; i < line.length; i += 72) out.push(` ${line.slice(i, i + 72)}`);
  return out;
}

/**
 * The schedule as an .ics file (UTC instants, so no zone table is needed).
 * `onlyTechnicianId` keeps one person's stretches ("my weeks"); without it,
 * every stretch is an event named after its holder.
 */
export function buildIcs({ weeks, people = {}, onlyTechnicianId = null, workspaceName = '', now = new Date(), host = 'ticketpulse' } = {}) {
  const stretches = [];
  for (const segment of allSegments(weeks)) {
    if (segment.technicianId == null) continue;
    if (onlyTechnicianId != null && !sameId(segment.technicianId, onlyTechnicianId)) continue;
    const last = stretches[stretches.length - 1];
    if (last && sameId(last.technicianId, segment.technicianId) && ms(last.endsAt) === ms(segment.startsAt)) last.endsAt = segment.endsAt;
    else stretches.push({ technicianId: segment.technicianId, startsAt: segment.startsAt, endsAt: segment.endsAt, cover: segment.cover === true });
  }
  const where = workspaceName ? ` (${workspaceName})` : '';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Ticket Pulse//On-call//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(`On-call${where}`)}`,
  ];
  for (const stretch of stretches) {
    const name = people?.[stretch.technicianId]?.name || `Technician ${stretch.technicianId}`;
    const mine = onlyTechnicianId != null;
    const summary = mine ? `On call${where}${stretch.cover ? ', covering' : ''}` : `On call: ${name}${stretch.cover ? ' (cover)' : ''}`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:on-call-${stretch.technicianId}-${icsStamp(stretch.startsAt)}@${host}`,
      `DTSTAMP:${icsStamp(now)}`,
      `DTSTART:${icsStamp(stretch.startsAt)}`,
      `DTEND:${icsStamp(stretch.endsAt)}`,
      `SUMMARY:${icsText(summary)}`,
      `DESCRIPTION:${icsText(mine ? 'You have the after-hours phone for urgent tickets. The schedule is in Ticket Pulse, On-call.' : `${name} has the after-hours phone for urgent tickets.`)}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return { text: `${lines.flatMap(fold).join('\r\n')}\r\n`, count: stretches.length };
}
