import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Phase DB: duplicateBurstEnabled on the assignment-config API.
 *  - GET /config defaults the field to TRUE when no config row exists yet;
 *  - PUT /config accepts the field, boolean-coerces it (!!), and omits it
 *    from the update entirely when the caller doesn't send it.
 */

const assignmentRepositoryMock = {
  getConfig: jest.fn(),
  upsertConfig: jest.fn(),
};

const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

const requireAdminMock = jest.fn((req, res, next) => {
  req.session = { user: { email: 'admin@test', role: 'admin' } };
  return next();
});

const stub = () => ({ default: {} });
jest.unstable_mockModule('../src/middleware/errorHandler.js', () => ({
  asyncHandler: (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
}));
jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({ default: assignmentRepositoryMock }));
jest.unstable_mockModule('../src/services/competencyRepository.js', stub);
jest.unstable_mockModule('../src/services/agentCompetencyService.js', stub);
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', stub);
jest.unstable_mockModule('../src/services/competencyAnalysisService.js', stub);
jest.unstable_mockModule('../src/services/competencyPromptRepository.js', stub);
jest.unstable_mockModule('../src/services/freshServiceActionService.js', stub);
jest.unstable_mockModule('../src/services/competencyFeedbackService.js', stub);
jest.unstable_mockModule('../src/services/assignmentDailyReviewService.js', stub);
jest.unstable_mockModule('../src/services/assignmentDailyReviewConsolidationService.js', stub);
jest.unstable_mockModule('../src/services/assignmentCorrectionService.js', stub);
jest.unstable_mockModule('../src/services/skillHierarchyService.js', stub);
jest.unstable_mockModule('../src/services/ticketReclassificationService.js', stub);
jest.unstable_mockModule('../src/services/syncService.js', stub);
jest.unstable_mockModule('../src/services/emailPollingService.js', () => ({
  default: { startForWorkspace: jest.fn(), stopForWorkspace: jest.fn() },
}));
jest.unstable_mockModule('../src/services/promptRepository.js', stub);
jest.unstable_mockModule('../src/services/priorityBackfillService.js', stub);
jest.unstable_mockModule('../src/services/workspaceWebhookService.js', stub);
jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({
  default: { isConfigured: jest.fn(() => true) },
}));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({
  default: { isConfigured: jest.fn(() => false) },
}));
jest.unstable_mockModule('../src/services/availabilityService.js', stub);
jest.unstable_mockModule('../src/services/settingsRepository.js', stub);
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient: jest.fn() }));
jest.unstable_mockModule('../src/integrations/freshserviceTransformer.js', () => ({ analyzeTicketActivities: jest.fn() }));
jest.unstable_mockModule('../src/utils/timezone.js', () => ({ convertToTimezone: jest.fn() }));
jest.unstable_mockModule('../src/utils/anthropicModels.js', () => ({ DEFAULT_ANTHROPIC_MODEL: 'claude-test' }));
jest.unstable_mockModule('../src/utils/aiProviders.js', () => ({
  normalizeAiModel: jest.fn((m) => m),
  providerForModel: jest.fn(() => 'anthropic'),
}));
jest.unstable_mockModule('../src/utils/sseDisconnect.js', () => ({ attachSseDisconnectAbort: jest.fn() }));
jest.unstable_mockModule('../src/middleware/auth.js', () => ({
  requireAdmin: requireAdminMock,
  requireReviewer: (req, res, next) => next(),
}));
jest.unstable_mockModule('../src/config/index.js', () => ({ default: { freshservice: { domain: 'test' } } }));
jest.unstable_mockModule('../src/utils/workspaceFeatureFlags.js', () => ({
  isSkillHierarchyWorkspace: () => true,
  isCanonicalCategoryWorkspace: () => true,
  isFsTaxonomySyncWorkspace: () => true,
}));
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));

const { default: assignmentRouter } = await import('../src/routes/assignment.routes.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = 1; next(); });
  app.use('/assignment', assignmentRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  });
  return app;
}

describe('assignment config duplicateBurstEnabled', () => {
  const app = buildApp();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('GET /config defaults duplicateBurstEnabled to true when no config row exists', async () => {
    assignmentRepositoryMock.getConfig.mockResolvedValue(null);

    const res = await request(app).get('/assignment/config');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.duplicateBurstEnabled).toBe(true);
  });

  test('GET /config passes through a stored false', async () => {
    assignmentRepositoryMock.getConfig.mockResolvedValue({ isEnabled: true, duplicateBurstEnabled: false });

    const res = await request(app).get('/assignment/config');

    expect(res.status).toBe(200);
    expect(res.body.data.duplicateBurstEnabled).toBe(false);
  });

  test('PUT /config round-trips the toggle with boolean coercion', async () => {
    assignmentRepositoryMock.upsertConfig.mockImplementation(async (_wsId, data) => ({ id: 1, ...data }));

    const offRes = await request(app).put('/assignment/config').send({ duplicateBurstEnabled: false });
    expect(offRes.status).toBe(200);
    expect(assignmentRepositoryMock.upsertConfig).toHaveBeenCalledWith(1, { duplicateBurstEnabled: false });
    expect(offRes.body.data.duplicateBurstEnabled).toBe(false);

    // Truthy non-boolean input coerces to a real boolean (!! convention).
    await request(app).put('/assignment/config').send({ duplicateBurstEnabled: 1 });
    expect(assignmentRepositoryMock.upsertConfig).toHaveBeenLastCalledWith(1, { duplicateBurstEnabled: true });
  });

  test('PUT /config leaves the field untouched when not sent', async () => {
    assignmentRepositoryMock.upsertConfig.mockResolvedValue({ id: 1, autoCloseNoise: true });

    const res = await request(app).put('/assignment/config').send({ autoCloseNoise: true });

    expect(res.status).toBe(200);
    expect(assignmentRepositoryMock.upsertConfig).toHaveBeenCalledWith(1, { autoCloseNoise: true });
    expect(assignmentRepositoryMock.upsertConfig.mock.calls[0][1]).not.toHaveProperty('duplicateBurstEnabled');
  });
});
