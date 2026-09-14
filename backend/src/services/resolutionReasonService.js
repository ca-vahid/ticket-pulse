/**
 * Resolution reason (Simorgh C4 / D3, 09-14).
 *
 * When an agent resolves a Security-category ticket they say WHY, from a short
 * fixed list, optionally with a note. The list is the one Simorgh proposed and
 * we accepted verbatim: it is what the security agent reconciles the analyst's
 * conclusion against its own verdict with, and what it pushes back to Sentinel
 * and Defender. A free-text "closed, thanks" cannot be reconciled; one of seven
 * words can.
 *
 * Required only where it is meaningful — tickets whose TOP-LEVEL internal
 * category is Security. Everyone else's resolve flow is unchanged; the reason
 * is accepted there too, just never demanded.
 */
import { ValidationError } from '../utils/errors.js';

export const RESOLUTION_REASONS = Object.freeze([
  { value: 'confirmed_threat_contained', label: 'Confirmed threat — contained', hint: 'It was real, and it has been dealt with.' },
  { value: 'false_positive', label: 'False positive', hint: 'The detection was wrong; nothing happened.' },
  { value: 'benign_expected', label: 'Benign / expected', hint: 'Real activity, but authorised or routine.' },
  { value: 'duplicate', label: 'Duplicate', hint: 'Already covered by another ticket.' },
  { value: 'needs_detection_tuning', label: 'Needs detection tuning', hint: 'Benign, and the rule should stop firing on it.' },
  { value: 'no_action_required', label: 'No action required', hint: 'Informational; nothing to do.' },
  { value: 'other', label: 'Other', hint: 'Say what in the note.' },
]);

const VALUES = new Set(RESOLUTION_REASONS.map((r) => r.value));
export const RESOLUTION_NOTE_MAX = 4000;
export const REASON_REQUIRED_CATEGORY = 'security';

export function isResolutionReason(value) {
  return VALUES.has(String(value || ''));
}

export function reasonLabel(value) {
  return RESOLUTION_REASONS.find((r) => r.value === value)?.label || null;
}

/** Does this ticket's top-level category demand a reason on resolve? */
export function requiresResolutionReason(ticket) {
  const name = ticket?.internalCategory?.name || ticket?.internalCategoryName || null;
  return String(name || '').trim().toLowerCase() === REASON_REQUIRED_CATEGORY;
}

/**
 * Validate what a caller sent. Returns { resolutionReason, resolutionNote } —
 * both possibly null when nothing was sent and nothing was required.
 * Throws ValidationError with a stable `code` the API turns into a 400.
 */
export function validateResolution({ resolutionReason = null, resolutionNote = null } = {}, { required = false } = {}) {
  const reason = resolutionReason === undefined || resolutionReason === null || resolutionReason === ''
    ? null : String(resolutionReason).trim();
  const note = resolutionNote === undefined || resolutionNote === null ? null : String(resolutionNote).trim();

  if (reason && !isResolutionReason(reason)) {
    const err = new ValidationError(`Unknown resolution reason "${reason}". One of: ${[...VALUES].join(', ')}`);
    err.code = 'invalid_resolution_reason';
    throw err;
  }
  if (required && !reason) {
    const err = new ValidationError('A resolution reason is required to resolve or close a Security ticket');
    err.code = 'resolution_reason_required';
    err.details = { reasons: RESOLUTION_REASONS };
    throw err;
  }
  if (note && note.length > RESOLUTION_NOTE_MAX) {
    const err = new ValidationError(`Resolution note is longer than ${RESOLUTION_NOTE_MAX} characters`);
    err.code = 'resolution_note_too_long';
    throw err;
  }
  if (reason === 'other' && !note) {
    const err = new ValidationError('"Other" needs a note saying what');
    err.code = 'resolution_note_required';
    throw err;
  }
  return { resolutionReason: reason, resolutionNote: note || null };
}

/** Who resolved it, as a kind — the same vocabulary the lifecycle events use. */
export function resolvedByKindFromActor(actor) {
  const role = String(actor?.role || '').toLowerCase();
  if (role === 'api') return 'api';
  if (role === 'workflow') return 'workflow';
  if (role === 'automation' || role === 'system') return 'automation';
  return 'human';
}

export default {
  RESOLUTION_REASONS, isResolutionReason, reasonLabel, requiresResolutionReason, validateResolution, resolvedByKindFromActor,
};
