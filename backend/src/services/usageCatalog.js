/**
 * Site stats: which server requests count as an "action", and what to call
 * them on the Settings -> Site stats page.
 *
 * Actions are recorded from the matched Express route pattern
 * ("POST /api/tickets/:id/replies"), so a new feature shows up by itself the
 * first time someone uses it. This file only (1) leaves out requests that are
 * not a person doing something and (2) gives the common ones a readable name.
 * A pattern without a label is shown as the pattern.
 */

// Background chatter and housekeeping: saved preferences, presence pings,
// drafts, read markers, the stats endpoints themselves.
const EXCLUDED = [
  /^\/api\/(usage|site-stats|auth|sse|workspaces)(\/|$)/,
  /\/(preferences|presence|typing|drafts?|telemetry|heartbeat|viewing|seen|read-state)(\/|$)/,
  /\/pinned-cards\//,
];

// Reads worth counting. Everything else that is a GET is a page loading data.
const COUNTED_READS = new Set([
  'GET /api/search/',
  'GET /api/search',
]);

const LABELS = {
  'GET /api/search/': 'Search',
  'GET /api/search': 'Search',
  'POST /api/tickets/': 'Create a ticket',
  'PATCH /api/tickets/:id': 'Edit ticket fields',
  'DELETE /api/tickets/:id': 'Delete a ticket',
  'POST /api/tickets/:id/replies': 'Reply to a ticket',
  'POST /api/tickets/:id/notes': 'Add an internal note',
  'PATCH /api/tickets/:id/notes/:entryId': 'Edit a note',
  'DELETE /api/tickets/:id/notes/:entryId': 'Delete a note',
  'POST /api/tickets/:id/forward': 'Forward a ticket',
  'POST /api/tickets/:id/assign': 'Assign a ticket',
  'POST /api/tickets/:id/status': 'Change ticket status',
  'POST /api/tickets/:id/fs-update': 'Edit a FreshService ticket',
  'PATCH /api/tickets/:id/custom-fields': 'Edit custom fields',
  'PUT /api/tickets/:id/tags': 'Edit tags',
  'POST /api/tickets/:id/park': 'Park a ticket',
  'DELETE /api/tickets/:id/park': 'Unpark a ticket',
  'POST /api/tickets/:id/merge': 'Merge tickets',
  'POST /api/tickets/:id/merge-many': 'Merge tickets',
  'POST /api/tickets/:id/split': 'Split a ticket',
  'POST /api/tickets/:id/clone': 'Clone a ticket',
  'POST /api/tickets/:id/children': 'Create a child ticket',
  'POST /api/tickets/:id/links': 'Link tickets',
  'POST /api/tickets/:id/noise': 'Mark noise / not noise',
  'POST /api/tickets/:id/summarize': 'Summarise a ticket',
  'POST /api/tickets/:id/triage': 'Run AI triage',
  'POST /api/tickets/:id/solution': 'Record a solution',
  'POST /api/tickets/:id/tasks': 'Add a task',
  'PATCH /api/tickets/:id/tasks/:taskId': 'Edit a task',
  'POST /api/tickets/:id/approvals': 'Request an approval',
  'POST /api/tickets/:id/approvals/:approvalId/decide': 'Decide an approval',
  'POST /api/tickets/:id/macros/:macroId/apply': 'Apply a macro',
  'POST /api/tickets/:id/proposed-replies/:proposalId/send': 'Send an AI-proposed reply',
  'POST /api/tickets/bulk-by-query': 'Bulk edit tickets',
  'POST /api/tickets/bulk-park': 'Bulk park tickets',
  'POST /api/tickets/bulk-delete': 'Bulk delete tickets',
  'POST /api/tickets/saved-views': 'Save a view',
  'POST /api/tickets/scheduled': 'Schedule a ticket',
  'POST /api/tickets/templates': 'Save a reply template',
};

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The action key for a finished request, or null when it should not count. */
export function actionKeyFor(method, pattern) {
  const m = String(method || '').toUpperCase();
  const p = String(pattern || '');
  if (!p.startsWith('/api/')) return null;
  if (EXCLUDED.some((re) => re.test(p))) return null;
  const key = `${m} ${p}`;
  if (WRITE_METHODS.has(m)) return key.slice(0, 160);
  return COUNTED_READS.has(key) ? key : null;
}

export function actionLabel(key) {
  return LABELS[key] || null;
}

// UI-only things that never reach a write endpoint. The browser may send
// these names and no others.
export const UI_EVENT_KEYS = new Set([
  'ticket.peek',
  'palette.open',
  'export.csv',
  'theme.switch',
  'columns.change',
  'filter.apply',
  'view.open',
]);

export default { actionKeyFor, actionLabel, UI_EVENT_KEYS };
