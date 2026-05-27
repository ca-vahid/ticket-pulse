import { ValidationError } from '../utils/errors.js';

export const PRIORITY_LABEL_TO_ID = Object.freeze({
  Low: 1,
  Medium: 2,
  High: 3,
  Urgent: 4,
});

export const PRIORITY_ID_TO_LABEL = Object.freeze(
  Object.fromEntries(Object.entries(PRIORITY_LABEL_TO_ID).map(([label, id]) => [id, label])),
);

export const PRIORITY_OUTPUT_MARKER = 'PRIORITY_OUTPUT_V1';

const PRIORITY_ALIASES = Object.freeze({
  low: 'Low',
  p1: 'Low',
  '1': 'Low',
  medium: 'Medium',
  normal: 'Medium',
  p2: 'Medium',
  '2': 'Medium',
  high: 'High',
  p3: 'High',
  '3': 'High',
  urgent: 'Urgent',
  critical: 'Urgent',
  emergency: 'Urgent',
  p4: 'Urgent',
  '4': 'Urgent',
});

const CONFIDENCE_VALUES = new Set(['low', 'medium', 'high']);

export function normalizePriority(value) {
  const key = String(value ?? '').trim().toLowerCase();
  const label = PRIORITY_ALIASES[key];
  if (!label) {
    throw new ValidationError('assessedPriority must be one of Low, Medium, High, or Urgent');
  }
  return {
    label,
    id: PRIORITY_LABEL_TO_ID[label],
  };
}

export function normalizePriorityConfidence(value) {
  const confidence = String(value ?? '').trim().toLowerCase();
  if (!CONFIDENCE_VALUES.has(confidence)) {
    throw new ValidationError('priorityConfidence must be low, medium, or high');
  }
  return confidence;
}

function normalizeEvidence(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : entry))
      .filter((entry) => entry && (typeof entry !== 'string' || entry.length > 0))
      .slice(0, 20);
  }
  if (typeof value === 'object') return value;
  const text = String(value).trim();
  return text ? [text] : null;
}

export function normalizePriorityAssessment(payload = {}) {
  const priority = normalizePriority(payload.assessedPriority);
  const rationale = String(payload.priorityRationale || '').trim();
  if (!rationale) {
    throw new ValidationError('priorityRationale is required');
  }

  return {
    assessedPriority: priority.label,
    assessedPriorityId: priority.id,
    priorityRationale: rationale.slice(0, 4000),
    priorityConfidence: normalizePriorityConfidence(payload.priorityConfidence),
    priorityEvidence: normalizeEvidence(payload.prioritySignals ?? payload.priorityEvidence),
  };
}

export function validateRecommendationPriorityFields(payload = {}) {
  normalizePriorityAssessment(payload);
  return true;
}

export function buildPriorityTicketUpdateFields(payload, sourceRunId, assessedAt = new Date()) {
  const assessment = normalizePriorityAssessment(payload);
  return {
    assessedPriority: assessment.assessedPriority,
    assessedPriorityId: assessment.assessedPriorityId,
    priorityRationale: assessment.priorityRationale,
    priorityConfidence: assessment.priorityConfidence,
    priorityEvidence: assessment.priorityEvidence,
    priorityAssessedAt: assessedAt,
    priorityAssessedByRunId: sourceRunId,
  };
}

export function priorityMeetsThreshold(priority, threshold = 'high_urgent') {
  if (threshold === 'disabled') return false;
  const normalized = normalizePriority(priority);
  if (threshold === 'urgent_only') return normalized.id >= PRIORITY_LABEL_TO_ID.Urgent;
  return normalized.id >= PRIORITY_LABEL_TO_ID.High;
}
