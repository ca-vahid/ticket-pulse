// Tickets list date window (QA 10-16 #7): "7 days · 30 days · 90 days · All
// time" on the Tickets page. The window trims FINISHED history only — a
// ticket still being worked (an Open- or Pending-base status, parked ones
// included) always shows, however old, so an old open ticket can never drop
// out of the default list. The list where-clause and the stat-card counts both
// read this, so a card's number still equals its click.

const WINDOW_DAYS = { '7d': 7, '30d': 30, '90d': 90 };

/** Days in a window token ('7d' | '30d' | '90d'); null for 'all', empty or unknown. */
export function createdWindowDays(value) {
  const key = String(value ?? '').trim().toLowerCase();
  return WINDOW_DAYS[key] || null;
}

/** Start of the window: local midnight `days` days before `now`. Null = no window. */
export function createdWindowStart(value, now = new Date()) {
  const days = createdWindowDays(value);
  if (!days) return null;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - days);
  return start;
}
