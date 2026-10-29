/**
 * Closing an approval without a decision (29 Oct 2026, Vahid). Some requests
 * are neither a yes nor a no: the requester says they no longer need it, or
 * IT handles it another way. "Not approved" read like a refusal and sent the
 * agent the wrong message, so the approver closes the approval instead: the
 * row ends as status 'closed' with one of these reasons, the ticket stays
 * open, and the agent is told to carry on.
 */
export const CLOSE_REASONS = Object.freeze({
  not_needed: 'No longer needed',
  handled_otherwise: 'Handled another way',
  duplicate: 'Duplicate request',
  other: 'Other',
});

/** The reason key, or null when it is not one of ours. */
export function normalizeCloseReason(value) {
  const key = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(CLOSE_REASONS, key) ? key : null;
}

/** "No longer needed" — the label people read; a plain fallback for old or unknown values. */
export function closeReasonLabel(value) {
  return CLOSE_REASONS[normalizeCloseReason(value)] || 'Closed without a decision';
}

/** "Closed: no longer needed" — the verdict word, as subject lines and notes use it. */
export function closedVerdictWord(value) {
  const key = normalizeCloseReason(value);
  return key && key !== 'other' ? `Closed: ${CLOSE_REASONS[key].toLowerCase()}` : 'Closed';
}

export default { CLOSE_REASONS, normalizeCloseReason, closeReasonLabel, closedVerdictWord };
