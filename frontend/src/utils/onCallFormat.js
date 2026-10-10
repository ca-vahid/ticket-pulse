/**
 * Dates and times for on-call (plans/URGENT_RESPONSE_PLAN.md), always in the
 * zone the API names: "Thu 15 Oct", "5:00 p.m.". An unknown zone falls back
 * to the viewer's own.
 */

function parts(value, timeZone, locale, options) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  let list;
  try {
    list = new Intl.DateTimeFormat(locale, { ...options, ...(timeZone ? { timeZone } : {}) }).formatToParts(date);
  } catch {
    list = new Intl.DateTimeFormat(locale, options).formatToParts(date);
  }
  return Object.fromEntries(list.map((p) => [p.type, p.value]));
}

/** "Thu 15 Oct" */
export function formatOnCallDay(value, timeZone) {
  const p = parts(value, timeZone, 'en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  return p ? `${p.weekday} ${p.day} ${p.month}` : '';
}

/** "5:00 p.m." */
export function formatOnCallTime(value, timeZone) {
  const p = parts(value, timeZone, 'en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  if (!p) return '';
  return `${p.hour}:${p.minute} ${/^a/i.test(p.dayPeriod || '') ? 'a.m.' : 'p.m.'}`;
}

/** "Thu 15 Oct 5:00 p.m." */
export function formatOnCallMoment(value, timeZone) {
  return [formatOnCallDay(value, timeZone), formatOnCallTime(value, timeZone)].filter(Boolean).join(' ');
}

/** "Thu 15 Oct to Mon 19 Oct" */
export function formatOnCallRange(startsAt, endsAt, timeZone) {
  return `${formatOnCallDay(startsAt, timeZone)} to ${formatOnCallDay(endsAt, timeZone)}`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** 1 → "Monday" */
export function handoverDayName(day) {
  return DAY_NAMES[Number(day)] || 'Monday';
}

/** "17:00" → "5:00 p.m." */
export function handoverTimeLabel(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''));
  if (!m) return '5:00 p.m.';
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'a.m.' : 'p.m.'}`;
}

/** What somebody agrees to when they take a cover request. */
export function coverCommitment(request, timeZone) {
  if (!request) return '';
  const zone = timeZone || request.timezone || undefined;
  return `You will be on call from ${formatOnCallMoment(request.startsAt, zone)} to ${formatOnCallMoment(request.endsAt, zone)}.`;
}
