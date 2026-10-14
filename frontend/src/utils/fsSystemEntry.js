/**
 * Lines FreshService writes itself into a ticket's conversation feed, e.g.
 * "<Name> has submitted the survey response" (QA 10-13 #5). They are system
 * events: they belong on History, not in the Conversation as a message "From
 * requester".
 *
 * New rows carry `rawPayload.tpSystemKind` (set by the server when it stores
 * them). Rows stored before that fix are recognised by FreshService's own
 * feedback source code (5) or by a body that is nothing but the sentence.
 * Mirrors backend/src/utils/fsSystemConversation.js.
 */
const SURVEY_SENTENCE_RE = /^.{1,120}\bhas submitted the survey response\.?$/i;

const LABELS = { survey_response: 'Survey response submitted' };

export function fsSystemEntryKind(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const raw = entry.rawPayload && typeof entry.rawPayload === 'object' ? entry.rawPayload : {};
  if (raw.tpSystemKind) return String(raw.tpSystemKind);
  if (entry.isPrivate === true) return null;
  const source = String(entry.source || '');
  if (!source.startsWith('freshservice')) return null;
  if (Number(raw.source) === 5) return 'survey_response';
  const text = String(entry.bodyText || entry.content || '').replace(/\s+/g, ' ').trim();
  if (text && text.length <= 200 && SURVEY_SENTENCE_RE.test(text)) return 'survey_response';
  return null;
}

export function fsSystemEntryLabel(kind) {
  return LABELS[kind] || 'FreshService system entry';
}

export default { fsSystemEntryKind, fsSystemEntryLabel };
