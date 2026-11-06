// Ticket header dates (5 Nov 2026, QA 11-05 #7): Pacific time, written the
// way people say it — "Tue 20 Oct, 9:14 AM" — with the year only when it is
// not this year, and relative words only where they add something.

export const PACIFIC = 'America/Vancouver';

function parts(date, opts) {
  const out = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: PACIFIC, ...opts }).formatToParts(date)) out[p.type] = p.value;
  return out;
}

function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Tue 20 Oct, 9:14 AM" (Pacific); "Tue 20 Oct 2025, 9:14 AM" in another year. */
export function formatPacificWhen(value, now = new Date()) {
  const d = toDate(value);
  if (!d) return '—';
  const p = parts(d, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  const thisYear = parts(now, { year: 'numeric' }).year;
  return `${p.weekday} ${p.day} ${p.month}${p.year !== thisYear ? ` ${p.year}` : ''}, ${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/** The day alone: "Tue 20 Oct" (Pacific); "Tue 20 Oct 2025" in another year. */
export function formatPacificDay(value, now = new Date()) {
  const d = toDate(value);
  if (!d) return '—';
  const p = parts(d, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const thisYear = parts(now, { year: 'numeric' }).year;
  return `${p.weekday} ${p.day} ${p.month}${p.year !== thisYear ? ` ${p.year}` : ''}`;
}

/** Board cards (QA 11-05b #2): "2 h ago" within the last day, else "Tue 20 Oct". */
export function dayOrAgo(value, now = Date.now()) {
  return isRecent(value, now) ? agoWords(value, now) : formatPacificDay(value, new Date(now));
}

/** Tooltip form, always with the year and the zone: "Tue 20 Oct 2026, 9:14 AM PDT". */
export function formatPacificFull(value) {
  const d = toDate(value);
  if (!d) return '';
  const p = parts(d, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' });
  return `${p.weekday} ${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} ${p.dayPeriod} ${p.timeZoneName}`;
}

/** "just now", "5 min ago", "2 h ago", "16 days ago", "3 months ago", "2 years ago". */
export function agoWords(value, now = Date.now()) {
  const d = toDate(value);
  if (!d) return '';
  const seconds = Math.max(0, Math.round((now - d.getTime()) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60) return days === 1 ? '1 day ago' : `${days} days ago`;
  const months = Math.floor(days / 30.4);
  if (months < 24) return `${months} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

/** Within the last day: worth saying "2 h ago" instead of the date. */
export function isRecent(value, now = Date.now()) {
  const d = toDate(value);
  return Boolean(d) && now - d.getTime() < 24 * 3600 * 1000 && now >= d.getTime() - 60 * 1000;
}

/** One reading of a moment: "2 h ago" when recent, else "Thu 22 Oct, 1:05 PM". */
export function whenOnce(value, now = Date.now()) {
  return isRecent(value, now) ? agoWords(value, now) : formatPacificWhen(value, new Date(now));
}
