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
 *     the same subcategory, the same category when either has no
 *     subcategory, or a close subject.
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

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'has', 'not', 'cant', 'can', 'cannot', 'unable', 'again',
  'still', 'please', 'help', 'issue', 'issues', 'problem', 'request', 'urgent', 'asap', 'into', 'onto', 'my', 'our', 'your',
  'ticket', 'fw', 'fwd', 're', 'its', 'it', 'is', 'are', 'was', 'any', 'all', 'some', 'get', 'got', 'now', 'today',
]);

/** Plural → singular, lightly ("passwords" → "password", "access" stays). */
const stem = (w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

/** Content words of a subject, normalized the way duplicate-burst does. */
export function subjectTokens(subject) {
  return [...new Set(normalizeSubject(subject).split(' ')
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map(stem))];
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

/**
 * Is `other` the same problem as `ticket`?
 * @returns {null | { matchedOn: 'subcategory'|'category'|'subject'|'text', similarity?: number }}
 */
export function sameProblem(ticket, other, { textSimilarity = null } = {}) {
  const sa = id(ticket?.internalSubcategoryId);
  const sb = id(other?.internalSubcategoryId);
  const ca = id(ticket?.internalCategoryId);
  const cb = id(other?.internalCategoryId);
  if (sa && sb && sa === sb) return { matchedOn: 'subcategory' };
  // Same category counts only when one side has no subcategory: two different
  // subcategories under one parent are two different problems.
  if (ca && cb && ca === cb && !(sa && sb)) return { matchedOn: 'category' };
  const similarity = subjectSimilarity(ticket?.subject, other?.subject);
  if (similarity >= SUBJECT_SIMILARITY_MIN) return { matchedOn: 'subject', similarity: Math.round(similarity * 100) / 100 };
  if (Number.isFinite(textSimilarity) && textSimilarity >= TEXT_SIMILARITY_MIN) {
    return { matchedOn: 'text', similarity: Math.round(textSimilarity * 100) / 100 };
  }
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
