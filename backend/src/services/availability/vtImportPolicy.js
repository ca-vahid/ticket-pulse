/**
 * Vacation Tracker → Availability import policy (QA 11-09). No imports, so
 * the scheduler and the services read it without loading each other.
 *
 * #1 The import runs every 15 minutes for every active workspace with a
 *    Vacation Tracker key. Off outside production unless
 *    AVAILABILITY_VT_IMPORT=true (a developer's .env holds the real key);
 *    AVAILABILITY_VT_IMPORT=false is the kill switch in production.
 * #2 An imported leave a person cancelled in Ticket Pulse stays cancelled.
 */
export const VT_IMPORT_EVERY_MINUTES = 15;
// :04, :19, :34, :49 — clear of the hourly leave sync (:00) and calendar sync (:15).
export const AVAILABILITY_VT_IMPORT_CRON = '4,19,34,49 * * * *';
export const VT_IMPORT_DAYS_BACK = 30;
export const VT_IMPORT_DAYS_AHEAD = 365;
export const VT_IMPORT_STATUS_KEY = 'availability_vt_import_status';

export function scheduledVtImportEnabled(env = process.env) {
  if (env.AVAILABILITY_VT_IMPORT === 'false') return false;
  if (env.NODE_ENV !== 'production' && env.AVAILABILITY_VT_IMPORT !== 'true') return false;
  return true;
}

/**
 * Was this imported leave last cancelled by a person in Ticket Pulse (not by
 * the sync, not merged into an app request by the 4.2.67 take-over)?
 * `events` are the request's events, any order; only 'cancelled' ones count.
 * Those cancels stand: the import never brings the leave back and the leave
 * sync writes no dashboard rows for it, while Vacation Tracker may still list
 * it as approved.
 */
export function cancelledInTicketPulse(events) {
  const cancels = (events || []).filter((e) => e?.kind === 'cancelled');
  if (!cancels.length) return false;
  const last = cancels.reduce((a, b) => ((Number(b.id) || 0) >= (Number(a.id) || 0) ? b : a));
  const d = last.details || {};
  return d.source !== 'vacation_tracker' && !d.mergedInto;
}
