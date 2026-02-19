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
