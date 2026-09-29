import { ValidationError } from '../utils/errors.js';
import prisma from './prisma.js';
import { validateRecommendationPriorityFields } from './priorityAssessment.js';
import {
  normalizeTicketTypeAssessment,
  validateRecommendationTicketTypeFields,
} from './ticketTypeAssessment.js';

const CONFIDENCE_VALUES = new Set(['low', 'medium', 'high']);
const FIT_VALUES = new Set(['exact', 'weak', 'none']);
const EMBEDDED_STRING_FIELDS = new Set([
  'overallReasoning',
  'agentBriefingHtml',
  'closureNoticeHtml',
  'ticketClassification',
  'classificationRationale',
  'priorityRationale',
  'assessedPriority',
  'priorityConfidence',
  'ticketType',
  'ticketTypeRationale',
  'ticketTypeConfidence',
  'confidence',
  'categoryFit',
  'subcategoryFit',
  'suggestedInternalCategoryName',
  'suggestedInternalSubcategoryName',
]);

/**
 * ticketClassification is only the readable label for the category ids the
 * model also sends. Sonnet 5.5 sometimes omits it (29 Sep 2026: 2 of its first
 * 45 runs), which cost a whole resubmit; rebuild it from the ids instead.
 * Returns null when there is nothing to rebuild from, so the field stays required.
 */
async function classificationFromCategoryIds(payload, workspaceId) {
  const ids = [payload.internalCategoryId, payload.internalSubcategoryId]
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
  if (!workspaceId || ids.length === 0) return null;
  const rows = await Promise.resolve()
    .then(() => prisma.competencyCategory.findMany({
      where: { workspaceId, id: { in: ids }, isActive: true },
      select: { id: true, name: true },
    }))
    .catch(() => null);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const byId = new Map(rows.map((row) => [row.id, row.name]));
  const names = ids.map((id) => byId.get(id)).filter(Boolean);
  return names.length ? names.join(' > ') : null;
}

function requiredText(payload, fieldName) {
  const value = String(payload?.[fieldName] ?? '').trim();
  if (!value) throw new ValidationError(`${fieldName} is required`);
  return value;
}

function parseBoolean(value, fieldName) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  throw new ValidationError(`${fieldName} must be boolean`);
}

function parseOptionalInteger(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new ValidationError(`${fieldName} must be a positive integer`);
  }
  return number;
}

function parsePositiveInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new ValidationError(`${fieldName} must be a positive integer`);
  }
  return number;
}

function parseScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new ValidationError('recommendations[].score must be a number between 0 and 1');
  }
  return number;
}

export function parseLeadingJsonArray(value) {
  const text = String(value ?? '').trim();
  if (!text.startsWith('[')) {
    throw new ValidationError('recommendations must be an array');
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        const jsonText = text.slice(0, index + 1);
        const tail = text.slice(index + 1);
        try {
          const parsed = JSON.parse(jsonText);
          if (!Array.isArray(parsed)) throw new Error('not array');
          return { array: parsed, tail };
        } catch {
          throw new ValidationError('recommendations string did not contain a valid JSON array');
        }
      }
    }
  }

  throw new ValidationError('recommendations string did not contain a complete JSON array');
}

function extractEmbeddedParameters(text) {
  const markers = [...String(text || '').matchAll(/<parameter\s+name="([^"]+)">\s*/g)];
  const extracted = {};

  markers.forEach((marker, index) => {
    const fieldName = marker[1];
    if (!EMBEDDED_STRING_FIELDS.has(fieldName)) return;
    const start = marker.index + marker[0].length;
    const end = markers[index + 1]?.index ?? text.length;
    const value = text
      .slice(start, end)
      .replace(/<\/parameter>\s*$/i, '')
      .trim();
    if (value) extracted[fieldName] = value;
  });

  return extracted;
}

