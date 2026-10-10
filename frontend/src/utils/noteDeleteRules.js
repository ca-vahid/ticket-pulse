/**
 * Who sees "Delete note" on a thread entry (QA 10-09 item 6). Mirrors
 * ticketService.deleteNote on the server, so the control shows only where the
 * request would be accepted:
 *  - Ticket Pulse tickets only (a FreshService note would sync straight back);
 *  - internal notes only (`eventType 'note'`) — replies, forwards and the
 *    requester's messages are the conversation and stay;
 *  - never system / approval notes;
 *  - an admin deletes any such note; anyone else only a note they wrote,
 *    matched on the entry's author e-mail. An entry with no author e-mail
 *    (synced or automated) is nobody's own;
 *  - the read-only role deletes nothing.
 */
export function canDeleteNoteEntry(entry, { origin = null, isAdmin = false, actorEmail = '', readOnly = false } = {}) {
  if (!entry || origin !== 'ticketpulse') return false;
  if (entry.eventType !== 'note' || entry.authorType === 'system') return false;
  if (isAdmin) return true;
  if (readOnly) return false;
  const mine = String(actorEmail || '').trim().toLowerCase();
  const author = String(entry.actorEmail || '').trim().toLowerCase();
  return Boolean(mine && author && mine === author);
}

export default canDeleteNoteEntry;
