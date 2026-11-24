/**
 * Same requester, same problem, same day — the rules (QA 11-23 items 4 and 5).
 *
 * TP-1042 ("can't sign into Teams", 9:47 AM) went to Eli Park; at 10:15 AM the
 * same person wrote again ("Lost access to Teams again") and that ticket went
 * to Dana Fox while the first still sat open with Eli. The AI itself said one
 * technician should hold both.
 *
 *   - Related ticket: same requester, still open, created the same local
 *     (Pacific) day BEFORE this one, not this ticket, and the same problem —
 *     the same subcategory and one shared meaningful word, or close words
 *     (subject, or embedded text) otherwise. Never a ticket a machine made
 *     (workflow, API, trusted intake, alert, service mailbox), never one
 *     linked to the other, never for a requester with more than 3 tickets
 *     that day.
 *   - Follow-up routing (setting `followup_routing_ws<N>`: off | shadow | live,
 *     off by default): Shadow records "Would send to <owner>"; Live gives the
 *     ticket to the related ticket's owner when they are at work and not away,
 *     and leaves a private note suggesting a merge.
 *   - Repeat report: the new ticket's priority goes one level above what the
 *     AI chose (Urgent at most, never down), whatever the routing mode —
 *     but High at most outside business hours, so a repeat never pages on-call.
 *
 * Pure: no database, no clock of its own.
 */
import { normalizeSubject } from '../duplicateBurstService.js';
import { ticketDisplayRef } from '../../utils/ticketOrigin.js';
import { applyPatch as levelApplyPatch, toStored as levelToStored } from '../assignmentLevelMatch/rules.js';

export const MODES = Object.freeze(['off', 'shadow', 'live']);
export const HISTORY_LIMIT = 30;
export const PRIORITY_LADDER = Object.freeze(['Low', 'Medium', 'High', 'Urgent']);
/** Token overlap (Dice) at or above this makes two subjects "close". */
export const SUBJECT_SIMILARITY_MIN = 0.6;
/** Embedding cosine at or above this makes two tickets "close" when both are embedded. */
export const TEXT_SIMILARITY_MIN = 0.85;

export const OUTCOMES = Object.freeze({
  ROUTED: 'routed',               // Live: given to the related ticket's owner
  WOULD_ROUTE: 'would_route',     // Shadow (or Live that could not act): who it would go to
  ALREADY_THERE: 'already_there', // the AI's pick already owns the related ticket
  OWNER_UNAVAILABLE: 'owner_unavailable', // the owner is off shift, away, or cannot hold it
  NO_OWNER: 'no_owner',           // the related ticket has nobody on it
});

export function defaultSettings() {
  return { mode: 'off' };
}

/**
 * Whatever was stored → a complete settings object. Accepts the Level match
 * JSON shape ({"mode":"shadow",…}) and a bare "shadow" / "live" string.
 */
export function normalizeSettings(raw) {
  const base = defaultSettings();
  let stored = raw;
  if (typeof raw === 'string') {
    const bare = raw.trim().replace(/^"|"$/g, '').toLowerCase();
    if (MODES.includes(bare)) stored = { mode: bare };
    else {
      try { stored = JSON.parse(raw); } catch { stored = null; }
    }
  }
  if (typeof stored === 'string' && MODES.includes(stored)) stored = { mode: stored };
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = {};
  return {
    mode: MODES.includes(stored.mode) ? stored.mode : base.mode,
    persisted: Object.keys(stored).length > 0,
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
    updatedBy: typeof stored.updatedBy === 'string' ? stored.updatedBy : null,
    history: Array.isArray(stored.history) ? stored.history.slice(0, HISTORY_LIMIT) : [],
  };
}

/** Same patch rules as Level match: mode only, with a history line. */
export const applyPatch = levelApplyPatch;
export const toStored = levelToStored;

/**
 * Generic ticket words: they say something is wrong, not WHAT (coordinator,
 * 23 Nov). Never counted as a shared content word. Matched after the light
 * plural stem, so "errors" → "error" is covered.
 */