function normalizeRecommendations(rawRecommendations) {
  let recommendations = rawRecommendations;
  let embeddedFields = {};
  let normalizedFromString = false;

  if (typeof rawRecommendations === 'string') {
    const parsed = parseLeadingJsonArray(rawRecommendations);
    recommendations = parsed.array;
    embeddedFields = extractEmbeddedParameters(parsed.tail);
    normalizedFromString = true;
  }

  if (!Array.isArray(recommendations)) {
    throw new ValidationError('recommendations must be an array');
  }

  return {
    recommendations: recommendations.map((rec, index) => {
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
        throw new ValidationError(`recommendations[${index}] must be an object`);
      }
      return {
        ...rec,
        rank: parsePositiveInteger(rec.rank, `recommendations[${index}].rank`),
        techId: parsePositiveInteger(rec.techId, `recommendations[${index}].techId`),
        techName: requiredText(rec, 'techName'),
        score: parseScore(rec.score),
        reasoning: requiredText(rec, 'reasoning'),
      };
    }),
    embeddedFields,
    normalizedFromString,
  };
}

export async function normalizeSubmitRecommendationPayload(payload = {}, workspaceId = null) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ValidationError('submit_recommendation input must be an object');
  }

  const { recommendations, embeddedFields, normalizedFromString } = normalizeRecommendations(payload.recommendations);
  const normalized = {
    ...payload,
    ...Object.fromEntries(
      Object.entries(embeddedFields).filter(([fieldName]) => {
        const current = payload[fieldName];
        return current === undefined || current === null || String(current).trim() === '';
      }),
    ),
    recommendations,
  };

  validateRecommendationPriorityFields(normalized);
  await validateRecommendationTicketTypeFields(normalized, workspaceId);

  normalized.overallReasoning = requiredText(normalized, 'overallReasoning');
  if (String(normalized.ticketClassification ?? '').trim() === '') {
    const rebuilt = await classificationFromCategoryIds(normalized, workspaceId);
    if (rebuilt) normalized.ticketClassification = rebuilt;
  }
  normalized.ticketClassification = requiredText(normalized, 'ticketClassification');
  normalized.classificationRationale = requiredText(normalized, 'classificationRationale');
  normalized.categoryFit = requiredText(normalized, 'categoryFit').toLowerCase();
  normalized.subcategoryFit = requiredText(normalized, 'subcategoryFit').toLowerCase();
  normalized.confidence = requiredText(normalized, 'confidence').toLowerCase();
  normalized.taxonomyReviewNeeded = parseBoolean(normalized.taxonomyReviewNeeded, 'taxonomyReviewNeeded');

  if (!FIT_VALUES.has(normalized.categoryFit)) {
    throw new ValidationError('categoryFit must be exact, weak, or none');
  }
  if (!FIT_VALUES.has(normalized.subcategoryFit)) {
    throw new ValidationError('subcategoryFit must be exact, weak, or none');
  }
  if (!CONFIDENCE_VALUES.has(normalized.confidence)) {
    throw new ValidationError('confidence must be low, medium, or high');
  }

  const categoryId = parseOptionalInteger(normalized.internalCategoryId, 'internalCategoryId');
  const subcategoryId = parseOptionalInteger(normalized.internalSubcategoryId, 'internalSubcategoryId');
  if (categoryId) normalized.internalCategoryId = categoryId;
  if (subcategoryId) normalized.internalSubcategoryId = subcategoryId;
  const ticketTypeAssessment = await normalizeTicketTypeAssessment(normalized, workspaceId);
  if (ticketTypeAssessment) {
    normalized.ticketType = ticketTypeAssessment.assessedTicketType;
    normalized.ticketTypeRationale = ticketTypeAssessment.ticketTypeRationale;
    normalized.ticketTypeConfidence = ticketTypeAssessment.ticketTypeConfidence;
  }
  normalized.__normalizedFromString = normalizedFromString;

  return normalized;
}
