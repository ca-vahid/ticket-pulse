/**
 * The Tickets queue's last view (its filters live in the query string), kept per
 * workspace so coming back to the queue by any road lands on the same tickets
 * (Vahid, 14 Oct 2026). Back from a ticket only kept the filters when the ticket
 * was opened straight from the list; stepping to another ticket, opening a
 * related one or the nav rail came back to a bare /tickets.
 *
 * Clearing the filters is remembered too (an empty view), so "Clear all" sticks.
 * Never throws: storage can be missing (private window) or full.
 */

const PREFIX = 'tp_queue_view_ws';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Not part of the view: the side preview of one ticket.
const TRANSIENT = ['peek'];

export function queueSearchToKeep(search) {
  const params = new URLSearchParams(search || '');
  for (const key of TRANSIENT) params.delete(key);
  const out = params.toString();
  return out ? `?${out}` : '';
}

export function rememberQueueView(workspaceId, search) {
  if (!workspaceId) return;
  try {
    localStorage.setItem(`${PREFIX}${workspaceId}`, JSON.stringify({ search: queueSearchToKeep(search), at: Date.now() }));
  } catch { /* storage unavailable */ }
}

// Scroll position of the list (QA 10-16 #9): kept for this browser tab only,
// and only for the exact view it was read on, so coming back to the list (the
// nav rail, Back) lands on the same rows. A different view starts at the top.
const SCROLL_PREFIX = 'tp_queue_scroll_ws';

export function rememberQueueScroll(workspaceId, search, top) {
  if (!workspaceId) return;
  try {
    sessionStorage.setItem(`${SCROLL_PREFIX}${workspaceId}`, JSON.stringify({ search: queueSearchToKeep(search), top: Math.max(0, Math.round(Number(top) || 0)) }));
  } catch { /* storage unavailable */ }
}

/** The remembered { search, top } for this workspace, or null. */
export function readQueueScroll(workspaceId) {
  if (!workspaceId) return null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(`${SCROLL_PREFIX}${workspaceId}`) || 'null');
    if (!saved || typeof saved.search !== 'string' || !Number.isFinite(saved.top)) return null;
    return { search: saved.search, top: Math.max(0, saved.top) };
  } catch {
    return null;
  }
}

/** The remembered scroll offset for exactly this view, or 0. */
export function recallQueueScroll(workspaceId, search, entry = readQueueScroll(workspaceId)) {
  if (!entry || entry.search !== queueSearchToKeep(search)) return 0;
  return entry.top;
}

/** The remembered query string ('?…'), or '' when there is none or it is over a week old. */
export function recallQueueView(workspaceId, now = Date.now()) {
  if (!workspaceId) return '';
  try {
    const saved = JSON.parse(localStorage.getItem(`${PREFIX}${workspaceId}`) || 'null');
    if (!saved || typeof saved.search !== 'string' || !saved.search.startsWith('?')) return '';
    if (!Number.isFinite(saved.at) || now - saved.at > MAX_AGE_MS) return '';
    return saved.search;
  } catch {
    return '';
  }
}
