import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

/**
 * Teams digest times (QA 11-17 #2). Pure functions: no database, no clock.
 *
 * A workspace has up to four digest times. The first is the daily digest
 * everyone already gets (each person can still move theirs, in their own
 * time zone). The others are Pacific wall-clock times a person switches on
 * for themselves ("Also send my digest at 3:00 PM PT").
 *
 * One digest per person per time per day: a time is due once its moment has
 * passed today and the person's last digest went out before that moment
 * (notification_preferences.last_digest_at, the same column the daily digest
 * has always used). A later digest in the day lists only what is new since the
 * earlier one.
 */

export const PACIFIC = 'America/Vancouver';
export const MAX_DIGEST_TIMES = 4;
export const DEFAULT_DIGEST_TIME = '08:00';
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isDigestTime = (v) => typeof v === 'string' && TIME_RE.test(v);

function zone(tz) {
  const z = String(tz || '').trim();
  if (!z) return PACIFIC;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return z;
  } catch {
    return PACIFIC;
  }
}

/** Valid, unique, sorted 'HH:MM' times, at most `max`. */
export function cleanTimes(list, max = MAX_DIGEST_TIMES) {
  const out = [...new Set((Array.isArray(list) ? list : []).filter(isDigestTime))].sort();
  return out.slice(0, max);
}

/**
 * The workspace list: the daily digest time first, then up to three extra
 * times (sorted, never the same as the first).
 */
export function workspaceDigestTimes(first, extras = []) {
  const head = isDigestTime(first) ? first : DEFAULT_DIGEST_TIME;
  return [head, ...cleanTimes(extras, MAX_DIGEST_TIMES).filter((t) => t !== head).slice(0, MAX_DIGEST_TIMES - 1)];
}

