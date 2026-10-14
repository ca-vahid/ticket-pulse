/**
 * FreshService writes a few lines of its own into a ticket's CONVERSATION feed
 * (not the activity feed) and marks them `incoming: true`, so they looked like
 * a message from the requester. The one seen in production is the satisfaction
 * survey: "<Name> has submitted the survey response" (conversation source 5,
 * no from_email). 13 Oct 2026, TP-1882: that line arrived on a closed ticket's
 * FreshService copy, was stored as a requester reply and the "Reopen on
 * requester reply" workflow reopened the ticket.
 *
 * These are system events: nobody wrote to the helpdesk. They must not be
 * stored as a requester reply, must not fire `ticket.reply_received`, must not
 * reopen, wake a parked ticket, or count as the requester answering Auto-help.
 *
 * Deliberately narrow: FreshService's own "feedback" source code, or a body
 * that is nothing but one of the known system sentences. A person who writes
 * "I filled in the survey response and it is still broken" is still a person.
 */

/** FreshService conversation `source` for a satisfaction-survey (feedback) entry. */
export const FS_CONVERSATION_SOURCE_FEEDBACK = 5;

/** Whole-body system sentences. Add a line here when FreshService grows another. */
const SYSTEM_SENTENCES = [
  { kind: 'survey_response', re: /^.{1,120}\bhas submitted the survey response\.?$/i },
];

function plainText(conversation) {
  const text = String(conversation?.body_text || conversation?.bodyText || '').trim()
    || String(conversation?.body || conversation?.bodyHtml || conversation?.content || '')
      .replace(/<[^>]*>/g, ' ');
  return text.replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * @param {object} conversation a FreshService conversation object (raw API
 *   shape), or a stored thread entry (bodyText / rawPayload).
 * @returns {null | 'survey_response'} the kind of system entry, or null for a
 *   real message.
 */
export function fsSystemConversationKind(conversation) {
  if (!conversation || typeof conversation !== 'object') return null;
  if (conversation.private === true || conversation.isPrivate === true) return null;
  const raw = conversation.rawPayload && typeof conversation.rawPayload === 'object' ? conversation.rawPayload : null;
  const sourceCode = conversation.source !== undefined && typeof conversation.source !== 'string'
    ? conversation.source
    : raw?.source;
  if (Number(sourceCode) === FS_CONVERSATION_SOURCE_FEEDBACK) return 'survey_response';
  const text = plainText(conversation);
  if (!text || text.length > 200) return null;
  for (const { kind, re } of SYSTEM_SENTENCES) {
    if (re.test(text)) return kind;
  }
  return null;
}

export function isFsSystemConversation(conversation) {
  return fsSystemConversationKind(conversation) !== null;
}

/** What the History line calls each kind. */
export const FS_SYSTEM_KIND_LABEL = Object.freeze({
  survey_response: 'Survey response submitted',
});

export default { fsSystemConversationKind, isFsSystemConversation, FS_SYSTEM_KIND_LABEL, FS_CONVERSATION_SOURCE_FEEDBACK };
