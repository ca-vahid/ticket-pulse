/**
 * Who wrote an incoming message, relative to THIS ticket (QA 11-24 #7/#8).
 *
 * A reply from the person a ticket was forwarded to arrives like any other
 * incoming mail, and was labelled "From requester" with a REQUESTER tag while
 * the composer's "Reply to requester" went to someone else. The label now
 * says what the sender is: the requester, the person we forwarded the ticket
 * to, someone on Cc, or someone else. E-mails are compared case-insensitively.
 */

/** The bare lower-case address in "Name <a@b.c>" or "a@b.c"; '' when none. */
export function bareEmail(value) {
  const match = String(value || '').match(/[^\s<>"',;]+@[^\s<>"',;]+/);
  return match ? match[0].toLowerCase() : '';
}

const listOf = (v) => (Array.isArray(v) ? v : []);

/**
 * Addresses this ticket was forwarded to: the recipients of its forward
 * entries. A "Reply to <name>" entry is stored as a forward too, but answering
 * someone does not make them a forward recipient.
 */
export function forwardRecipientsOf(entries) {
  const out = new Set();
  for (const e of entries || []) {
    if (e?.eventType !== 'forward') continue;
    const raw = e.rawPayload && typeof e.rawPayload === 'object' ? e.rawPayload : {};
    if (raw.directReply) continue;
    for (const address of [...listOf(raw.forwardTo), ...listOf(raw.to_emails)]) {
      const bare = bareEmail(address);
      if (bare) out.add(bare);
    }
  }
  return out;
}

/** Addresses copied on this ticket: its "Also for" / Cc lists and any message's Cc. */
export function ccAddressesOf(ticket, entries) {
  const out = new Set();
  for (const address of [...listOf(ticket?.ccEmails), ...listOf(ticket?.replyCcEmails)]) {
    const bare = bareEmail(address);
    if (bare) out.add(bare);
  }
  for (const e of entries || []) {
    for (const address of listOf(e?.rawPayload?.cc_emails)) {
      const bare = bareEmail(address);
      if (bare) out.add(bare);
    }
  }
  return out;
}

export const AUTHOR_ROLES = Object.freeze({
  requester: { kind: 'requester', badge: 'From requester', avatarLabel: 'Requester' },
  forwardee: { kind: 'forwardee', badge: 'Reply to your forward', avatarLabel: 'Forwarded to' },
  cc: { kind: 'cc', badge: 'From someone on Cc', avatarLabel: 'Cc' },
  other: { kind: 'other', badge: 'Not the requester', avatarLabel: 'Contact' },
});

/**
 * The role of an incoming message's author on this ticket. A message with no
 * sender address (some FreshService history) or a ticket with no requester
 * address keeps the old "requester" reading: there is nothing to compare.
 */
export function incomingAuthorRole(entry, { requesterEmail = '', forwardRecipients = null, ccAddresses = null } = {}) {
  const author = bareEmail(entry?.actorEmail);
  const requester = bareEmail(requesterEmail);
  if (!author || !requester) return AUTHOR_ROLES.requester;
  if (author === requester) return AUTHOR_ROLES.requester;
  // Sent on the requester's behalf (a delegate or shared mailbox).
  if (bareEmail(entry?.rawPayload?.onBehalfOf?.email) === requester) return AUTHOR_ROLES.requester;
  if (forwardRecipients?.has?.(author)) return AUTHOR_ROLES.forwardee;
  if (ccAddresses?.has?.(author)) return AUTHOR_ROLES.cc;
  return AUTHOR_ROLES.other;
}

/** "Jordan" from "Jordan Example"; the address when there is no usable name. */
export function senderFirstName(entry) {
  const name = String(entry?.actorName || '').trim();
  if (name && !name.includes('@')) return name.split(/\s+/)[0];
  return bareEmail(entry?.actorEmail) || name || 'them';
}

/**
 * The subject a reply to this person goes out with, as the server builds it:
 * "Re: FW: <subject> [TP-n]" for someone the ticket was forwarded to (the
 * subject their reply came back with), else the ticket's own reply subject.
 */
export function participantReplySubject(ticket, { wasForwardedTo = false } = {}) {
  if (wasForwardedTo) return `Re: FW: ${ticket?.subject || 'Ticket'} [${ticket?.displayRef || ''}]`;
  return ticket?.replySubjectDefault || `Re: ${ticket?.subject || 'Ticket'} [${ticket?.displayRef || ''}]`;
}
