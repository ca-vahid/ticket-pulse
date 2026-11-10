/**
 * Meeting invites in a ticket mailbox (QA 11-09 #8).
 *
 * A calendar invite (or a reply to one: Accepted / Declined / Tentative /
 * Canceled) is not a request. Filed as a ticket, its attendee list became the
 * ticket's Cc, and every update mailed all of them. The rule:
 *   - a plain invite or response → no ticket; the ingest records it as skipped
 *     (reason 'meeting_invite') so a person can still turn it into one;
 *   - a forward of an invite where the forwarder wrote something above the
 *     forwarded header → a ticket as usual, but the invite's attendees are
 *     never carried into its Cc (only what the forwarder Cc'd).
 *
 * Signals, strongest first: Graph's `@odata.type` (eventMessage /
 * eventMessageRequest / eventMessageResponse, present on every derived item a
 * message list returns), `meetingMessageType` when Graph sent it, the
 * `Content-Class: urn:content-classes:calendarmessage` header, then the
 * subject prefixes Outlook and Google Calendar put on invite mail.
 * Pure: no I/O.
 */
import { parseForwardedMail } from './forwardedMailParser.js';

const GRAPH_EVENT_TYPES = new Set([
  '#microsoft.graph.eventmessage',
  '#microsoft.graph.eventmessagerequest',
  '#microsoft.graph.eventmessageresponse',
]);

const FORWARD_RE = /^\s*(?:\[[^\]]{1,40}\]\s*)?(?:fw|fwd)\s*:/i;
// After any FW:/Fwd: chain — never after RE: (a reply in a thread that merely quotes "Accepted:").
const INVITE_SUBJECT_RE = /^\s*(?:(?:\[[^\]]{1,40}\]\s*)?(?:fw|fwd)\s*:\s*)*(invitation|updated invitation(?: with note)?|invitation updated|accepted|declined|tentative(?:ly accepted)?|canceled(?: event)?|cancelled(?: event)?|new time proposed|meeting forward notification)\s*:/i;

// Divider lines a mail client writes between the forwarder's words and the original.
const DIVIDER_RE = /^\s*(?:-{2,}\s*(?:original appointment|original message|forwarded message|forwarded appointment|weitergeleitete nachricht)\s*-{2,}|_{5,}|-{5,})\s*$/i;
const BOILERPLATE_RE = /^\s*(?:sent from my \w+.*|get outlook for \w+.*)$/i;

function kindFromSubject(word) {
  const w = String(word || '').toLowerCase();
  if (w.startsWith('accepted') || w.startsWith('declined') || w.startsWith('tentative') || w.startsWith('new time')) return 'response';
  if (w.startsWith('cancel')) return 'cancellation';
  return 'request';
}

function kindFromMeetingType(type) {
  const t = String(type || '').toLowerCase();
  if (!t || t === 'none') return null;
  if (t.includes('cancel')) return 'cancellation';
  if (t.includes('accept') || t.includes('declin') || t.includes('tenative') || t.includes('tentative')) return 'response';
  return 'request';
}

/**
 * Is this mail a meeting invite or a response to one?
 * → null, or { kind: 'request'|'response'|'cancellation', via, forwarded }.
 */
export function meetingMailSignal(email) {
  if (!email || typeof email !== 'object') return null;
  const subject = String(email.subject || '');
  const forwarded = FORWARD_RE.test(subject);
  const subjectHit = subject.match(INVITE_SUBJECT_RE);
  const byType = kindFromMeetingType(email.meetingMessageType);
  if (byType) return { kind: byType, via: 'meeting_message_type', forwarded };
  const graphType = String(email.graphType || '').toLowerCase();
  if (GRAPH_EVENT_TYPES.has(graphType)) {
    const kind = graphType.endsWith('response') ? 'response' : (subjectHit ? kindFromSubject(subjectHit[1]) : 'request');
    return { kind, via: 'graph_type', forwarded };
  }
  if (/calendarmessage/i.test(String(email.contentClass || ''))) {
    return { kind: subjectHit ? kindFromSubject(subjectHit[1]) : 'request', via: 'content_class', forwarded };
  }
  // Subject alone is weak ("Declined: card payment", "Canceled: order 1234" reach AP every week):
  // it counts only with a calendar body to go with it.
  if (subjectHit && looksLikeCalendarBody(email)) return { kind: kindFromSubject(subjectHit[1]), via: 'subject', forwarded };
  return null;
}

const CALENDAR_BODY_RE = /(microsoft teams meeting|teams\.microsoft\.com\/l\/meetup-join|join (?:the )?(?:teams )?meeting now|invitation from google calendar|meet\.google\.com\/|zoom\.us\/j\/|webex\.com\/(?:meet|join)|has (?:accepted|declined|tentatively accepted) this invitation|BEGIN:VCALENDAR)/i;

function looksLikeCalendarBody(email) {
  const text = `${email?.bodyText || ''}\n${email?.bodyHtml || ''}\n${email?.bodyPreview || ''}`;
  if (CALENDAR_BODY_RE.test(text)) return true;
  return /(^|[\s>])when\s*:/i.test(text) && /(^|[\s>])where\s*:/i.test(text);
}

/** The forwarder's own words: the note above the header, minus dividers and phone signatures. */
export function forwarderWords(noteText) {
  return String(noteText || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !DIVIDER_RE.test(line) && !BOILERPLATE_RE.test(line))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasRealText(words) {
  const letters = (String(words).match(/\p{L}/gu) || []).length;
  const tokens = String(words).split(/\s+/).filter((t) => /\p{L}/u.test(t));
  return letters >= 8 && tokens.length >= 2;
}

/**
 * What to do with a meeting mail. → null when it is not one, else
 *   { action: 'skip'|'create', kind, via, forwarded, reason, attendees: string[] }
 * `attendees` = the forwarded invite's To/Cc (from the quoted header block),
 * lowercased; the ingest keeps them out of the ticket's Cc.
 */
export function judgeMeetingMail(email) {
  const signal = meetingMailSignal(email);
  if (!signal) return null;
  const base = { kind: signal.kind, via: signal.via, forwarded: signal.forwarded, attendees: [] };
  if (!signal.forwarded) return { ...base, action: 'skip', reason: 'plain_invite' };
  const parsed = parseForwardedMail({ html: email.bodyHtml || null, text: email.bodyText || null, subject: email.subject || null });
  const attendees = [...new Set([...(parsed.original?.to || []), ...(parsed.original?.cc || [])]
    .map((a) => String(a?.email || '').trim().toLowerCase())
    .filter((a) => a.includes('@')))];
  // No header block: the forwarder's words cannot be told apart from the invite → not a ticket.
  if (!parsed.hasHeaderBlock) return { ...base, attendees, action: 'skip', reason: 'forward_unsplit' };
  const words = forwarderWords(parsed.noteText);
  if (!hasRealText(words)) return { ...base, attendees, action: 'skip', reason: 'forward_without_text' };
  return { ...base, attendees, action: 'create', reason: 'forward_with_text' };
}

export default { meetingMailSignal, judgeMeetingMail, forwarderWords };
