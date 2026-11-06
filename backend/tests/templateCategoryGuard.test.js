import { jest, describe, expect, test, beforeEach } from '@jest/globals';

/**
 * QA 11-05 #5 — a category the onboarding/offboarding template set at
 * creation survives the AI run that picks the child's owner. The template
 * marks it (internal_category_fit 'template'); the pipeline's classification
 * write leaves such a ticket alone, and still writes every other ticket.
 */

const prismaMock = {
  ticket: { findUnique: jest.fn(), update: jest.fn() },
  competencyCategory: { findMany: jest.fn() },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('@anthropic-ai/sdk', () => ({ default: jest.fn() }));
jest.unstable_mockModule('../src/config/index.js', () => ({ default: { anthropic: { apiKey: 'test-key' } } }));
jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/promptRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/availabilityService.js', () => ({ default: { isBusinessHours: jest.fn() } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/assignmentTools.js', () => ({
  TOOL_SCHEMAS: [], executeTool: jest.fn(), applyWorkspaceTicketTypes: jest.fn(async (tools) => ({ tools, autoType: null })),
}));
jest.unstable_mockModule('../src/services/freshServiceActionService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/competencyFeedbackService.js', () => ({ default: { processDecisionFeedback: jest.fn() } }));
jest.unstable_mockModule('../src/services/afterHoursUrgentEscalationService.js', () => ({ default: { queueForPriorityRun: jest.fn() } }));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient: jest.fn() }));
jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({ default: { runToolTurn: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentRecommendationValidation.js', () => ({ normalizeSubmitRecommendationPayload: jest.fn(async (i) => i) }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/noiseCloseGuard.js', () => ({
  evaluateNoiseCloseGuard: jest.fn(), parkHeldHrNotice: jest.fn(), holdMessage: jest.fn(), NOISE_CLOSE_HOLD_REASONS: {},
}));
jest.unstable_mockModule('../src/services/agentAlertService.js', () => ({ default: { evaluate: jest.fn(async () => null) } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ emitTicketEvent: jest.fn(async () => null), default: {} }));

const { default: pipeline } = await import('../src/services/assignmentPipelineService.js');

const recommendation = { internalCategoryId: 160, internalSubcategoryId: 161, categoryFit: 'strong', subcategoryFit: 'strong', confidence: 'high', classificationRationale: 'Looks like hardware' };

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.competencyCategory.findMany.mockResolvedValue([{ id: 160, parentId: null }, { id: 161, parentId: 160 }]);
  prismaMock.ticket.update.mockResolvedValue({});
});

describe('the AI keeps a template category', () => {
  test('category set by the template (fit "template"): no classification write', async () => {
    prismaMock.ticket.findUnique.mockImplementation(async ({ select }) => (select?.triageMode
      ? { triageMode: null }
      : { internalCategoryId: 132, internalSubcategoryId: 135, internalCategoryFit: 'template' }));
    await pipeline._persistInternalClassification(66986, 1, recommendation);
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });

  test('any other ticket is classified as before (an AI or empty category is not protected)', async () => {
    prismaMock.ticket.findUnique.mockImplementation(async ({ select }) => (select?.triageMode
      ? { triageMode: null }
      : { internalCategoryId: 132, internalSubcategoryId: 135, internalCategoryFit: 'strong' }));
    await pipeline._persistInternalClassification(66987, 1, recommendation);
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ internalCategoryId: 160, internalSubcategoryId: 161 }) }));
  });

  test('the "template" mark alone, with no category, protects nothing', async () => {
    prismaMock.ticket.findUnique.mockImplementation(async ({ select }) => (select?.triageMode
      ? { triageMode: null }
      : { internalCategoryId: null, internalSubcategoryId: null, internalCategoryFit: 'template' }));
    await pipeline._persistInternalClassification(66988, 1, recommendation);
    expect(prismaMock.ticket.update).toHaveBeenCalled();
  });
});
