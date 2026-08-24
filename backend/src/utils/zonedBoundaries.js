import { startOfMonth, startOfWeek, startOfYear } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';

/**
 * Calendar-period starts in a WORKSPACE timezone (Mega 08-23 Phase FC).
 *
 * Boundary convention (deliberate): the created_week/month/year quick-filter
 * segments cut on the workspace's wall clock (Workspace.defaultTimezone) —
 * "this week" starts Monday 00:00 *workspace time*, not server time. This
 * consciously diverges from the older due_today endOfDay convention
 * (server-local setHours(23,59,59,999)): due dates are short-horizon and the
 * few-hour skew washes out, but a week/month/year boundary cut on the UTC
 * server clock would misfile up to 8 hours of tickets for a Pacific
 * workspace. Same toZonedTime/fromZonedTime pattern queueStatsService uses
 * for business-hours windows.
 *
 * Mechanics: shift `now` into the zone's wall clock (toZonedTime), take the
 * calendar boundary there (date-fns, weeks start Monday), then convert that
 * wall-clock instant back to UTC (fromZonedTime) for the DB comparison.
 */
function zonedBoundary(now, timezone, startOfFn) {
  const zonedNow = toZonedTime(now, timezone);
  return fromZonedTime(startOfFn(zonedNow), timezone);
}

/** UTC instant of Monday 00:00 of the current week in `timezone`. */
export function zonedStartOfWeek(now, timezone) {
  return zonedBoundary(now, timezone, (d) => startOfWeek(d, { weekStartsOn: 1 }));
}

/** UTC instant of the 1st 00:00 of the current month in `timezone`. */
export function zonedStartOfMonth(now, timezone) {
  return zonedBoundary(now, timezone, startOfMonth);
}

/** UTC instant of Jan 1 00:00 of the current year in `timezone`. */
export function zonedStartOfYear(now, timezone) {
  return zonedBoundary(now, timezone, startOfYear);
}
