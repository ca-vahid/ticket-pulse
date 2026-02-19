import { formatInTimeZone, toZonedTime } from 'date-fns-tz';
import config from '../config/index.js';

/**
 * Get "today" start and end timestamps in a specific timezone
 * @param {string} timezone - IANA timezone string (e.g., 'America/Los_Angeles')
 * @param {Date} date - Optional date to get range for (defaults to now)
 * @returns {Object} { start: Date, end: Date } - Start and end of day in UTC
 */
export function getTodayRange(timezone = config.sync.defaultTimezone, date = null) {
  const referenceDate = date || new Date();

  // Get the date string in the target timezone (YYYY-MM-DD format)
  const dateStr = formatInTimeZone(referenceDate, timezone, 'yyyy-MM-dd');

  // Create ISO strings for midnight and end-of-day in the target timezone
  // Format: 2025-10-13T00:00:00-07:00 (with timezone offset)
  const startISO = formatInTimeZone(
    new Date(`${dateStr}T12:00:00Z`), // Use noon UTC as reference
    timezone,
    "yyyy-MM-dd'T'00:00:00XXX", // Midnight in target timezone with offset
  );

  const endISO = formatInTimeZone(
    new Date(`${dateStr}T12:00:00Z`), // Use noon UTC as reference
    timezone,
    "yyyy-MM-dd'T'23:59:59.999XXX", // End of day in target timezone with offset
  );

  // Parse these ISO strings back to Date objects (JavaScript will convert to UTC internally)
  return {
    start: new Date(startISO),
    end: new Date(endISO),
  };
}

/**
 * Convert UTC date to a specific timezone for display
 * @param {Date|string} date - UTC date
 * @param {string} timezone - Target timezone
 * @param {string} formatString - Output format (default: 'yyyy-MM-dd HH:mm:ss')
 * @returns {string} Formatted date string
 */
export function convertToTimezone(date, timezone, formatString = 'yyyy-MM-dd HH:mm:ss zzz') {
  if (!date) return null;

  const dateObj = typeof date === 'string' ? new Date(date) : date;
  return formatInTimeZone(dateObj, timezone, formatString);
}

/**
 * Get relative time string (e.g., "2h ago", "45m ago")
 * @param {Date|string} date - Past date
 * @returns {string} Relative time string
 */
export function getRelativeTime(date) {
  if (!date) return '';

  const dateObj = typeof date === 'string' ? new Date(date) : date;
  const now = new Date();
  const diffMs = now - dateObj;

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

/**
 * Check if a date falls within "today" in a specific timezone
 * @param {Date|string} date - Date to check
 * @param {string} timezone - Timezone to check against
 * @returns {boolean}
 */
export function isToday(date, timezone = config.sync.defaultTimezone) {
  if (!date) return false;

  const dateObj = typeof date === 'string' ? new Date(date) : date;
  const { start, end } = getTodayRange(timezone);

  return dateObj >= start && dateObj <= end;
}

/**
 * Get current time in a specific timezone
 * @param {string} timezone - Target timezone
 * @returns {Date} Current time in the target timezone
 */
export function getCurrentTimeInTimezone(timezone) {
  return toZonedTime(new Date(), timezone);
}

/**
 * Format a date as YYYY-MM-DD in a specific timezone (not UTC)
 * Use this instead of date.toISOString().split('T')[0] which returns UTC date
 * @param {Date|string|null} date - Date to format (defaults to now)
 * @param {string} timezone - Target timezone
 * @returns {string} Date string in YYYY-MM-DD format
 */
export function formatDateInTimezone(date = null, timezone = config.sync.defaultTimezone) {
  const dateObj = typeof date === 'string' ? new Date(date) : (date || new Date());
  return formatInTimeZone(dateObj, timezone, 'yyyy-MM-dd');
}

/**
 * Format duration in minutes to human-readable string
 * @param {number} minutes - Duration in minutes
 * @returns {string} Formatted duration (e.g., "2h 30m", "45m")
 */
export function formatDuration(minutes) {
  if (!minutes || minutes < 0) return '0m';

  const hours = Math.floor(minutes / 60);
  const mins = Math.floor(minutes % 60);

  if (hours > 0 && mins > 0) return `${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h`;
  return `${mins}m`;
}
