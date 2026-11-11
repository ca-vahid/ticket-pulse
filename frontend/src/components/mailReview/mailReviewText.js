import { PACIFIC } from '../../utils/ticketDates';

/**
 * Words for the Mail review page (plans/MAIL_TRIAGE_PLAN.md). Everything a
 * row says about a suggestion is built here so the Waiting row, the Details
 * panel, the Log and the result toast use the same sentence.
 */

export const MODE_WORD = { off: 'Off', shadow: 'Shadow', on: 'On' };
export const CONFIDENCE_WORDS = ['sure', 'likely', 'unsure'];
export const ACTION_WORD = { attach: 'Add to a ticket', create: 'New ticket', no_ticket: 'No ticket needed', unsure: 'Not sure' };
export const OUTCOME_WORD = {
  suggested: 'Waiting for a person',
  applied: 'Applied by the AI',
  accepted: 'Kept by a person',
  changed: 'Changed by a person',
  undone: 'Undone',
  failed: 'Failed',
  superseded: 'Judged again',
};

/** "249132" → "#249132"; "TP-11340" stays as it is. */
export function fmtRef(ticket) {
  const ref = String(ticket?.ref ?? ticket?.displayRef ?? ticket?.id ?? '').trim();
  if (!ref) return '';
  return /^\d+$/.test(ref) ? `#${ref}` : ref;
}

/** "27 Oct" in Pacific time (the year only when it is not this one). */
export function shortDay(value, now = new Date()) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const fmt = (date, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: PACIFIC, ...opts }).format(date);
  const year = fmt(d, { year: 'numeric' });
  return `${fmt(d, { day: 'numeric' })} ${fmt(d, { month: 'short' })}${year !== fmt(now, { year: 'numeric' }) ? ` ${year}` : ''}`;
}

export function isClosedTicket(ticket) {
  if (!ticket) return false;
  return Boolean(ticket.closedAt) || /closed|resolved/i.test(String(ticket.statusBase || ''));
}

/** "(Closed 27 Oct)" for a closed ticket, '' for an open one. */
export function closedNote(ticket) {
  if (!isClosedTicket(ticket)) return '';
  const word = ticket.status || 'Closed';
  const day = shortDay(ticket.closedAt);
  return `(${word}${day ? ` ${day}` : ''})`;
}

export const personName = (p) => (p ? p.name || p.email || '' : '');

/**
 * What else happens when the suggestion is applied, in words, so nobody
 * learns a side effect after clicking. The server's `effects` win; without
 * them the reopen flag is the one effect the contract always carries.
 */
export function suggestionEffects(s) {
  if (!s) return [];
  if (Array.isArray(s.effects) && s.effects.length) return s.effects.filter(Boolean).map(String);
  if (s.action !== 'attach' || !s.ticket) return [];
  if (s.reopen) return ['reopens it'];
  return isClosedTicket(s.ticket) ? ['leaves it closed'] : [];
}

/** May a person press Accept on this suggestion? */
export const isAcceptable = (s) => Boolean(s) && (
  (s.action === 'attach' && Boolean(s.ticket)) || s.action === 'create' || s.action === 'no_ticket'
);

/** Bulk accept takes only what the server takes: attach/create the AI is sure about. */
export const isSureBulk = (s) => Boolean(s) && s.confidence === 'sure'
  && ((s.action === 'attach' && Boolean(s.ticket)) || s.action === 'create');

/**
 * The suggestion as parts the row lays out: verb first, then the ticket, then
 * the consequence. `kind`: attach | create | no_ticket | unsure | none.
 */
export function describeSuggestion(s) {
  if (!s) return { kind: 'none', verb: 'No good match', ticket: null, effects: [], confidence: null };
  const base = { kind: s.action, ticket: null, closed: '', effects: suggestionEffects(s), confidence: s.confidence || null };
  if (s.action === 'attach' && s.ticket) return { ...base, verb: 'Add to', ticket: s.ticket, closed: closedNote(s.ticket) };
  if (s.action === 'create') {
    const who = personName(s.requester);
    return { ...base, verb: who ? `New ticket for ${who}` : 'New ticket' };
  }
  if (s.action === 'no_ticket') return { ...base, verb: 'No ticket needed' };
  // Not sure: the best guess is whatever the answer still carries.
  if (s.ticket) return { ...base, kind: 'unsure', verb: 'Not sure: best guess is to add to', ticket: s.ticket, closed: closedNote(s.ticket), effects: [] };
  const who = personName(s.requester);
  return { ...base, kind: 'unsure', verb: who ? `Not sure: best guess is a new ticket for ${who}` : 'Not sure', effects: [] };
}

/** The same suggestion as one plain sentence (Log, earlier judgements, screen readers). */
export function suggestionSentence(s) {
  const d = describeSuggestion(s);
  const ticket = d.ticket ? ` ${fmtRef(d.ticket)}` : '';
  const effects = d.effects.length ? `, ${d.effects.join(' and ')}` : '';
  return `${d.verb}${ticket}${effects}`;
}

/** A person's final answer on a log row: "Add to #12" / "New ticket" / "No ticket needed". */
export function finalSentence(row) {
  if (!row?.finalAction) return '';
  if (row.finalAction === 'attach') return `Add to ${fmtRef(row.finalTicket) || 'a ticket'}`;
  return ACTION_WORD[row.finalAction] || row.finalAction;
}

/** What just happened, for the toast and the live region. */
export function resultSentence(body, ticket) {
  if (body.action === 'attach') return `Added to ${fmtRef(ticket) || 'the ticket'}${body.reopen ? ' and reopened it' : ''}.`;
  if (body.action === 'create') return ticket ? `New ticket ${fmtRef(ticket)} made.` : 'New ticket made.';
  return 'Marked as no ticket needed.';
}

/** What a Done row says happened. */
export function resolutionSentence(r) {
  if (!r) return '';
  if (r.status === 'attached') return 'Added to';
  if (r.status === 'created') return 'New ticket';
  return 'No ticket needed';
}

/**
 * Who a new ticket is for when the AI named nobody: the first address on the
 * mail that is not on the viewer's own e-mail domain (the sender first, then
 * To, then Cc). Staff mail is "agent → outside person", so that is the person.
 */
export function defaultRequester(item, viewerEmail = '') {
  if (item?.suggestion?.requester?.email) return item.suggestion.requester.email;
  const domain = String(viewerEmail || '').split('@')[1]?.toLowerCase() || '';
  const all = [item?.from?.email, ...(item?.to || []), ...(item?.cc || [])].map((a) => String(a || '').trim().toLowerCase()).filter((a) => a.includes('@'));
  const outside = domain ? all.find((a) => a.split('@')[1] !== domain) : null;
  return outside || all[0] || '';
}

export const money = (n) => {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '';
  const v = Number(n);
  return v > 0 && v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
};

export const seconds = (ms) => (ms === null || ms === undefined || Number.isNaN(Number(ms)) ? '' : `${(Number(ms) / 1000).toFixed(1)} s`);

/** "People kept 92% of sure suggestions, 61 of 66" — '' when there is nothing to say yet. */
export function agreementSentence(last30) {
  if (!last30) return '';
  const kept = Number(last30.sureAccepted) || 0;
  const total = kept + (Number(last30.sureChanged) || 0);
  if (!total) return '';
  const pct = last30.agreementPct !== null && last30.agreementPct !== undefined ? Math.round(Number(last30.agreementPct)) : Math.round((kept / total) * 100);
  return `People kept ${pct}% of sure suggestions, ${kept} of ${total}`;
}
