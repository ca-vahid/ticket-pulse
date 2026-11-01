// Who is away (31 Oct 2026, Vahid): the server marks each agent in meta.technicians
// with `away` = { firstDay, lastDay, backOn, workingDaysAway, fromToday } when they
// have a full day off at the next working moment (today during business hours,
// otherwise the next working day). These helpers word it the same everywhere.

/** "Mon 16 Nov" from 'yyyy-MM-dd' (a calendar day, no zone shift). */
export function dayLabel(dateStr) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(dateStr);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '');
}

/** The short tag beside a name: "Away · back Mon 16 Nov". Null when not away. */
export function awayTag(away) {
  if (!away) return null;
  return away.backOn ? `Away · back ${dayLabel(away.backOn)}` : 'Away';
}

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'They';

/**
 * The warning before assigning: "Sam is away from Mon 2 Nov to Fri 13 Nov
 * (9 working days) and back Mon 16 Nov."
 */
export function awaySentence(name, away) {
  if (!away) return '';
  const who = firstName(name);
  const days = Number(away.workingDaysAway) || 1;
  const span = away.firstDay === away.lastDay
    ? `${away.fromToday ? 'today' : `on ${dayLabel(away.firstDay)}`}`
    : `from ${away.fromToday ? 'today' : dayLabel(away.firstDay)} to ${dayLabel(away.lastDay)}`;
  const length = days === 1 ? '1 working day' : `${days} working days`;
  const back = away.backOn ? ` and back ${dayLabel(away.backOn)}` : ', with no return date in the calendar yet';
  return `${who} is away ${span} (${length})${back}.`;
}

/** technicianId → away, from meta.technicians. */
export function awayById(technicians) {
  const map = new Map();
  for (const t of technicians || []) if (t?.away && t.id != null) map.set(Number(t.id), t.away);
  return map;
}
