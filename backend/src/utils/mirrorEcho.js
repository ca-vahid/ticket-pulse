/** The line the mirror stamps on every note it writes on a FreshService copy (mirrorService). */
const MIRROR_MARKER = '[Ticket Pulse mirror]';

/**
 * A row that is only the mirror's own note read back from the FreshService copy
 * of a Ticket Pulse-born ticket (14 Oct 2026, TP-1888): every reply and note
 * showed twice in the conversation. 4.2.71 stops storing them; this keeps any
 * that arrive by another path off the screen.
 */
export function isMirrorEcho(entry) {
  if (!entry || entry.source !== 'freshservice_conversation') return false;
  return String(entry.bodyText || '').includes(MIRROR_MARKER) || String(entry.bodyHtml || '').includes(MIRROR_MARKER);
}
