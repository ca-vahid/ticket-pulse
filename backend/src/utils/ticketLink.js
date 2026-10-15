/**
 * Short ticket links (14 Oct 2026): <base>/<workspace link name>/<TP-n | FreshService number>,
 * e.g. https://ticketpulse.bgcsaas.com/it/TP-10000. Opened by the app's short-link page
 * (GET /api/workspaces/resolve-ticket).
 *
 * Synchronous on purpose: the ~20 places that put a ticket link in an e-mail or a card
 * build it inside template strings. The link names are kept in memory
 * (workspaceLinkNameService.refresh() at boot, after a save, and every few minutes);
 * until they are loaded, or when the ticket object lacks its numbers, the long
 * /tickets/<id> form is used, which always works.
 */
const linkNames = new Map(); // workspaceId -> link name

export function setWorkspaceLinkNames(map) {
  linkNames.clear();
  for (const [id, name] of Object.entries(map || {})) {
    const key = Number(id);
    const value = String(name || '').trim().toLowerCase();
    if (key > 0 && value) linkNames.set(key, value);
  }
}

export function workspaceLinkName(workspaceId) {
  return linkNames.get(Number(workspaceId)) || null;
}

/** "TP-1876" for a Ticket Pulse ticket, "246762" for a FreshService one, else null. */
export function shortTicketRef(ticket) {
  if (!ticket) return null;
  const native = ticket.nativeNumber ?? ticket.native_number;
  const origin = ticket.origin;
  if (native !== null && native !== undefined && (origin === 'ticketpulse' || origin === undefined)) return `TP-${native}`;
  const fs = ticket.freshserviceTicketId ?? ticket.freshservice_ticket_id;
  if (fs !== null && fs !== undefined && origin !== 'ticketpulse') return String(fs);
  return null;
}

/** "/it/TP-1876" when the short form is possible, else "/tickets/<id>" (null without an id). */
export function ticketPath(ticket) {
  const name = workspaceLinkName(ticket?.workspaceId ?? ticket?.workspace_id);
  const ref = shortTicketRef(ticket);
  if (name && ref) return `/${encodeURIComponent(name)}/${ref}`;
  return ticket?.id ? `/tickets/${ticket.id}` : null;
}

/** Full link for e-mails and cards. `base` is the public app URL (trailing slashes ignored). */
export function ticketLinkUrl(base, ticket) {
  const path = ticketPath(ticket);
  if (!path) return null;
  return `${String(base || '').replace(/\/+$/, '')}${path}`;
}

export default { setWorkspaceLinkNames, workspaceLinkName, shortTicketRef, ticketPath, ticketLinkUrl };
