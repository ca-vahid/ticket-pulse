/**
 * The ticket reference and link that go into a phone or e-mail alert
 * (QA 11-23 item 1). One builder for the after-hours escalation, the
 * assignment alert and the priority-change alert.
 *
 * Every alert points at the ticket in Ticket Pulse, where the team works it:
 * the short link (<base>/<workspace link name>/TP-n, or /<link name>/<FS number>
 * for a FreshService-born ticket), else /tickets/<id>. The FreshService link is
 * only the fallback for a ticket object without an id. The reference is the
 * ticket's own: TP-n for a Ticket Pulse ticket, #n for a FreshService one.
 */
import config from '../config/index.js';
import logger from './logger.js';
import { ticketLinkUrl } from './ticketLink.js';
import { resolvePublicBaseUrl } from './publicBaseUrl.js';
import { ticketDisplayRef } from './ticketOrigin.js';

export function freshserviceTicketLink(ticket) {
  const fsId = ticket?.freshserviceTicketId ? Number(ticket.freshserviceTicketId) : null;
  const domain = config.freshservice?.domain || null;
  const host = domain
    ? (domain.includes('.freshservice.com') ? domain : `${domain}.freshservice.com`)
    : null;
  return fsId && host ? `https://${host}/a/tickets/${fsId}` : null;
}

/** The ticket in Ticket Pulse; null without an id. */
export function ticketAppLink(ticket) {
  if (!ticket?.id) return null;
  return ticketLinkUrl(resolvePublicBaseUrl({ warn: (m) => logger.warn(m) }), ticket);
}

/** Ticket Pulse first; FreshService only when no app link can be built. */
export function notificationTicketLink(ticket) {
  return ticketAppLink(ticket) || freshserviceTicketLink(ticket);
}

/** "TP-1043" / "#250001", or null when the ticket carries no number at all. */
export function notificationTicketRef(ticket) {
  if (!ticket) return null;
  const hasNative = ticket.nativeNumber !== null && ticket.nativeNumber !== undefined;
  const hasFs = ticket.freshserviceTicketId !== null && ticket.freshserviceTicketId !== undefined;
  if (!hasNative && !hasFs) return null;
  const ref = ticketDisplayRef(ticket);
  return ref && ref.startsWith('TP-ID-') ? null : ref;
}

/** The subject of a sentence: "TP-1043", "Ticket #250001" or "A ticket". */
export function ticketSubjectWords(ticket) {
  const ref = notificationTicketRef(ticket);
  if (!ref) return 'A ticket';
  return ref.startsWith('#') ? `Ticket ${ref}` : ref;
}

/** Read aloud: "T P 1043" for a Ticket Pulse ticket, "number 250001" for a FreshService one. */
export function spokenTicketRef(ticket) {
  const ref = notificationTicketRef(ticket);
  return ref ? ref.replace(/^TP-/, 'T P ').replace(/^#/, 'number ') : null;
}

export default {
  freshserviceTicketLink,
  ticketAppLink,
  notificationTicketLink,
  notificationTicketRef,
  ticketSubjectWords,
  spokenTicketRef,
};
