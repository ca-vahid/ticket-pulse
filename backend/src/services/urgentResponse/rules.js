import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

/**
 * Urgent response — the rules (plans/URGENT_RESPONSE_PLAN.md).
 *
 * Pure functions only: no database, no clock, no logger. Every function that
 * needs "now" takes it as an argument (`at` / `now` / `from`), so the engine,
 * the preview replay and the tests all run the same code against any moment.
 *
 * Time zones are always IANA names passed in by the caller (the technician's
 * own zone for shifts, the workspace zone for the on-call week). Nothing here
 * knows an offset: British Columbia stopped changing its clocks in 2026, the
 * US Pacific states did not, and both must keep working from the zone data.
 */

export const URGENT_RESPONSE_MODES = Object.freeze(['off', 'observe', 'live']);
export const RAISE_MANUAL_ACTIONS = Object.freeze(['notify', 'move']);
export const NOTIFY_AUDIENCES = Object.freeze(['on_shift', 'group', 'named']);
export const NOTIFY_CHANNELS = Object.freeze(['teams', 'email']);
export const NOBODY_MODES = Object.freeze(['hold', 'on_call']);
export const SCOPE_PRIORITIES = Object.freeze([3, 4]);
export const PRIORITY_LABELS = Object.freeze({ 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' });
export const LAYERS = Object.freeze(['assign', 'raise', 'clock', 'on_call', 'undo']);
export const ACTIONS = Object.freeze([
  'redirected', 'held', 'moved', 'told_owner_away', 'team_told', 'coordinator', 'on_call_assigned',
  'undone', 'cover_needed', 'cover_requested', 'cover_set', 'failed',
]);
/** Live rows of these actions can be undone while the ticket is still with the "to" person. */
export const UNDOABLE_ACTIONS = Object.freeze(['moved', 'redirected', 'on_call_assigned', 'coordinator']);

export const DEFAULT_SHIFT_START = '09:00';
export const DEFAULT_SHIFT_END = '17:00';
const FALLBACK_TIMEZONE = 'America/Los_Angeles';
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MAX_MINUTES = 480;
const MAX_MOVES = 10;
const MAX_PEOPLE = 50;
/** How far ahead atWork() looks for "starts at …". */
const NEXT_START_DAYS = 14;
/**
 * With no anchor date saved, weeks are counted from this Sunday so the
 * rotation is still stable from one call to the next. settingsService stores a
 * real anchor the first time an order is saved.
 */
const EPOCH_ANCHOR = '2026-01-04';

const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

// ---------------------------------------------------------------------------
// Small date helpers (calendar dates are 'yyyy-MM-dd' strings, never Date).

const pad = (n) => String(n).padStart(2, '0');

export function safeZone(timezone) {
  const tz = String(timezone || '').trim();
  if (!tz) return FALLBACK_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return FALLBACK_TIMEZONE;
  }
}

export function addDaysStr(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const dayOfWeekOf = (dateStr) => new Date(`${dateStr}T00:00:00Z`).getUTCDay(); // 0 = Sunday
const daysBetween = (fromStr, toStr) => Math.round((Date.parse(`${toStr}T00:00:00Z`) - Date.parse(`${fromStr}T00:00:00Z`)) / DAY_MS);

/** 'HH:mm' → minutes from midnight, or null when it is not a time. */
export function timeToMinutes(value) {
  const s = String(value ?? '').trim();
  if (!TIME_RE.test(s)) return null;
  return Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
}

export const minutesToTime = (minutes) => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;

/** A DATE column, a Date or a string → 'yyyy-MM-dd' (DATE columns read back as UTC midnight). */
export function toDateStr(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const s = String(value).slice(0, 10);
  return DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? s : null;
}

/** The local calendar date, weekday and minutes-from-midnight of an instant in a zone. */
export function localParts(at, timezone) {
  const [dateStr, hh, mm] = formatInTimeZone(at, safeZone(timezone), 'yyyy-MM-dd HH mm').split(' ');
  return { dateStr, dayOfWeek: dayOfWeekOf(dateStr), minutes: Number(hh) * 60 + Number(mm) };
}

/** A local date + minutes-from-midnight in a zone → the instant (1440 = the next midnight). */
function zonedMinutes(dateStr, minutes, timezone) {
  const day = minutes >= 1440 ? addDaysStr(dateStr, 1) : dateStr;
  return fromZonedTime(`${day}T${minutesToTime(minutes % 1440)}:00`, safeZone(timezone));
}

const firstName = (name) => String(name || '').trim().split(' ')[0] || 'They';
const person = (name, fallback = 'someone') => String(name || '').trim() || fallback;

// ---------------------------------------------------------------------------
// At work

const defaultIsBusinessDay = (_dateStr, dayOfWeek) => dayOfWeek >= 1 && dayOfWeek <= 5;

function shiftOf(tech) {
  const start = timeToMinutes(tech?.workStartTime) ?? timeToMinutes(DEFAULT_SHIFT_START);
  const end = timeToMinutes(tech?.workEndTime) ?? timeToMinutes(DEFAULT_SHIFT_END);
  // The same start and end is not a shift: fall back to the default day.
  if (start === end) return { start: timeToMinutes(DEFAULT_SHIFT_START), end: timeToMinutes(DEFAULT_SHIFT_END), overnight: false };
  return { start, end, overnight: end < start };
}

/** Leave rows that take the person away (approved, not WFH, not ignored), with a plain date. */
function awayLeaves(leaves) {
  return (Array.isArray(leaves) ? leaves : [])
    .filter((l) => l && !['WFH', 'IGNORED'].includes(String(l.category || '').toUpperCase()))
    .filter((l) => !l.status || String(l.status).toUpperCase() === 'APPROVED')
    .map((l) => ({ ...l, dateStr: toDateStr(l.date ?? l.leaveDate) }))
    .filter((l) => l.dateStr);
}

/** The window of a part-day leave as minutes from midnight (no window recorded = the whole day). */
function halfDayWindow(leave) {
  const start = Number.isInteger(leave.startMinute) ? leave.startMinute : null;
  const end = Number.isInteger(leave.endMinute) ? leave.endMinute : null;
  if (start !== null && end !== null && end > start) return { start, end };
  if (leave.halfDayPart === 'AM') return { start: 0, end: 720 };
  if (leave.halfDayPart === 'PM') return { start: 720, end: 1440 };
  return { start: 0, end: 1440 };
}

/** Is the person working at this instant (no grace)? */
function workingAt(tech, at, away, isBusinessDay, leaveTimezone) {
  const tz = safeZone(tech?.timezone);
  const { dateStr, minutes } = localParts(at, tz);
  const { start, end, overnight } = shiftOf(tech);
  let inShift;
  let shiftDate = dateStr;
  let outside = 'after_shift';
  if (overnight) {
    // 22:00–06:00: the small hours belong to the shift that started the evening before.
    if (minutes >= start) inShift = true;
    else if (minutes < end) { inShift = true; shiftDate = addDaysStr(dateStr, -1); }
    else { inShift = false; outside = 'before_shift'; }
  } else {
    inShift = minutes >= start && minutes < end;
    if (minutes < start) outside = 'before_shift';
  }
  if (away.some((l) => l.isFullDay !== false && l.dateStr === shiftDate)) return { working: false, reason: 'on_leave' };
  if (!isBusinessDay(shiftDate, dayOfWeekOf(shiftDate))) return { working: false, reason: 'not_business_day' };
  if (!inShift) return { working: false, reason: outside };
  const t = at.getTime();
  const partDay = away.some((l) => {
    if (l.isFullDay !== false) return false;
    const w = halfDayWindow(l);
    return t >= zonedMinutes(l.dateStr, w.start, leaveTimezone || tz).getTime() && t < zonedMinutes(l.dateStr, w.end, leaveTimezone || tz).getTime();
  });
  if (partDay) return { working: false, reason: 'half_day_leave' };
  return { working: true, reason: 'at_work' };
}

/**
 * Is this technician at work at `at`?
 *
 * Shift = workStartTime–workEndTime (default 09:00–17:00) in the technician's
 * own time zone, overnight shifts included; the day the shift starts on must be
 * a business day (`isBusinessDay(localDateStr, dayOfWeek)`, default Mon–Fri)
 * and not a full day of leave. A part-day leave takes them away inside its
 * window only. `graceMinutes` counts "starts within N minutes" as at work.
 *
 * `leaves`: rows of technician_leaves for this person (`leaveDate` or `date`,
 * category, isFullDay, startMinute, endMinute, halfDayPart). WFH and IGNORED
 * are not leave. Part-day windows are minutes in `leaveTimezone` (the
 * workspace zone they were recorded in; default the technician's own).
 *
 * @returns {{ atWork: boolean, reason: string, startsInMinutes: number|null, nextStartAt: Date|null, nextStartLocal: string|null }}
 *   reason: at_work | starts_soon | on_leave | half_day_leave | not_business_day | before_shift | after_shift.
 *   startsInMinutes / nextStartAt / nextStartLocal ('HH:mm' in their zone): when
 *   they are next at work (null when at work now, or nothing in the next 14 days).
 */
export function atWork(tech, at, { leaves = [], isBusinessDay = defaultIsBusinessDay, graceMinutes = 0, leaveTimezone = null } = {}) {
  const tz = safeZone(tech?.timezone);
  const away = awayLeaves(leaves);
  const now = workingAt(tech, at, away, isBusinessDay, leaveTimezone);
  if (now.working) return { atWork: true, reason: 'at_work', startsInMinutes: null, nextStartAt: null, nextStartLocal: null };

  // The next moment they are at work: a shift start, or the end of a part-day leave.
  const { start } = shiftOf(tech);
  const today = localParts(at, tz).dateStr;
  const candidates = [];
  for (let d = -1; d <= NEXT_START_DAYS; d++) candidates.push(zonedMinutes(addDaysStr(today, d), start, tz));
  for (const l of away) {
    if (l.isFullDay === false) candidates.push(zonedMinutes(l.dateStr, halfDayWindow(l).end, leaveTimezone || tz));
  }
  const next = candidates
    .filter((c) => c.getTime() > at.getTime())
    .sort((a, b) => a - b)
    .find((c) => workingAt(tech, c, away, isBusinessDay, leaveTimezone).working) || null;
  const startsInMinutes = next ? Math.ceil((next.getTime() - at.getTime()) / MINUTE_MS) : null;
  const out = {
    atWork: false,
    reason: now.reason,
    startsInMinutes,
    nextStartAt: next,
    nextStartLocal: next ? formatInTimeZone(next, tz, 'HH:mm') : null,
  };
  const grace = Math.max(0, Number(graceMinutes) || 0);
  if (grace > 0 && startsInMinutes !== null && startsInMinutes <= grace) return { ...out, atWork: true, reason: 'starts_soon' };
  return out;
}

/** "David starts at 09:00" / "David is on leave" — the half-sentence about why the owner is away. */
export function awayPhrase(name, state) {
  const who = firstName(name);
  if (!state || state.atWork) return `${who} is at work`;
  if (state.reason === 'on_leave') return `${who} is on leave`;
  if (state.reason === 'half_day_leave') return state.nextStartLocal ? `${who} is on leave until ${state.nextStartLocal}` : `${who} is on leave`;
  if (state.nextStartLocal) return `${who} starts at ${state.nextStartLocal}`;
  return `${who} is not at work`;
}

// ---------------------------------------------------------------------------
// Picking the next owner

const SKILL_RANK = { exact: 0, category: 1, none: 2 };
const skillRank = (c) => SKILL_RANK[c?.skill] ?? 2;
const openCount = (c) => (Number.isFinite(Number(c?.openTickets)) ? Number(c.openTickets) : 0);
// Never given a ticket sorts first: they are the least recently given one.
const lastGiven = (c) => {
  const t = c?.lastAssignedAt ? new Date(c.lastAssignedAt).getTime() : NaN;
  return Number.isNaN(t) ? -Infinity : t;
};

function compareResponders(a, b) {
  if (Boolean(a.atWork) !== Boolean(b.atWork)) return a.atWork ? -1 : 1;
  if (skillRank(a) !== skillRank(b)) return skillRank(a) - skillRank(b);
  if (openCount(a) !== openCount(b)) return openCount(a) - openCount(b);
  if (lastGiven(a) !== lastGiven(b)) return lastGiven(a) < lastGiven(b) ? -1 : 1;
  return Number(a.id) - Number(b.id);
}

/**
 * The fixed order: (1) at work, (2) has the skill — subcategory match, then
 * category match, then none, (3) fewest open tickets, (4) least recently given
 * a ticket (then id, so the order never depends on input order).
 *
 * Candidate: `{ id, name, atWork, awayReason, skill: 'exact'|'category'|'none', openTickets, lastAssignedAt }`.
 * Returns a new list, best first, each with `rank` (1-based) and a plain `why`.
 * People who are not at work stay in the list (at the end) so the log can show
 * who was considered; the caller picks from the ones with `atWork`.
 */
export function rankResponders(candidates) {
  const sorted = [...(Array.isArray(candidates) ? candidates : [])].sort(compareResponders);
  const working = sorted.filter((c) => c.atWork);
  return sorted.map((c, i) => {
    if (!c.atWork) return { ...c, rank: i + 1, why: `not at work${c.awayReason ? ` (${c.awayReason})` : ''}` };
    const parts = ['at work'];
    if (c.skill === 'exact') parts.push('has the skill');
    else if (c.skill === 'category') parts.push('has a skill in the category');
    // What separated them from the others who are at work with the same skill.
    const peers = working.filter((p) => p !== c && skillRank(p) === skillRank(c));
    if (peers.length) {
      const fewest = peers.every((p) => openCount(c) <= openCount(p));
      const tied = peers.filter((p) => openCount(p) === openCount(c));
      if (fewest && !tied.length) parts.push('fewest open tickets');
      else if (fewest && tied.every((p) => lastGiven(c) < lastGiven(p))) parts.push('fewest open tickets', 'least recently given a ticket');
      else if (fewest) parts.push('fewest open tickets');
      else parts.push(`${openCount(c)} open ticket${openCount(c) === 1 ? '' : 's'}`);
    }
    return { ...c, rank: i + 1, why: parts.join(', ') };
  });
}

/** "Andrew is at work and has the Network skill" — the closing half of a move sentence. */
export function responderPhrase(name, { skill = 'none', skillName = null } = {}) {
  const who = firstName(name);
  if (skill === 'none') return `${who} is at work`;
  return `${who} is at work and has ${skillName ? `the ${skillName} skill` : 'the skill'}`;
}

// ---------------------------------------------------------------------------
// On-call weeks

/** The instant of a handover: a local date and 'HH:mm' in the workspace zone. */
export function handoverInstant(dateStr, time, timezone) {
  const minutes = timeToMinutes(time) ?? timeToMinutes(DEFAULT_SETTINGS.onCallHandoverTime);
  return zonedMinutes(toDateStr(dateStr), minutes, timezone);
}

const handoverDayOf = (settings) => {
  const d = Number(settings?.onCallHandoverDay);
  return Number.isInteger(d) && d >= 0 && d <= 6 ? d : DEFAULT_SETTINGS.onCallHandoverDay;
};

/** The anchor as a date that falls on the handover weekday (moved forward to it when it does not). */
export function alignedAnchorDate(settings) {
  const anchor = toDateStr(settings?.onCallAnchorDate) || EPOCH_ANCHOR;
  return addDaysStr(anchor, (handoverDayOf(settings) - dayOfWeekOf(anchor) + 7) % 7);
}

/** The handover date on or before a local date — what settingsService saves as the first anchor. */
export function anchorDateFor(handoverDay, time, timezone, at) {
  const settings = { onCallHandoverDay: handoverDay, onCallHandoverTime: time, onCallAnchorDate: null };
  const { dateStr } = localParts(at, timezone);
  let date = addDaysStr(dateStr, -((dayOfWeekOf(dateStr) - handoverDayOf(settings) + 7) % 7));
  if (handoverInstant(date, time, timezone).getTime() > at.getTime()) date = addDaysStr(date, -7);
  return date;
}

const orderOf = (settings) => (Array.isArray(settings?.onCallOrder) ? settings.onCallOrder : []);

/** Week number `index` of the rotation (0 = the anchor week; negative = before it). */
export function onCallWeekByIndex(settings, timezone, index) {
  const anchor = alignedAnchorDate(settings);
  const order = orderOf(settings);
  const time = settings?.onCallHandoverTime;
  return {
    index,
    startsAt: handoverInstant(addDaysStr(anchor, index * 7), time, timezone),
    endsAt: handoverInstant(addDaysStr(anchor, (index + 1) * 7), time, timezone),
    technicianId: order.length ? order[((index % order.length) + order.length) % order.length] : null,
  };
}

/**
 * The on-call week that contains `at`: handover to handover on calendar weeks
 * in the workspace zone, so a week is 167 or 169 hours long when the clocks
 * change inside it and the handover stays at the same wall-clock time.
 * @returns {{ index: number, startsAt: Date, endsAt: Date, technicianId: number|null }}
 */
export function onCallWeek(settings, timezone, at) {
  const anchor = alignedAnchorDate(settings);
  let index = Math.floor(daysBetween(anchor, localParts(at, timezone).dateStr) / 7);
  let week = onCallWeekByIndex(settings, timezone, index);
  // The handover day itself belongs to the week before until the handover time.
  while (at.getTime() < week.startsAt.getTime()) week = onCallWeekByIndex(settings, timezone, --index);
  while (at.getTime() >= week.endsAt.getTime()) week = onCallWeekByIndex(settings, timezone, ++index);
  return week;
}

/** `count` weeks, the first one being the week that contains `from`. */
export function upcomingWeeks(settings, timezone, from, count = 8) {
  const first = onCallWeek(settings, timezone, from);
  const n = Math.min(Math.max(Number(count) || 0, 0), 104);
  return Array.from({ length: n }, (_, i) => (i === 0 ? first : onCallWeekByIndex(settings, timezone, first.index + i)));
}

const time = (v) => new Date(v).getTime();
const activeCovers = (covers) => (Array.isArray(covers) ? covers : []).filter((c) => c && !c.cancelledAt);

/** The covers that overlap a window, oldest start first. */
export function coversInWindow(covers, startsAt, endsAt) {
  return activeCovers(covers)
    .filter((c) => time(c.startsAt) < time(endsAt) && time(c.endsAt) > time(startsAt))
    .sort((a, b) => time(a.startsAt) - time(b.startsAt) || Number(a.id) - Number(b.id));
}

/**
 * Who holds on-call at `at`: the cover in force (the one created last when two
 * overlap), otherwise the scheduled person of the week.
 * @returns {{ technicianId: number|null, scheduledTechnicianId: number|null, cover: object|null }}
 */
export function resolveOnCall(week, covers, at) {
  const t = at.getTime();
  const scheduledTechnicianId = week?.technicianId ?? null;
  const cover = activeCovers(covers)
    .filter((c) => time(c.startsAt) <= t && t < time(c.endsAt))
    .sort((a, b) => Number(b.id) - Number(a.id))[0] || null;
  return { technicianId: cover ? cover.coverTechnicianId : scheduledTechnicianId, scheduledTechnicianId, cover };
}

/** Until when the person who holds on-call at `at` keeps it (a cover starting or ending, or the handover). */
export function onCallUntil(week, covers, at) {
  const t = at.getTime();
  const { cover } = resolveOnCall(week, covers, at);
  const edges = [time(week.endsAt)];
  if (cover) edges.push(time(cover.endsAt));
  for (const c of activeCovers(covers)) if (time(c.startsAt) > t && c !== cover) edges.push(time(c.startsAt));
  return new Date(Math.min(...edges.filter((e) => e > t)));
}

/**
 * The local dates (workspace zone) inside a window on which the person has a
 * full day of leave. Part-day leave does not count: somebody off for the
 * morning still holds the phone that evening.
 */
export function leaveDaysInWindow(leaves, startsAt, endsAt, timezone) {
  const days = new Set();
  for (const l of awayLeaves(leaves)) {
    if (l.isFullDay === false) continue;
    const dayStart = zonedMinutes(l.dateStr, 0, timezone).getTime();
    const dayEnd = zonedMinutes(l.dateStr, 1440, timezone).getTime();
    if (dayStart < time(endsAt) && dayEnd > time(startsAt)) days.add(l.dateStr);
  }
  return [...days].sort();
}

/** The leave days of a window that no cover (or run of covers) spans completely. */
export function uncoveredLeaveDays(leaveDays, covers, startsAt, endsAt, timezone) {
  const spans = coversInWindow(covers, startsAt, endsAt).map((c) => [time(c.startsAt), time(c.endsAt)]);
  return (Array.isArray(leaveDays) ? leaveDays : []).filter((day) => {
    const from = Math.max(zonedMinutes(day, 0, timezone).getTime(), time(startsAt));
    const to = Math.min(zonedMinutes(day, 1440, timezone).getTime(), time(endsAt));
    let reached = from;
    for (const [s, e] of spans) {
      if (s > reached) break;
      if (e > reached) reached = e;
    }
    return reached < to;
  });
}

// ---------------------------------------------------------------------------
// The sentence

const minutesText = (n) => `${n} minute${Number(n) === 1 ? '' : 's'}`;
const movesText = (n) => `${n} move${Number(n) === 1 ? '' : 's'}`;
const priorityWord = (ctx) => PRIORITY_LABELS[Number(ctx?.priority)] || 'Urgent';
const endStop = (s) => {
  const text = String(s || '').trim();
  if (!text) return '';
  return '.!?'.includes(text[text.length - 1]) ? text : `${text}.`;
};
const join = (...parts) => parts.map(endStop).filter(Boolean).join(' ');

/** '2026-10-15' → 'Thu 15 Oct' (a calendar date, no zone involved). Anything else is returned as given. */
function dayWord(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!m) return String(value || '');
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`;
}

/** ['a', 'b', 'c'] → 'a, b and c'. */
function listWords(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The one plain-English sentence for the ticket activity, the log row and the
 * notices. `ctx` (every field optional):
 *   shadow        true → "Shadow: would have …"
 *   layer         'assign' | 'raise' | 'clock' — picks the wording of `moved` / `held`
 *   priority      1–4 (the word used: Urgent / High)
 *   from, to      names
 *   reason        why the owner is away, e.g. "David starts at 09:00" (awayPhrase)
 *   becameAt      'HH:mm' the ticket entered scope
 *   toWhy         e.g. "Andrew is at work and has the Network skill" (responderPhrase)
 *   why           e.g. "at work, fewest open tickets" (rankResponders().why)
 *   minutes       business minutes untouched
 *   moves         moves already made (coordinator)
 *   contact       the person told when nobody is at work
 *   texted        on-call: the SMS went out
 *   actor         who pressed Undo
 *   days, range, asked, error
 */
export function sentenceFor(action, ctx = {}) {
  const from = person(ctx.from, 'the owner');
  const to = person(ctx.to);
  const word = priorityWord(ctx);
  const untouched = ctx.minutes !== undefined && ctx.minutes !== null ? `${word} and untouched for ${minutesText(ctx.minutes)}` : `${word} and untouched`;
  const shadow = ctx.shadow === true;

  switch (action) {
  case 'redirected': {
    const tail = ctx.reason ? `: ${ctx.reason}` : '';
    return shadow
      ? endStop(`Shadow: would have assigned to ${to} instead of ${from} by the Urgent rule${tail}`)
      : endStop(`Assigned to ${to} instead of ${from} by the Urgent rule${tail}`);
  }
  case 'moved': {
    if (ctx.layer === 'clock') {
      const tail = ctx.why ? `: ${ctx.why}` : '';
      return shadow
        ? join(`Shadow: would have moved from ${from} to ${to}${tail}`, untouched)
        : join(untouched, `Moved from ${from} to ${to}${tail}`);
    }
    const became = ctx.becameAt ? `Became ${word} at ${ctx.becameAt}` : '';
    const middle = became && ctx.reason ? `${became}; ${ctx.reason}` : (became || ctx.reason || '');
    return join(`${shadow ? 'Shadow: would have moved' : 'Moved'} from ${from} to ${to} by the Urgent rule`, middle, ctx.toWhy);
  }
  case 'team_told':
    return shadow
      ? join('Shadow: would have told the people at work', untouched)
      : join(untouched, 'The people at work were told');
  case 'told_owner_away': {
    const stays = `${from} is away and this ticket was assigned by hand, so it stays with them`;
    return shadow
      ? join('Shadow: would have told the people at work', stays)
      : join(stays, 'The people at work were told');
  }
  case 'held': {
    if (ctx.layer === 'assign') {
      return shadow
        ? join(`Shadow: would have left it for review instead of assigning it to ${from}`, 'Nobody is at work')
        : join('Nobody is at work', `Left for review instead of assigning it to ${from}`);
    }
    // `nobodyTold`: no contact and no coordinator is set, and the sentence says so.
    const untold = !ctx.contact && ctx.nobodyTold === true;
    if (shadow) return join(`Shadow: would have left it with ${from}${ctx.contact ? ` and told ${ctx.contact}` : ''}`, 'Nobody is at work', untold ? 'Nobody would have been told: no contact is set' : '');
    return join('Nobody is at work', `Left with ${from}${ctx.contact ? `; ${ctx.contact} was told` : ''}`, untold ? 'Nobody was told: no contact is set' : '');
  }
  case 'on_call_assigned':
    if (shadow) return join(`Shadow: would have assigned to the on-call person, ${to}, and texted them`, 'Nobody is at work');
    return join('Nobody is at work', `Assigned to the on-call person, ${to}, ${ctx.texted === false ? 'who has no verified phone to text' : 'who was texted'}`);
  case 'coordinator': {
    const after = ctx.moves !== undefined && ctx.moves !== null ? `${word} and still untouched after ${movesText(ctx.moves)}` : `${word} and still untouched`;
    // `alreadyOwner`: the coordinator is the person who has it.
    if (ctx.alreadyOwner) {
      return shadow
        ? join(`Shadow: would have told the coordinator, ${from}, who already has it`, after)
        : join(after, `It is already with the coordinator, ${from}, who was told`);
    }
    if (!ctx.to) return shadow ? join(`Shadow: would have left it with ${from}: no coordinator is set`, after) : join(after, `No coordinator is set, so it stays with ${from}`);
    return shadow
      ? join(`Shadow: would have assigned to the coordinator, ${to}`, after)
      : join(after, `Assigned to the coordinator, ${to}, who was told`);
  }
  case 'undone':
    return endStop(`Moved back to ${to} by ${person(ctx.actor)} (undo)`);
  case 'cover_needed': {
    const days = Array.isArray(ctx.days) && ctx.days.length ? ` on ${listWords(ctx.days.map(dayWord))}` : '';
    return join(`${from} is on call${ctx.range ? ` ${ctx.range}` : ''} and has leave${days}`, 'The week needs cover');
  }
  case 'cover_requested': {
    const n = Number(ctx.asked) || 0;
    return endStop(`Cover asked for ${from}, on call${ctx.range ? ` ${ctx.range}` : ''}: ${n} ${n === 1 ? 'person' : 'people'} asked`);
  }
  case 'cover_set':
    return endStop(`${to} covers on call for ${from}${ctx.range ? `, ${ctx.range}` : ''}`);
  case 'failed':
    return endStop(`Could not move this ticket${ctx.from ? ` from ${from}` : ''}${ctx.to ? ` to ${to}` : ''}${ctx.error ? `: ${ctx.error}` : ''}`);
  default:
    return endStop(`Urgent rule: ${String(action || 'unknown').replace(/_/g, ' ')}`);
  }
}

/** "12–19 Oct" / "28 Oct – 4 Nov" for notices, in the workspace zone. */
export function rangeLabel(startsAt, endsAt, timezone) {
  const tz = safeZone(timezone);
  const a = new Date(startsAt);
  const b = new Date(endsAt);
  if (formatInTimeZone(a, tz, 'yyyy-MM') === formatInTimeZone(b, tz, 'yyyy-MM')) {
    return `${formatInTimeZone(a, tz, 'd')}–${formatInTimeZone(b, tz, 'd MMM')}`;
  }
  return `${formatInTimeZone(a, tz, 'd MMM')} – ${formatInTimeZone(b, tz, 'd MMM')}`;
}

// ---------------------------------------------------------------------------
// Settings: defaults, normalising, validation, row mapping

export const DEFAULT_SETTINGS = Object.freeze({
  mode: 'off',
  assignEnabled: true,
  assignPriorities: Object.freeze([4, 3]),
  assignGraceMinutes: 30,
  raiseEnabled: true,
  raisePriorities: Object.freeze([4]),
  raiseManualAction: 'notify',
  clockEnabled: true,
  clockPriorities: Object.freeze([4]),
  clockNotifyMinutes: 15,
  clockMoveMinutes: 30,
  notifyAudience: 'on_shift',
  notifyTechnicianIds: Object.freeze([]),
  notifyChannels: Object.freeze(['teams', 'email']),
  nobodyMode: 'hold',
  nobodyContactTechnicianId: null,
  coordinatorTechnicianId: null,
  maxMoves: 2,
  onCallOrder: Object.freeze([]),
  onCallHandoverDay: 1,
  onCallHandoverTime: '17:00',
  onCallAnchorDate: null,
});

/** The writable settings, in the order they are shown and audited. */
export const SETTINGS_FIELDS = Object.freeze(Object.keys(DEFAULT_SETTINGS));
/** The settings that name technicians (checked against the workspace on save). */
export const PEOPLE_FIELDS = Object.freeze(['notifyTechnicianIds', 'nobodyContactTechnicianId', 'coordinatorTechnicianId', 'onCallOrder']);

const has = (o, k) => o !== null && o !== undefined && o[k] !== undefined;
const toBool = (v) => v === true || v === 'true' || v === 1;
const toNumber = (v) => (v === null || v === '' || typeof v === 'boolean' ? NaN : Number(v));
const uniq = (list) => [...new Set(list)];
const numberList = (v) => uniq((Array.isArray(v) ? v : []).map(toNumber));
// Priorities are a set: highest first, so [3, 4] and [4, 3] are the same value.
const priorityList = (v) => numberList(v).sort((a, b) => b - a);
const idOrNull = (v) => (v === null || v === undefined || v === '' ? null : toNumber(v));
const text = (v) => String(v ?? '').trim();

/**
 * A full settings object from any partial input: missing fields take the
 * default, types are coerced (numbers, lists without repeats, trimmed strings).
 * Nothing is clamped or corrected — validateSettings() says what is wrong.
 */
export function normalizeSettings(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const d = DEFAULT_SETTINGS;
  const pick = (k, fn) => (has(src, k) ? fn(src[k]) : (Array.isArray(d[k]) ? [...d[k]] : d[k]));
  return {
    mode: pick('mode', text),
    assignEnabled: pick('assignEnabled', toBool),
    assignPriorities: pick('assignPriorities', priorityList),
    assignGraceMinutes: pick('assignGraceMinutes', toNumber),
    raiseEnabled: pick('raiseEnabled', toBool),
    raisePriorities: pick('raisePriorities', priorityList),
    raiseManualAction: pick('raiseManualAction', text),
    clockEnabled: pick('clockEnabled', toBool),
    clockPriorities: pick('clockPriorities', priorityList),
    clockNotifyMinutes: pick('clockNotifyMinutes', toNumber),
    clockMoveMinutes: pick('clockMoveMinutes', toNumber),
    notifyAudience: pick('notifyAudience', text),
    notifyTechnicianIds: pick('notifyTechnicianIds', numberList),
    notifyChannels: pick('notifyChannels', (v) => uniq((Array.isArray(v) ? v : []).map((c) => text(c).toLowerCase()))),
    nobodyMode: pick('nobodyMode', text),
    nobodyContactTechnicianId: pick('nobodyContactTechnicianId', idOrNull),
    coordinatorTechnicianId: pick('coordinatorTechnicianId', idOrNull),
    maxMoves: pick('maxMoves', toNumber),
    onCallOrder: pick('onCallOrder', numberList),
    onCallHandoverDay: pick('onCallHandoverDay', toNumber),
    onCallHandoverTime: pick('onCallHandoverTime', text),
    // An unreadable date is kept as typed so validation can refuse it.
    onCallAnchorDate: pick('onCallAnchorDate', (v) => (v === null || v === '' ? null : (toDateStr(v) ?? String(v)))),
  };
}

const isId = (n) => Number.isInteger(n) && n > 0;
const whole = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;

/**
 * What is wrong with a (normalised) settings object, in plain words.
 * @returns {string[]} empty when the settings can be saved.
 */
export function validateSettings(s) {
  const errors = [];
  const layer = (label, enabled, priorities) => {
    if (!Array.isArray(priorities) || priorities.some((p) => !SCOPE_PRIORITIES.includes(p))) errors.push(`${label}: priorities can only be Urgent or High`);
    else if (enabled && !priorities.length) errors.push(`${label}: pick at least one priority, or switch the layer off`);
  };
  if (!URGENT_RESPONSE_MODES.includes(s.mode)) errors.push(`Mode must be one of: ${URGENT_RESPONSE_MODES.join(', ')}`);
  layer('When assigning', s.assignEnabled, s.assignPriorities);
  layer('When it becomes urgent', s.raiseEnabled, s.raisePriorities);
  layer('If nobody touches it', s.clockEnabled, s.clockPriorities);
  if (!whole(s.assignGraceMinutes, 0, MAX_MINUTES)) errors.push(`Grace must be a whole number of minutes between 0 and ${MAX_MINUTES}`);
  if (!RAISE_MANUAL_ACTIONS.includes(s.raiseManualAction)) errors.push('Hand-assigned tickets: choose "tell only" or "move"');
  const notifyOk = whole(s.clockNotifyMinutes, 1, MAX_MINUTES);
  const moveOk = whole(s.clockMoveMinutes, 1, MAX_MINUTES);
  if (!notifyOk) errors.push(`"Tell the team after" must be a whole number of minutes between 1 and ${MAX_MINUTES}`);
  if (!moveOk) errors.push(`"Move after" must be a whole number of minutes between 1 and ${MAX_MINUTES}`);
  if (notifyOk && moveOk && s.clockMoveMinutes < s.clockNotifyMinutes) errors.push('"Move after" cannot be shorter than "Tell the team after"');
  if (!NOTIFY_AUDIENCES.includes(s.notifyAudience)) errors.push('Who is told: choose the people at work, the group, or named people');
  if (!Array.isArray(s.notifyTechnicianIds) || s.notifyTechnicianIds.some((id) => !isId(id))) errors.push('Who is told: the named people are not valid');
  else if (s.notifyTechnicianIds.length > MAX_PEOPLE) errors.push(`Who is told: at most ${MAX_PEOPLE} named people`);
  else if (s.notifyAudience === 'named' && !s.notifyTechnicianIds.length) errors.push('Who is told: name at least one person');
  if (!Array.isArray(s.notifyChannels) || s.notifyChannels.some((c) => !NOTIFY_CHANNELS.includes(c))) errors.push('Channels can only be Teams and e-mail');
  if (!NOBODY_MODES.includes(s.nobodyMode)) errors.push('Nobody at work: choose "hold" or "on-call"');
  if (s.nobodyContactTechnicianId !== null && !isId(s.nobodyContactTechnicianId)) errors.push('Nobody at work: the contact is not valid');
  if (s.coordinatorTechnicianId !== null && !isId(s.coordinatorTechnicianId)) errors.push('The coordinator is not valid');
  if (!whole(s.maxMoves, 0, MAX_MOVES)) errors.push(`The number of moves must be between 0 and ${MAX_MOVES}`);
  const orderOk = Array.isArray(s.onCallOrder) && !s.onCallOrder.some((id) => !isId(id));
  if (!orderOk) errors.push('The on-call order is not valid');
  else if (s.onCallOrder.length > MAX_PEOPLE) errors.push(`The on-call order can hold at most ${MAX_PEOPLE} people`);
  else if (s.nobodyMode === 'on_call' && !s.onCallOrder.length) errors.push('Nobody at work: set the on-call order before choosing on-call');
  if (!whole(s.onCallHandoverDay, 0, 6)) errors.push('The handover day must be a day of the week (0 = Sunday … 6 = Saturday)');
  if (!TIME_RE.test(String(s.onCallHandoverTime))) errors.push('The handover time must be HH:MM (24-hour)');
  if (s.onCallAnchorDate !== null && !toDateStr(s.onCallAnchorDate)) errors.push('The first handover date must be a date (YYYY-MM-DD)');
  return errors;
}

/** A urgent_response_settings row (Prisma) → the settings JSON. Null row = the defaults. */
export function rowToSettings(row) {
  if (!row) return normalizeSettings({});
  const src = {};
  for (const k of SETTINGS_FIELDS) if (row[k] !== undefined && (row[k] !== null || DEFAULT_SETTINGS[k] === null)) src[k] = row[k];
  return normalizeSettings(src);
}

/** The settings JSON → the columns of a row (Prisma `data`), without the bookkeeping columns. */
export function settingsToRow(settings) {
  const s = normalizeSettings(settings);
  const date = toDateStr(s.onCallAnchorDate);
  return { ...s, onCallAnchorDate: date ? new Date(`${date}T00:00:00.000Z`) : null };
}

/** True when `next` puts tickets in scope that `before` left alone (the engine must baseline again). */
export function widensScope(before, next) {
  if (before.mode !== next.mode && next.mode !== 'off') return true;
  const scope = (s) => new Set([...(s.raiseEnabled ? s.raisePriorities : []), ...(s.clockEnabled ? s.clockPriorities : [])]);
  const was = scope(before);
  return [...scope(next)].some((p) => !was.has(p));
}

export default {
  DEFAULT_SETTINGS, SETTINGS_FIELDS, PEOPLE_FIELDS, URGENT_RESPONSE_MODES, UNDOABLE_ACTIONS,
  atWork, awayPhrase, rankResponders, responderPhrase,
  handoverInstant, onCallWeek, onCallWeekByIndex, upcomingWeeks, alignedAnchorDate, anchorDateFor,
  resolveOnCall, onCallUntil, coversInWindow, leaveDaysInWindow, uncoveredLeaveDays,
  sentenceFor, rangeLabel, normalizeSettings, validateSettings, rowToSettings, settingsToRow, widensScope,
  localParts, toDateStr, addDaysStr, timeToMinutes, minutesToTime, safeZone,
};
