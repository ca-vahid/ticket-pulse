/**
 * The plumbing every approval e-mail in the reply format shares (Vahid,
 * 26 Oct 2026): the "Earlier in this conversation" history, the sender's own
 * signature, and the plain-text twin. The words themselves are rendered in
 * approvalEmailTemplate.js; the model is approvalConversationService's
 * _emailAsReply (4.3.21).
 *
 * Everything here is best effort and never throws: a missing history or
 * signature costs that part of the e-mail, never the e-mail.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { textExcerpt } from './approvalEmailTemplate.js';

const lc = (v) => String(v || '').trim().toLowerCase();
const EMPTY = Object.freeze({ html: '', text: '', attachments: [] });

/** Requester-audience history keeps to what the model quotes; insiders see every message on the request. */
const REQUESTER_KINDS = ['question', 'answer', 'comment'];
const INTERNAL_KINDS = ['question', 'answer', 'comment', 'decision'];

/**
 * "Earlier in this conversation": the ticket's own public history plus the
 * request's approval messages, newest first, with photos and pictures inline.
 *
 *  - audience 'requester': only requester-audience messages (the requester
 *    may be on the e-mail); 'internal': every message — approvers and the
 *    agent are insiders.
 *  - skip(message) drops messages already in the e-mail's body.
 *  - requestNote { html, text, authorName, authorEmail, at } adds the agent's
 *    request to the history (for e-mails whose body does not carry it).
 *  - reply { text, authorName, authorEmail } is the message being sent, so a
 *    quoted copy of the same words is dropped.
 */
export async function approvalHistory({
  ticketId, requestGroupId = null, audience = 'internal', skip = null, reply = null, requestNote = null,
} = {}) {
  if (!ticketId) return EMPTY;
  try {
    const kinds = audience === 'requester' ? REQUESTER_KINDS : INTERNAL_KINDS;
    const rows = requestGroupId
      ? await Promise.resolve()
        .then(() => prisma.approvalMessage.findMany({
          where: { requestGroupId, ...(audience === 'requester' ? { audience: 'requester' } : {}) },
          orderBy: { id: 'asc' },
          take: 60,
        }))
        .catch(() => [])
      : [];
    const extra = (rows || [])
      .filter((m) => m && kinds.includes(m.kind) && (m.bodyText || m.bodyHtml))
      .filter((m) => audience !== 'requester' || m.audience === 'requester') // belt and braces
      .filter((m) => !(typeof skip === 'function' && skip(m)))
      .map((m) => ({
        actorName: m.authorName || null, actorEmail: m.authorEmail || null, occurredAt: m.createdAt,
        bodyHtml: m.bodyHtml || null, bodyText: m.bodyText || null, cc: m.ccEmails || [],
      }));
    if (requestNote && (requestNote.html || requestNote.text) && requestNote.at) {
      extra.push({
        actorName: requestNote.authorName || null, actorEmail: requestNote.authorEmail || null, occurredAt: requestNote.at,
        bodyHtml: requestNote.html || null, bodyText: requestNote.text || null, cc: [],
      });
    }
    const { default: ticketService } = await import('./ticketService.js');
    const { createInlineBudget, inlineAttachments } = await import('./replyEmailPictures.js');
    const budget = createInlineBudget();
    const quote = await ticketService._lastInboundQuote(ticketId, null, { reply, budget, extra });
    if (!quote) return EMPTY;
    return { html: quote.html || '', text: quote.text || '', attachments: inlineAttachments(budget) };
  } catch (err) {
    logger.debug(`Approval history skipped for ticket ${ticketId}: ${err.message}`);
    return EMPTY;
  }
}

/** The agent's request as a history entry (approvers are insiders; so is the agent). */
export function requestNoteEntry(approval, authorName = null) {
  if (!approval || !(approval.requestNoteHtml || approval.requestNote)) return null;
  return {
    html: approval.requestNoteHtml || null,
    text: approval.requestNote || null,
    authorName: authorName || null,
    authorEmail: lc(approval.requestedBy) || null,
    at: approval.createdAt || null,
  };
}

/** A person's saved signature as it would close their own reply; null without one. */
export async function savedSignatureHtml(workspaceId, email) {
  const address = lc(email);
  if (!address.includes('@')) return null;
  try {
    const sig = await import('./userSignatureService.js');
    const signature = await sig.getEnabledSignatureForSend(workspaceId, address);
    if (!signature) return null;
    if (typeof sig.appendSignatureToEmail === 'function') return sig.appendSignatureToEmail({ html: '', text: '' }, signature).html || null;
    return signature.html || null;
  } catch {
    return null;
  }
}

/** "Re: <subject> [<ref>]" — the subject the ticket's own mail carries, so it threads. */
export function replySubject(subject, ref) {
  const clean = String(subject || 'Your ticket').replace(/[\r\n]+/g, ' ').replace(/^\s*(re|fw|fwd)\s*:\s*/i, '').trim();
  return `Re: ${clean}${ref ? ` [${ref}]` : ''}`;
}

/** The plain-text twin of a rendered body; a link keeps its address: "label <https://…>". */
export function plainTextOf(html) {
  const withUrls = String(html || '').replace(/<a\b[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => {
    const words = label.replace(/<[^>]+>/g, '').replace(/&rarr;|→|&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    const url = href.replace(/&amp;/g, '&');
    return words && words !== url ? `${words} &lt;${url}&gt;` : url;
  });
  return textExcerpt(withUrls, Number.MAX_SAFE_INTEGER).text;
}

/** "<name> via Ticket Pulse" — the person's name on mail Ticket Pulse sends for them. */
export function viaTicketPulse(name, fallback = 'Ticket Pulse') {
  const n = String(name || '').trim();
  return n ? `${n} via Ticket Pulse` : fallback;
}

export default { approvalHistory, requestNoteEntry, savedSignatureHtml, replySubject, plainTextOf, viaTicketPulse };