export const GENERIC_TICKET_WORDS = Object.freeze([
  'cant', 'can', 'cannot', 'unable', 'help', 'issue', 'problem', 'request', 'again', 'please', 'urgent', 'asap', 'not',
  'working', 'work', 'access', 'lost', 'error', 'need', 'needed', 'new', 'broken', 'fail', 'failed', 'failing', 'still',
  'question', 'support', 'ticket', 'fix', 'trouble',
]);

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'has', 'into', 'onto', 'my', 'our', 'your', 'off', 'out',
  'fw', 'fwd', 're', 'its', 'it', 'is', 'are', 'was', 'any', 'all', 'some', 'get', 'got', 'now', 'today', 'when', 'what',
  ...GENERIC_TICKET_WORDS,
]);

/** Plural → singular, lightly ("passwords" → "password", "access" stays). */
const stem = (w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

/** Content words of a subject, normalized the way duplicate-burst does. */
export function subjectTokens(subject) {
  return [...new Set(normalizeSubject(subject).split(' ')
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map(stem)
    .filter((w) => !STOP.has(w)))];
}

/** Meaningful content words two subjects share (stop words and generic ticket words left out). */
export function sharedContentWords(a, b) {
  const y = new Set(subjectTokens(b));
  return subjectTokens(a).filter((w) => y.has(w));
}

/** Dice overlap of two subjects' content words, 0…1. */
export function subjectSimilarity(a, b) {
  const x = subjectTokens(a);
  const y = new Set(subjectTokens(b));
  if (!x.length || !y.size) return 0;
  const shared = x.filter((w) => y.has(w)).length;
  return (2 * shared) / (x.length + y.size);
}

const id = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Is `other` the same problem as `ticket`? A shared subcategory or category
 * alone is never enough (second-look review, 23 Nov): one person can have a
 * Teams licence request and a Teams sign-in problem the same day.
 *   - Same subcategory: at least one shared meaningful content word (generic
 *     ticket words like "can't", "access", "lost" do not count), or close
 *     words / text as below (coordinator, 23 Nov).
 *   - Category-only or no category: subject words at SUBJECT_SIMILARITY_MIN,
 *     or (both tickets already embedded) text at TEXT_SIMILARITY_MIN.
 * `matchedOn` says what agreed: the subcategory, the category (when one side
 * has no subcategory), or nothing but the words ('subject' / 'text').
 * @returns {null | { matchedOn, similarity, textSimilarity, sharedWords }}
 */
export function sameProblem(ticket, other, { textSimilarity = null } = {}) {
  const subject = subjectSimilarity(ticket?.subject, other?.subject);
  const text = Number.isFinite(textSimilarity) ? textSimilarity : null;
  const wordsClose = subject >= SUBJECT_SIMILARITY_MIN;
  const textClose = text !== null && text >= TEXT_SIMILARITY_MIN;
  const sa = id(ticket?.internalSubcategoryId);
  const sb = id(other?.internalSubcategoryId);
  const ca = id(ticket?.internalCategoryId);
  const cb = id(other?.internalCategoryId);
  const sharedWords = sharedContentWords(ticket?.subject, other?.subject);
  const base = {
    similarity: round2(wordsClose || !textClose ? subject : text),
    textSimilarity: text === null ? null : round2(text),
    sharedWords,
  };
  if (sa && sb && sa === sb) {
    return sharedWords.length || wordsClose || textClose ? { matchedOn: 'subcategory', ...base } : null;
  }
  if (!wordsClose && !textClose) return null;
  // Same category counts only when one side has no subcategory: two different
  // subcategories under one parent are two different problems.
  if (ca && cb && ca === cb && !(sa && sb)) return { matchedOn: 'category', ...base };
  return { matchedOn: wordsClose ? 'subject' : 'text', ...base };
}

/** Requesters with more tickets than this in one day are automation, not a person reporting again. */
export const MAX_REQUESTER_TICKETS_PER_DAY = 3;

const SERVICE_MAILBOX = /^(no-?reply|do-?not-?reply|alerts?|alerting|monitor(ing)?|notifications?|notify|system|daemon|mailer-daemon|postmaster|automation|bot|svc|service)([._+-]|\d|@|$)/i;

/** A mailbox that is a machine, not a person (no-reply@, alerts@, svc-backup@…). */
export function isServiceMailbox(email) {
  const local = String(email || '').trim().toLowerCase();
  return Boolean(local) && SERVICE_MAILBOX.test(local);
}

const MACHINE_KINDS = new Set(['workflow', 'api']);

/**
 * Was this ticket made by a machine rather than reported by a person? Reads
 * the ticket row and its `created` activity row (null for FS-born tickets).
 * Mail intake ("Ticket Pulse Mail") is a person writing in, so it is not.
 * @returns {string|null} the reason, or null for a person's ticket
 */
export function machineCreatedReason(ticket, createdRow = null) {
  if (!ticket) return 'missing';
  if (ticket.triageMode === 'trusted') return 'trusted_intake';
  if (Number(ticket.occurrenceCount) > 0) return 'alert';
  if (isServiceMailbox(ticket.requester?.email)) return 'service_mailbox';
  const d = createdRow?.details && typeof createdRow.details === 'object' ? createdRow.details : {};
  if (MACHINE_KINDS.has(d.actorKind)) return d.actorKind;
  if (d.createdVia === 'api') return 'api';
  const email = String(d.actorEmail || '').toLowerCase();
  if (email.endsWith('@ticketpulse.internal') && email !== 'mailbox@ticketpulse.internal') return 'automation';
  if (/^ticket pulse \(/i.test(String(createdRow?.performedBy || ''))) return 'automation';
  if (/^notification workflow$|^ticket workflow$/i.test(String(createdRow?.performedBy || ''))) return 'workflow';
  return null;
}

/** "TP-1042" for a TP-born ticket, "#123456" for an FS-born one (utils/ticketOrigin). */
export function ticketRef(t) {
  return t ? ticketDisplayRef(t) : null;
}

/** One level up the ladder, Urgent at most. Unknown → null (nothing to raise). */
export function raisedPriority(label) {
  const i = PRIORITY_LADDER.findIndex((p) => p.toLowerCase() === String(label || '').trim().toLowerCase());
  if (i === -1) return null;
  return PRIORITY_LADDER[Math.min(i + 1, PRIORITY_LADDER.length - 1)];
}

export function priorityId(label) {
  const i = PRIORITY_LADDER.indexOf(label);
  return i === -1 ? null : i + 1;
}

/** The run's sentence for follow-up routing. */
export function routingSentence({ outcome, ownerName, ref, reason = null }) {
  const who = ownerName || 'the owner';
  const SENTENCES = {
    [OUTCOMES.ROUTED]: `Sent to ${who}: same problem as ${ref} reported today.`,
    [OUTCOMES.WOULD_ROUTE]: `Would send to ${who}: same problem as ${ref} reported today.`,
    [OUTCOMES.ALREADY_THERE]: `Same problem as ${ref} reported today; ${who} already has both.`,
    [OUTCOMES.OWNER_UNAVAILABLE]: `Same problem as ${ref} reported today; not sent to ${who} (${reason || 'not available'}).`,
    [OUTCOMES.NO_OWNER]: `Same problem as ${ref} reported today; that ticket has nobody on it yet.`,
  };
  return SENTENCES[outcome] || null;
}

/** The private note on the new ticket (Live routing only). */
export function mergeNote({ ref, subject, ownerName }) {
  const what = subject ? ` ("${String(subject).slice(0, 120)}")` : '';
  return `Same requester, same problem, same day: ${ref}${what} is still open with ${ownerName || 'its owner'}, so this ticket went to them too. Consider merging this ticket into ${ref}.`;
}
