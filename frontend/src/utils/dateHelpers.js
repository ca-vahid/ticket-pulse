/**
 * Format a Date as YYYY-MM-DD using the browser's local timezone (not UTC).
 * Use this instead of date.toISOString().split('T')[0] which always returns UTC.
 * @param {Date} date - Date to format (defaults to now)
 * @returns {string} Date string in YYYY-MM-DD format
 */
export function formatDateLocal(date) {
  const d = date || new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Format a date/time in a specific IANA timezone.
 * Falls back to the browser locale if the timezone is invalid.
 * @param {Date|string|number} date
 * @param {string} timezone
 * @param {Intl.DateTimeFormatOptions} options
 * @returns {string}
 */
export function formatDateTimeInTimezone(
  date,
  timezone = 'America/Los_Angeles',
  options = {},
) {
  if (!date) return '';

  const dateObj = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(dateObj.getTime())) return '';

  const formatOptions = {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...options,
  };

  try {
    return new Intl.DateTimeFormat('en-US', formatOptions).format(dateObj);
  } catch {
    const { timeZone: _timeZone, ...fallbackOptions } = formatOptions;
    return new Intl.DateTimeFormat('en-US', fallbackOptions).format(dateObj);
  }
}

/**
 * Format a date only in a specific IANA timezone.
 * @param {Date|string|number} date
 * @param {string} timezone
 * @param {Intl.DateTimeFormatOptions} options
 * @returns {string}
 */
export function formatDateOnlyInTimezone(
  date,
  timezone = 'America/Los_Angeles',
  options = {},
) {
  return formatDateTimeInTimezone(date, timezone, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...options,
  });
}
