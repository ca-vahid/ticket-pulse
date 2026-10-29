/**
 * Closing an approval without a decision (29 Oct 2026, Vahid) — the same
 * reasons as backend/src/utils/approvalCloseReasons.js. Neither a yes nor a
 * no: the approval ends as status 'closed', the ticket stays open, and the
 * agent is told to carry on.
 */
export const CLOSE_REASON_OPTIONS = [
  { key: 'not_needed', label: 'No longer needed' },
  { key: 'handled_otherwise', label: 'Handled another way' },
  { key: 'duplicate', label: 'Duplicate request' },
  { key: 'other', label: 'Other' },
];

/** "No longer needed" — a plain fallback for rows closed before reasons existed. */
export function closeReasonLabel(key) {
  return CLOSE_REASON_OPTIONS.find((r) => r.key === key)?.label || 'Closed without a decision';
}

/** "Closed: no longer needed" — the status as a list or a card says it. */
export function closedWords(key) {
  const hit = CLOSE_REASON_OPTIONS.find((r) => r.key === key);
  return hit && hit.key !== 'other' ? `Closed: ${hit.label.toLowerCase()}` : 'Closed';
}
