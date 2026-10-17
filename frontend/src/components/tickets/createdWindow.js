// Tickets list date window (QA 10-16 #7): 7 days · 30 days · 90 days · All
// time, on the toolbar and in the rail's Created section (one state, so the
// two always agree). The backend reads it as ?createdWithin= and hides only
// FINISHED tickets created before the window: work still in progress always
// shows, however old (backend/src/utils/createdWindow.js).
//
// Where the window comes from, strongest first:
//  1. explicit Created dates in the URL (createdFrom/createdTo) — "Custom",
//     the window steps aside;
//  2. ?created=<key> in the URL — a one-off for this view ("Show all time");
//  3. the person's own default (queue.createdWindow preference), 90 days
//     until they pick another.
// A typed search looks at every date, and the created_* cards carry their
// own dates, so neither is windowed.

export const WINDOW_CHOICES = [
  { key: '7d', short: '7d', label: '7 days', days: 7 },
  { key: '30d', short: '30d', label: '30 days', days: 30 },
  { key: '90d', short: '90d', label: '90 days', days: 90 },
  { key: 'all', short: 'All', label: 'All time', days: null },
];
export const DEFAULT_WINDOW = '90d';
export const WINDOW_PREF_KEY = 'queue.createdWindow';
export const WINDOW_STORAGE_KEY = 'tp_queue_created_window';

export const isWindowKey = (v) => WINDOW_CHOICES.some((c) => c.key === v);
export const windowChoice = (key) => WINDOW_CHOICES.find((c) => c.key === key) || null;

/**
 * The window in force for the list.
 * Returns { key, custom, applied, statsKey, searching }:
 *  - key: '7d' | '30d' | '90d' | 'all' (what the control shows as picked)
 *  - custom: explicit Created dates are set (none of the choices is picked)
 *  - applied: the list request carries createdWithin=key
 *  - statsKey: the window the stat cards are counted in (null = all time) —
 *    a card click keeps the window but drops dates and search, so cards
 *    always count in the token/default window
 *  - searching: a typed search is looking at every date
 */
export function resolveCreatedWindow({ token = '', pref = DEFAULT_WINDOW, createdFrom = '', createdTo = '', segment = '', q = '' } = {}) {
  const key = isWindowKey(token) ? token : (isWindowKey(pref) ? pref : DEFAULT_WINDOW);
  const custom = Boolean(createdFrom || createdTo);
  const searching = Boolean(String(q || '').trim());
  const ownDates = String(segment || '').startsWith('created_');
  const applied = key !== 'all' && !custom && !searching && !ownDates;
  return { key, custom, applied, statsKey: key === 'all' ? null : key, searching };
}

export function readStoredWindow() {
  try {
    const v = localStorage.getItem(WINDOW_STORAGE_KEY);
    return isWindowKey(v) ? v : DEFAULT_WINDOW;
  } catch {
    return DEFAULT_WINDOW;
  }
}

export function storeWindow(key) {
  try { localStorage.setItem(WINDOW_STORAGE_KEY, key); } catch { /* private mode */ }
}
