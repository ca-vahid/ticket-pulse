import { ValidationError } from '../utils/errors.js';

export const FRESHSERVICE_TICKET_TYPES = Object.freeze(['Incident', 'Service Request']);

const TICKET_TYPE_ALIASES = Object.freeze({
  incident: 'Incident',
  incidents: 'Incident',
  issue: 'Incident',
  outage: 'Incident',
  'service request': 'Service Request',
  service_request: 'Service Request',
  servicerequest: 'Service Request',
  request: 'Service Request',
  requests: 'Service Request',
  sr: 'Service Request',
});

const CONFIDENCE_VALUES = new Set(['low', 'medium', 'high']);

export function normalizeTicketType(value) {
  const key = String(value ?? '').trim().toLowerCase();
  const label = TICKET_TYPE_ALIASES[key];
  if (!label) {
    throw new ValidationError('ticketType must be Incident or Service Request');
  }
  return label;
}

export function normalizeTicketTypeConfidence(value) {
  if (value === undefined || value === null || value === '') return null;
  const confidence = String(value).trim().toLowerCase();
  if (!CONFIDENCE_VALUES.has(confidence)) {
    throw new ValidationError('ticketTypeConfidence must be low, medium, or high');
  }
  return confidence;
}

export function normalizeTicketTypeAssessment(payload = {}) {
  const rawType = payload.ticketType ?? payload.assessedTicketType;
  if (rawType === undefined || rawType === null || String(rawType).trim() === '') {
    return null;
  }

  const ticketType = normalizeTicketType(rawType);
  const rationale = String(payload.ticketTypeRationale || payload.ticketTypeReasoning || '').trim();

  return {
    assessedTicketType: ticketType,
    ticketTypeRationale: rationale ? rationale.slice(0, 4000) : null,
    ticketTypeConfidence: normalizeTicketTypeConfidence(payload.ticketTypeConfidence),
  };
}

export function validateRecommendationTicketTypeFields(payload = {}) {
  normalizeTicketTypeAssessment(payload);
  return true;
}

export function buildTicketTypeTicketUpdateFields(payload, sourceRunId, assessedAt = new Date()) {
  const assessment = normalizeTicketTypeAssessment(payload);
  if (!assessment) return null;

  return {
    assessedTicketType: assessment.assessedTicketType,
    ticketTypeRationale: assessment.ticketTypeRationale,
    ticketTypeConfidence: assessment.ticketTypeConfidence,
    ticketTypeAssessedAt: assessedAt,
    ticketTypeAssessedByRunId: sourceRunId,
  };
}