/** '15:00' → '3:00 PM PT'. A zone other than Pacific gets its own short name. */
export function timeLabel(hhmm, tz = PACIFIC) {
  if (!isDigestTime(hhmm)) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const word = `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  const z = zone(tz);
  if (z === PACIFIC || z === 'America/Los_Angeles') return `${word} PT`;
  try {
    const short = new Intl.DateTimeFormat('en-US', { timeZone: z, timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value;
    return short ? `${word} ${short}` : word;
  } catch {
    return word;
  }
}

/** The local calendar date of an instant in a zone ('yyyy-MM-dd'). */
export function localDate(at, tz = PACIFIC) {
  return formatInTimeZone(at, zone(tz), 'yyyy-MM-dd');
}

/** A local date and 'HH:MM' in a zone → the instant (DST-safe: read from the zone data). */
export function zonedInstant(dateStr, hhmm, tz = PACIFIC) {
  return fromZonedTime(`${dateStr}T${hhmm}:00`, zone(tz));
}

/** A slot of yesterday still counts this long after its moment (a 23:55 slot, next tick 00:02). */
export const LATE_GRACE_MS = 30 * 60 * 1000;

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const isWeekend = (dateStr) => [0, 6].includes(new Date(`${dateStr}T00:00:00Z`).getUTCDay());

/**
 * The digest moments for one person around `now`, earliest first: today's
 * and yesterday's (yesterday's are `stale` - never due - once more than
 * LATE_GRACE_MS old). Each slot belongs
 * to a weekday in its OWN zone (weekends dropped there):
 *   first: their own daily digest time, in their own zone (today's behaviour)
 *   extras: the extra workspace times they switched on, in Pacific time
 * @returns {Array<{ time, tz, date, at: Date, label, first: boolean }>}
 */
export function digestSlotsFor({ now = new Date(), firstTime = DEFAULT_DIGEST_TIME, firstTz = PACIFIC, extras = [] } = {}) {
  const slots = [];
  const head = isDigestTime(firstTime) ? firstTime : DEFAULT_DIGEST_TIME;
  const fz = zone(firstTz);
  const wanted = [{ time: head, tz: fz, first: true }, ...cleanTimes(extras).map((t) => ({ time: t, tz: PACIFIC, first: false }))];
  for (const w of wanted) {
    const today = localDate(now, w.tz);
    for (const date of [addDays(today, -1), today]) {
      if (isWeekend(date)) continue;
      const at = zonedInstant(date, w.time, w.tz);
      // Yesterday's slots stay in the list (to name an earlier digest) but
      // only count as due within the grace.
      const stale = date !== today && now.getTime() - at.getTime() > LATE_GRACE_MS;
      if (slots.some((s) => s.at.getTime() === at.getTime())) continue;
      slots.push({ time: w.time, tz: w.tz, date, at, label: timeLabel(w.time, w.tz), first: w.first, stale });
    }
  }
  return slots.sort((a, b) => a.at - b.at);
}

/**
 * The digest that is due now: the latest moment that has passed and came
 * after the person's last digest. Several missed moments (the server was
 * down) give ONE digest, for the latest. null = nothing due.
 */
export function dueDigestSlot({ slots = [], lastDigestAt = null, now = new Date() } = {}) {
  const last = lastDigestAt ? new Date(lastDigestAt).getTime() : null;
  const due = slots.filter((s) => !s.stale && s.at.getTime() <= now.getTime() && (last === null || last < s.at.getTime()));
  return due.length ? due[due.length - 1] : null;
}

/**
 * The earlier digest of the due slot's day (in the due slot's zone) that a
 * later one follows, or null when there was none that day.
 */
export function previousDigestSlot({ slots = [], lastDigestAt = null, due = null } = {}) {
  if (!lastDigestAt || !due) return null;
  const last = new Date(lastDigestAt);
  if (localDate(last, due.tz) !== due.date) return null;
  const before = slots.filter((s) => s.at.getTime() <= last.getTime() && localDate(s.at, due.tz) === due.date);
  return before.length ? before[before.length - 1] : null;
}

/**
 * What the runner does now. One call, so the rules live in one place:
 *  - nothing due → null
 *  - the daily (first) slot when a digest already went out that day with no
 *    earlier slot behind it (the person moved their time after it was sent)
 *    → { skip: 'already_today' }: never a second full digest on one day
 *  - a later slot after an earlier digest that day → since mode, labelled by
 *    the earlier slot ("Since your 9:00 AM PT digest"), or by the time the
 *    earlier digest went out when no slot matches it
 *  - otherwise the full digest
 * @returns {null | { due, skip?: string, sinceLabel: string|null }}
 */
export function planDigest({ slots = [], lastDigestAt = null, now = new Date() } = {}) {
  const due = dueDigestSlot({ slots, lastDigestAt, now });
  if (!due) return null;
  const sameDay = Boolean(lastDigestAt) && localDate(new Date(lastDigestAt), due.tz) === due.date;
  const previous = previousDigestSlot({ slots, lastDigestAt, due });
  if (sameDay && !previous) {
    if (due.first) return { due, skip: 'already_today', sinceLabel: null };
    const at = formatInTimeZone(new Date(lastDigestAt), due.tz, 'HH:mm');
    return { due, sinceLabel: `Since your ${timeLabel(at, due.tz)} digest` };
  }
  return { due, sinceLabel: previous ? `Since your ${previous.label} digest` : null };
}

/** The extra times a person switched on that the workspace still offers. */
export function optedExtraTimes(workspaceTimes = [], personTimes = []) {
  const offered = new Set((workspaceTimes || []).slice(1));
  return cleanTimes(personTimes).filter((t) => offered.has(t));
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * "3 new unassigned tickets · 2 tickets assigned to you · 1 other update".
 * held: the notices held for the digest since the earlier one ({ eventKey }).
 */
export function sinceSummary({ held = [], newCount = 0 } = {}) {
  const unassigned = held.filter((h) => h.eventKey === 'group_unassigned').length;
  const surveys = held.filter((h) => h.eventKey === 'survey_result' || h.eventKey === 'survey_response').length;
  const other = held.length - unassigned - surveys;
  const parts = [];
  if (unassigned) parts.push(plural(unassigned, 'new unassigned ticket', 'new unassigned tickets'));
  if (newCount) parts.push(plural(newCount, 'ticket assigned to you', 'tickets assigned to you'));
  if (surveys) parts.push(plural(surveys, 'survey result', 'survey results'));
  if (other) parts.push(plural(other, 'other update', 'other updates'));
  return parts.length ? parts.join(' · ') : 'nothing new';
}

export default {
  PACIFIC, MAX_DIGEST_TIMES, cleanTimes, workspaceDigestTimes, timeLabel, localDate, zonedInstant, digestSlotsFor, dueDigestSlot, previousDigestSlot, planDigest, optedExtraTimes, sinceSummary,
};
