import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * MEGA 11-14 Part B: the "Clear N settled items" button. GET shows the count
 * first; POST settles them through the same service, records the admin who
 * clicked, and is idempotent (a second click settles nothing). Admin only;
 * history asks for settled runs only with includeSettled.
 */

const settleMock = { countBacklog: jest.fn(), clearBacklog: jest.fn() };
const repoMock = { getPipelineRuns: jest.fn().mockResolvedValue({ items: [], total: 0 }) };

const requireAdminMock = jest.fn((req, res, next) => {
  if (req.headers['x-test-admin'] === '1') {
    req.session = { user: { email: 'sam.ortiz@example.com', name: 'Sam Ortiz', role: 'admin' } };
    return next();
  }
  return res.status(403).json({ success: false, error: 'Admin access required' });
});

const stub = () => ({ default: {} });
jest.unstable_mockModule('../src/middleware/errorHandler.js', () => ({
  asyncHandler: (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
}));
jest.unstable_mockModule('../src/services/reviewQueueSettleService.js', () => ({ default: settleMock }));
jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({ default: repoMock }));
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
jest.unstable_mockModule('../src/services/promptRepository.js', stub);
jest.unstable_mockModule('../src/services/priorityBackfillService.js', stub);
jest.unstable_mockModule('../src/services/workspaceWebhookService.js', stub);
jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', stub);
jest.unstable_mockModule('../src/integrations/graphMailClient.js', stub);
jest.unstable_mockModule('../src/services/availabilityService.js', stub);
jest.unstable_mockModule('../src/services/settingsRepository.js', stub);
jest.unstable_mockModule('../src/services/noiseCloseDigestService.js', stub);
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient: jest.fn() }));
jest.unstable_mockModule('../src/integrations/freshserviceTransformer.js', () => ({ analyzeTicketActivities: jest.fn() }));
jest.unstable_mockModule('../src/utils/timezone.js', () => ({ convertToTimezone: jest.fn() }));
jest.unstable_mockModule('../src/utils/anthropicModels.js', () => ({ DEFAULT_ANTHROPIC_MODEL: 'claude-test' }));
jest.unstable_mockModule('../src/utils/aiProviders.js', () => ({ normalizeAiModel: jest.fn(), providerForModel: jest.fn() }));
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
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: assignmentRouter } = await import('../src/routes/assignment.routes.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.workspaceId = 2; next(); });
  app.use('/assignment', assignmentRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, error: err.message }));
  return app;
}

const app = buildApp();
beforeEach(() => jest.clearAllMocks());

test('non-admins are refused before the service is touched', async () => {
  expect((await request(app).get('/assignment/settled-backlog')).status).toBe(403);
  expect((await request(app).post('/assignment/settled-backlog/clear')).status).toBe(403);
  expect(settleMock.countBacklog).not.toHaveBeenCalled();
  expect(settleMock.clearBacklog).not.toHaveBeenCalled();
});

test('the count comes first, for this workspace', async () => {
  settleMock.countBacklog.mockResolvedValue(2131);
  const res = await request(app).get('/assignment/settled-backlog').set('x-test-admin', '1');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ success: true, data: { count: 2131 } });
  expect(settleMock.countBacklog).toHaveBeenCalledWith(2);
});

test('clearing records the admin; a second click settles nothing', async () => {
  settleMock.clearBacklog.mockResolvedValueOnce({ settled: 2131, remaining: 0 }).mockResolvedValueOnce({ settled: 0, remaining: 0 });
  const first = await request(app).post('/assignment/settled-backlog/clear').set('x-test-admin', '1');
  expect(first.body).toEqual({ success: true, data: { settled: 2131, remaining: 0 } });
  expect(settleMock.clearBacklog).toHaveBeenCalledWith(2, { actor: { email: 'sam.ortiz@example.com', name: 'Sam Ortiz' } });
  const second = await request(app).post('/assignment/settled-backlog/clear').set('x-test-admin', '1');
  expect(second.body.data).toEqual({ settled: 0, remaining: 0 });
});

test('history leaves settled runs out unless includeSettled is sent', async () => {
  await request(app).get('/assignment/runs?limit=20').set('x-test-admin', '1');
  expect(repoMock.getPipelineRuns.mock.calls[0][1].includeSettled).toBe(false);
  await request(app).get('/assignment/runs?includeSettled=1&decision=settled_elsewhere').set('x-test-admin', '1');
  expect(repoMock.getPipelineRuns.mock.calls[1][1]).toMatchObject({ includeSettled: true, decision: 'settled_elsewhere' });
});
