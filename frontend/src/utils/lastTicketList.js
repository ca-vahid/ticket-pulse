// The ticket list a ticket was opened from (5 Nov 2026, QA 11-05 #4).
//
// The list hands the ticket page `state.from`, but that state is gone when the
// ticket is opened from a link or a new tab. The Tickets list also keeps its
// own address here, per workspace, so Close / Delete / Back can still return
// to the filtered list. sessionStorage: one tab's trail, never shared.

const KEY = 'tp_lastTicketList';

/** Only a list address counts: /tickets, /tickets?…, never /tickets/123. */
export function isTicketListPath(path) {
  return typeof path === 'string' && /^\/tickets(?:[?#]|$)/.test(path);
}

/** Drop the list's ?peek= so coming back does not reopen the preview. */
function withoutPeek(path) {
  const [pathname, rest = ''] = path.split('?');
  if (!rest) return path;
  const [query, hash = ''] = rest.split('#');
  const params = new URLSearchParams(query);
  params.delete('peek');
  const q = params.toString();
  return `${pathname}${q ? `?${q}` : ''}${hash ? `#${hash}` : ''}`;
}

function readAll() {
  try {
    const raw = sessionStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function rememberTicketList(workspaceId, path) {
  if (workspaceId == null || !isTicketListPath(path)) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...readAll(), [workspaceId]: withoutPeek(path) }));
  } catch { /* storage unavailable: the plain /tickets fallback still works */ }
}

export function readTicketList(workspaceId) {
  if (workspaceId == null) return null;
  const path = readAll()[workspaceId];
  return isTicketListPath(path) ? path : null;
}
