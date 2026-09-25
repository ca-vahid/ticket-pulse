/**
 * Quiet hours for heavy background work (history backfill, faster notes pull):
 * 20:00–05:59 Pacific on weekdays, and all weekend. The FreshService budget is
 * mostly free then; during the working day the syncs and the mirror need it.
 */
export function pacificParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Vancouver', weekday: 'short', hour: 'numeric', hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value) % 24;
  const weekday = parts.find((p) => p.type === 'weekday')?.value || '';
  return { hour, weekday };
}

export function isQuietHours(date = new Date()) {
  const { hour, weekday } = pacificParts(date);
  if (weekday === 'Sat' || weekday === 'Sun') return true;
  return hour >= 20 || hour < 6;
}
