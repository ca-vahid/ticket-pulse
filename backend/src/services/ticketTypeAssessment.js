import { ValidationError } from '../utils/errors.js';
import ticketTypeService from './ticketTypeService.js';

const CONFIDENCE_VALUES = new Set(['low', 'medium', 'high']);

/**
 * Normalize a raw type value to the workspace's canonical type name using
 * the ticket-type registry (names + aliases, retired types allowed — an
 * assessment recorded before a retire must still resolve for write-back).
 */
export async function normalizeTicketType(value, workspaceId) {
  const key = String(value ?? '').trim();
  if (!key) throw new ValidationError('ticketType is required');
  return ticketTypeService.normalizeTypeName(workspaceId, key, { allowInactive: true });
}

export function normalizeTicketTypeConfidence(value) {
  if (value === undefined || value === null || value === '') return null;
  const confidence = String(value).trim().toLowerCase();
  if (!CONFIDENCE_VALUES.has(confidence)) {
    throw new ValidationError('ticketTypeConfidence must be low, medium, or high');
  }
  return confidence;
}

export async function normalizeTicketTypeAssessment(payload = {}, workspaceId) {
  const rawType = payload.ticketType ?? payload.assessedTicketType;
  if (rawType === undefined || rawType === null || String(rawType).trim() === '') {
    return null;
  }

  const ticketType = await normalizeTicketType(rawType, workspaceId);
  const rationale = String(payload.ticketTypeRationale || payload.ticketTypeReasoning || '').trim();

  return {
    assessedTicketType: ticketType,
    ticketTypeRationale: rationale ? rationale.slice(0, 4000) : null,
    ticketTypeConfidence: normalizeTicketTypeConfidence(payload.ticketTypeConfidence),
  };
}

export async function validateRecommendationTicketTypeFields(payload = {}, workspaceId) {
  await normalizeTicketTypeAssessment(payload, workspaceId);
  return true;
}

export async function buildTicketTypeTicketUpdateFields(payload, sourceRunId, assessedAt = new Date(), workspaceId) {
  const assessment = await normalizeTicketTypeAssessment(payload, workspaceId);
  if (!assessment) return null;

  return {
    assessedTicketType: assessment.assessedTicketType,
    ticketTypeRationale: assessment.ticketTypeRationale,
    ticketTypeConfidence: assessment.ticketTypeConfidence,
    ticketTypeAssessedAt: assessedAt,
    ticketTypeAssessedByRunId: sourceRunId,
  };
}
