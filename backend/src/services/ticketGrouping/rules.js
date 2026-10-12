/**
 * Ticket grouping — the pure rules (plans/TICKET_GROUPING_PLAN.md).
 *
 * Two kinds of "this is not a new problem":
 *   repeat     the same sender says the same thing again while the first ticket
 *              is still open (a backup that fails every hour). Decided by a
 *              KEY, never by a model: sender + subject with only the parts that
 *              change from mail to mail masked.
 *   duplicate  a person's second ticket about the same request (a second
 *              channel, a follow-up sent as a new mail). Decided by a model
 *              that reads a short list of candidates.
 *
 * Nothing here touches the database.
 */

export const MODES = Object.freeze(['off', 'on']);
export const SENDER_KINDS = Object.freeze(['repeating', 'distinct', 'unsure']);
export const RELATIONS = Object.freeze(['same_request', 'update', 'related', 'unrelated']);
export const CONFIDENCES = Object.freeze(['high', 'medium', 'low']);
export const EVENT_KINDS = Object.freeze(['repeat', 'duplicate', 'update', 'related', 'checked']);
export const EVENT_STATES = Object.freeze(['applied', 'suggested', 'undone', 'dismissed', 'none']);

export const TERMINAL_STATUSES = Object.freeze(['Resolved', 'Closed', 'Deleted', 'Spam']);
export const MIN_KEY_LENGTH = 12;
/** How far back an open ticket still counts as "the one this repeats". */
export const ROOT_LOOKBACK_DAYS = 30;
export const CANDIDATE_WINDOW_DAYS = 14;
export const CLOSED_CANDIDATE_DAYS = 7;
export const NEIGHBOUR_MIN_SCORE = 0.78;
/** The repeat counts at which the open ticket gets a note (then every 100). */
export const REPEAT_NOTE_AT = Object.freeze([2, 10, 25, 50, 100]);

const MONTHS = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';

/**
 * The subject with only the parts that change between two mails about the
 * SAME thing masked: dates, clock times, long numbers, addresses, ids.
 * Server names keep their digits (BGC-EDM-FILE3 and BGC-EDM-DC3 are two
 * different problems), which is why short digit runs inside a word stay.
 */
export function fineKey(subject) {
  let s = String(subject || '').toLowerCase();
  s = s.replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '');
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<id>');
  s = s.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>');
  s = s.replace(/\b\d{4}-\d{1,2}-\d{1,2}(?:[t ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?z?)?\b/g, '<date>');
  s = s.replace(/\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g, '<date>');
  s = s.replace(new RegExp(`\\b\\d{1,2}\\s+${MONTHS}\\.?(?:\\s+\\d{4})?\\b`, 'g'), '<date>');
  s = s.replace(new RegExp(`\\b${MONTHS}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, 'g'), '<date>');
  s = s.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?(?:\s*(?:utc|gmt|pst|pdt|mst|mdt|est|edt))?/g, '<time> ');
  s = s.replace(/\b\d+(?:\.\d+)?\s*%/g, '<n>%');
  s = s.replace(/(^|[^a-z0-9-])#?\d{4,}(?![a-z0-9-])/g, '$1<n>');
  s = s.replace(/[^\p{L}\p{N}<>%#:./_-]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, 300);
}

/** The sender's kind of mail: the fine key with every digit run masked, so one card covers every server. */
export function coarseTemplate(subject) {
  return fineKey(subject).replace(/\d+/g, '#').slice(0, 300);
}

export const isTerminal = (status) => TERMINAL_STATUSES.includes(status);

/** A mail relayed by a robot on a person's behalf: who is it really from? */
export function relayedPerson(subject, senderEmail) {
  const email = String(senderEmail || '').toLowerCase();
  if (!/teams\.mail\.microsoft|teams\.microsoft\.com/.test(email)) return null;
  const m = /^\s*(.{3,80}?)\s+sent (?:you )?a message\b/i.exec(String(subject || ''));
  return m ? m[1].trim() : null;
}

/** An address nobody types from. People's tickets are judged by the model; these are not. */
export function looksAutomated(email) {
  return /(^|[._-])(no-?reply|do-?not-?reply|noreply|notifications?|alerts?|mailer|daemon|bounce|postmaster)([._+-]|@)|^(no-?reply|do-?not-?reply)@/i
    .test(String(email || ''));
}

export function normalizeSettings(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    mode: MODES.includes(r.mode) ? r.mode : 'off',
    // People's tickets: combine on our own when it is safe, or only suggest.
    peopleAuto: r.peopleAuto !== false,
  };
}

/** Should the open ticket get a "still repeating" note at this count? */
export function noteAtCount(count) {
  return REPEAT_NOTE_AT.includes(count) || (count > 100 && count % 100 === 0);
}

/**
 * What to do with the model's verdict on one candidate.
 *   combine  close the newer ticket into the older one (undo is one click)
 *   suggest  show it for a person to decide
 *   none
 * Automatic only when every one of these holds: the workspace allows it, the
 * model is sure, it is the same person (or a robot relaying that person), and
 * the older ticket is still open.
 */
export function decide(match, { peopleAuto = true, samePerson = false, candidateOpen = false } = {}) {
  if (!match || !RELATIONS.includes(match.relation) || match.relation === 'unrelated') return 'none';
  const confidence = CONFIDENCES.includes(match.confidence) ? match.confidence : 'low';
  if (match.relation === 'related') return confidence === 'high' ? 'suggest' : 'none';
  if (confidence === 'low') return 'none';
  if (peopleAuto && confidence === 'high' && samePerson && candidateOpen) return 'combine';
  return 'suggest';
}

/** The strongest verdict: same request before update before related, sure before unsure. */
export function bestMatch(matches = []) {
  const rank = (m) => (['same_request', 'update', 'related'].indexOf(m.relation) + 1 || 9) * 10 + (CONFIDENCES.indexOf(m.confidence) + 1 || 9);
  return [...matches].filter((m) => m && m.relation !== 'unrelated' && RELATIONS.includes(m.relation)).sort((a, b) => rank(a) - rank(b))[0] || null;
}

export function excerpt(text, max = 1200) {
  const clean = String(text || '').replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
