/**
 * Retire Vacation Tracker (26 Nov 2026): one switch, after which Ticket Pulse
 * never calls Vacation Tracker again, so its subscription can end safely.
 *
 * The state is one app setting, no schema change:
 *   vacation_tracker_retired = JSON { retiredAt, retiredBy, retiredByName, report }
 *
 * Every Vacation Tracker caller asks isVacationTrackerRetired() first: the
 * hourly leave sync (and its stale clean-up), the leave-type and user syncs,
 * the connection tests, the 15-minute import into Vacation Pulse and the
 * write-back. When retired they log once and return; they never throw and
 * never delete. The one-time handover (availabilityService
 * .retireVacationTracker) moves the upcoming imported bookings into Vacation
 * Pulse proper.
 *
 * No imports of the other Availability modules, so the scheduler, the legacy
 * sync and the write-back can all read it without loading each other.
 */
import settingsRepository from '../settingsRepository.js';
import logger from '../../utils/logger.js';

export const VT_RETIRED_KEY = 'vacation_tracker_retired';

/**
 * The retirement record, or null while Vacation Tracker is still in use.
 * Never throws, unless `strict` (the projection: better to write nothing than
 * guess), in which case an unreadable switch throws.
 */
export async function getVacationTrackerRetirement({ strict = false } = {}) {
  let raw;
  try {
    raw = await settingsRepository.get(VT_RETIRED_KEY);
  } catch (err) {
    if (strict) throw new Error(`could not read the Vacation Tracker retired switch (${err.message})`);
    logger.warn(`Vacation Tracker: could not read the retired switch (${err.message}); treating it as still in use`);
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' && parsed.retiredAt ? parsed : null;
  } catch {
    logger.warn('Vacation Tracker: the retired switch is not valid JSON; treating it as still in use');
    return null;
  }
}

/** Has Vacation Tracker been retired? Never throws (an unreadable switch reads as "not retired"). */
export async function isVacationTrackerRetired() {
  return Boolean(await getVacationTrackerRetirement());
}

/** Keep the retirement record (the first retiredAt / retiredBy win; the report is the latest run's). */
export async function saveVacationTrackerRetirement(record) {
  await settingsRepository.set(VT_RETIRED_KEY, JSON.stringify(record));
  return record;
}

const logged = new Set();
/** One info line per caller per process: "retired, not calling Vacation Tracker". */
export function logRetiredOnce(caller) {
  if (logged.has(caller)) return;
  logged.add(caller);
  logger.info(`Vacation Tracker is retired: ${caller} no longer calls it`);
}

/** Test seam. */
export function _resetRetiredLog() {
  logged.clear();
}
