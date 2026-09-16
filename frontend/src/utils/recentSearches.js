import { uiPreferencesAPI } from '../services/api';

/**
 * Search v2 (16 Sep 2026): the person's recent searches and recently viewed
 * tickets. Recent searches follow the person across devices through the
 * `ui.recentSearches` preference (server-wins on load) with a localStorage
 * mirror so the panel opens instantly; recently viewed tickets are per
 * browser only (cheap, private, and the list would differ per device anyway).
 */
export const RECENT_SEARCHES_KEY = 'tp_recent_searches';
export const RECENT_TICKETS_KEY = 'tp_recent_tickets';
export const RECENT_SEARCHES_MAX = 8;
export const RECENT_TICKETS_MAX = 6;

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    const v = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked — memory only */ }
}

const cleanQueries = (list) => [...new Set((Array.isArray(list) ? list : []).map((s) => String(s || '').trim()).filter(Boolean))].slice(0, RECENT_SEARCHES_MAX);

export function getRecentSearches() {
  return cleanQueries(readJson(RECENT_SEARCHES_KEY));
}

/** Server copy wins on load (same choreography as the theme seed). */
export async function syncRecentSearches() {
  try {
    const res = await uiPreferencesAPI.get('ui.recentSearches');
    const value = res?.data?.value ?? res?.value;
    if (Array.isArray(value)) {
      const cleaned = cleanQueries(value);
      writeJson(RECENT_SEARCHES_KEY, cleaned);
      return cleaned;
    }
  } catch { /* offline / not signed in — the mirror stands */ }
  return getRecentSearches();
}

let pushTimer = null;
function persistRecentSearches(list) {
  writeJson(RECENT_SEARCHES_KEY, list);
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    uiPreferencesAPI.set('ui.recentSearches', list).catch(() => { /* fire-and-forget */ });
  }, 600);
}

export function rememberSearch(query) {
  const q = String(query || '').trim();
  if (q.length < 2) return getRecentSearches();
  const next = cleanQueries([q, ...getRecentSearches().filter((s) => s.toLowerCase() !== q.toLowerCase())]);
  persistRecentSearches(next);
  return next;
}

export function forgetSearch(query) {
  const next = getRecentSearches().filter((s) => s !== query);
  persistRecentSearches(next);
  return next;
}

export function clearRecentSearches() {
  persistRecentSearches([]);
  return [];
}

export function getRecentTickets() {
  return readJson(RECENT_TICKETS_KEY).filter((t) => t && Number.isFinite(Number(t.id))).slice(0, RECENT_TICKETS_MAX);
}

/** Called when a ticket is opened (page or peek). */
export function rememberTicket(ticket) {
  if (!ticket || !ticket.id) return;
  const entry = { id: Number(ticket.id), displayRef: ticket.displayRef || null, subject: ticket.subject || null, status: ticket.status || null, at: Date.now() };
  const next = [entry, ...getRecentTickets().filter((t) => Number(t.id) !== entry.id)].slice(0, RECENT_TICKETS_MAX);
  writeJson(RECENT_TICKETS_KEY, next);
}
