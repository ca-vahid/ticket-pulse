// Mirror of backend/src/services/resolutionReasonService.js (Simorgh C4, 09-14).
// The backend is the source of truth for validation; this list only drives the
// picker so the modal can render without a round trip.
export const RESOLUTION_REASONS = [
  { value: 'confirmed_threat_contained', label: 'Confirmed threat — contained', hint: 'It was real, and it has been dealt with.' },
  { value: 'false_positive', label: 'False positive', hint: 'The detection was wrong; nothing happened.' },
  { value: 'benign_expected', label: 'Benign / expected', hint: 'Real activity, but authorised or routine.' },
  { value: 'duplicate', label: 'Duplicate', hint: 'Already covered by another ticket.' },
  { value: 'needs_detection_tuning', label: 'Needs detection tuning', hint: 'Benign, and the rule should stop firing on it.' },
  { value: 'no_action_required', label: 'No action required', hint: 'Informational; nothing to do.' },
  { value: 'other', label: 'Other', hint: 'Say what in the note.' },
];

export const REASON_REQUIRED_CATEGORY = 'security';

export function reasonLabel(value) {
  return RESOLUTION_REASONS.find((r) => r.value === value)?.label || value || null;
}

/** A reason is demanded when the ticket's top-level category is Security. */
export function ticketNeedsResolutionReason(ticket) {
  const name = ticket?.internalCategory?.name || ticket?.internalCategoryName || '';
  return String(name).trim().toLowerCase() === REASON_REQUIRED_CATEGORY;
}
