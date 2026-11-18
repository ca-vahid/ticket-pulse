/**
 * QA 11-17 #2: digest times are Pacific wall-clock 'HH:MM' strings. Shown to
 * people as "9:00 AM PT" (plain text, never a chip).
 */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const MAX_DIGEST_TIMES = 4;

export const isDigestTime = (v) => typeof v === 'string' && TIME_RE.test(v);

export function digestTimeLabel(hhmm) {
  if (!isDigestTime(hhmm)) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'} PT`;
}
