/**
 * When a ticket ended (closed or resolved). Tickets brought in by the FreshService
 * history import carry neither date (10 Nov 2026), so a terminal status falls back
 * to FreshService's own last update, then the last real activity — never updatedAt,
 * which is the import time.
 *
 * Kept here (no imports) so the reply facts (services/replyFacts.js) and mail
 * intake (mailboxIngestService, which re-exports it) read the same answer.
 */
export function ticketEndedAt(ticket) {
  if (!ticket) return null;
  const direct = ticket.closedAt || ticket.resolvedAt;
  if (direct) return direct;
  const terminal = /^(closed|resolved)$/i.test(String(ticket.status || ''));
  return terminal ? (ticket.freshserviceUpdatedAt || ticket.lastRealActivityAt || null) : null;
}

export default ticketEndedAt;
