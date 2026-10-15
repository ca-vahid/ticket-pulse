/**
 * Short ticket links (14 Oct 2026): ticketpulse.bgcsaas.com/it/1876, /it/TP-1876,
 * /TP-1876 or /246762 open the ticket (resolved by GET /api/workspaces/resolve-ticket).
 * Mirrors backend parseTicketRef in services/ticketShortLinkService.js.
 */
const REF_RE = /^(?:tp[-\s]?|#)?\d{1,12}$/i;

// Page names (first URL segment) that are never a workspace: /settings/1234 still goes home.
// Mirrors RESERVED_WORKSPACE_SLUGS in backend services/ticketShortLinkService.js.
export const RESERVED_FIRST_SEGMENTS = new Set([
  'login', 'auth', 'workspace', 'workspaces', 'dashboard', 'tickets', 'technician', 'timeline', 'analytics',
  'assignments', 'settings', 'visuals', 'knowledge', 'approval', 'approval-reply', 'approvals', 'availability',
  'onboarding', 'on-call', 'profile', 'mail-alerts', 'notifications', 'my-competencies', 'requesters',
  'workflows', 'feedback', 'summit', 'summit-taxonomy', 'ticket-status', 'ticket-escalation', 'ticket-urgency',
  'api', 'health', 'assets', 'brand', 'branding-mockups', 'demo-avatars', 'downloads', 'feedback-themes',
]);

/** Does this URL segment read as a ticket number ("TP-1876", "1876", "246762")? */
export function looksLikeTicketRef(segment) {
  let text = String(segment ?? '');
  try { text = decodeURIComponent(text); } catch { /* keep as typed */ }
  text = text.trim();
  return REF_RE.test(text) && Number(text.replace(/\D/g, '')) > 0;
}

/**
 * The short link for a ticket: <origin>/<workspace link name>/<TP-n | FreshService number>.
 * Null when the ticket has no display reference or the workspace no slug.
 */
export function ticketShortLink(workspace, ticket, origin = (typeof window !== 'undefined' ? window.location.origin : '')) {
  const slug = String(workspace?.linkName || workspace?.slug || '').trim();
  const ref = String(ticket?.displayRef || '').trim().replace(/^#/, '');
  if (!slug || !ref || !looksLikeTicketRef(ref)) return null;
  return `${origin}/${encodeURIComponent(slug)}/${ref}`;
}
