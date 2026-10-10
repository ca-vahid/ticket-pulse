import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * QA 10-09 item 12 — Learned skills review routes
 * (/assignment/competencies/learned…): admin only like the rest of the
 * matrix, workspace-scoped, the acting admin passed through, and the service's
 * validation errors surfaced as 400 / 404.
 */

const { ValidationError, NotFoundError } = await import('../src/utils/errors.js');

const learnerMock = {
  listLearnedSkills: jest.fn(),
  keepLearnedSkills: jest.fn(),
  removeLearnedSkills: jest.fn(),
  setLearnedSkillLevel: jest.fn(),
};
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

const roleOf = (req) => req.headers['x-test-role'] || 'viewer';
const requireAdminMock = jest.fn((req, res, next) => {
  if (roleOf(req) !== 'admin') return res.status(403).json({ success: false, code: 'admin_required', message: 'Admin access required' });
  req.session = { user: { email: 'ada@example.com', role: 'viewer' } };
  return next();
});

const stub = () => ({ default: {} });
jest.unstable_mockModule('../src/middleware/errorHandler.js', () => ({
  asyncHandler: (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
}));
jest.unstable_mockModule('../src/services/assignmentRepository.js', stub);
jest.unstable_mockModule('../src/services/competencyRepository.js', stub);
jest.unstable_mockModule('../src/services/agentCompetencyService.js', stub);
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', stub);
jest.unstable_mockModule('../src/services/competencyAnalysisService.js', stub);
jest.unstable_mockModule('../src/services/competencyPromptRepository.js', stub);
jest.unstable_mockModule('../src/services/freshServiceActionService.js', stub);
jest.unstable_mockModule('../src/services/competencyFeedbackService.js', () => ({ default: learnerMock }));
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
  app.use((req, _res, next) => { req.workspaceId = 3; next(); });
  app.use('/assignment', assignmentRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  });
  return app;
}

const app = buildApp();
const asAdmin = (req) => req.set('x-test-role', 'admin');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('learned skills review routes', () => {
  test.each([
    ['get', '/assignment/competencies/learned'],
    ['post', '/assignment/competencies/learned/keep'],
    ['post', '/assignment/competencies/learned/remove'],
    ['put', '/assignment/competencies/learned/4/level'],
  ])('%s %s is admin only', async (method, url) => {
    for (const role of ['viewer', 'reviewer', 'readonly', 'agent']) {
      const res = await request(app)[method](url).set('x-test-role', role).send({ ids: [4], level: 'basic' });
      expect(res.status).toBe(403);
    }
    for (const fn of Object.values(learnerMock)) expect(fn).not.toHaveBeenCalled();
  });

  test('GET lists the learned skills of the workspace', async () => {
    learnerMock.listLearnedSkills.mockResolvedValue({ items: [{ id: 4 }], total: 1 });
    const res = await asAdmin(request(app).get('/assignment/competencies/learned'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { items: [{ id: 4 }], total: 1 } });
    expect(learnerMock.listLearnedSkills).toHaveBeenCalledWith(3);
  });

  test('keep and remove pass the ids and the acting admin, scoped to the workspace', async () => {
    learnerMock.keepLearnedSkills.mockResolvedValue({ kept: 2, requested: 2 });
    learnerMock.removeLearnedSkills.mockResolvedValue({ removed: 1, requested: 1 });

    const kept = await asAdmin(request(app).post('/assignment/competencies/learned/keep')).send({ ids: [4, 5] });
    expect(kept.status).toBe(200);
    expect(kept.body.data).toEqual({ kept: 2, requested: 2 });
    expect(learnerMock.keepLearnedSkills).toHaveBeenCalledWith(3, [4, 5], 'ada@example.com');

    const removed = await asAdmin(request(app).post('/assignment/competencies/learned/remove')).send({ ids: [9] });
    expect(removed.status).toBe(200);
    expect(learnerMock.removeLearnedSkills).toHaveBeenCalledWith(3, [9], 'ada@example.com');
  });

  test('bad ids are a 400, not a 500', async () => {
    learnerMock.keepLearnedSkills.mockRejectedValue(new ValidationError('ids must be an array of skill ids'));
    const res = await asAdmin(request(app).post('/assignment/competencies/learned/keep')).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/ids/);
    expect(learnerMock.keepLearnedSkills).toHaveBeenCalledWith(3, undefined, 'ada@example.com');
  });

  test('PUT level sets it; an unknown level is 400 and a foreign row 404', async () => {
    learnerMock.setLearnedSkillLevel.mockResolvedValueOnce({ id: 4, level: 'expert', from: 'advanced' });
    const ok = await asAdmin(request(app).put('/assignment/competencies/learned/4/level')).send({ level: 'expert' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ id: 4, level: 'expert', from: 'advanced' });
    expect(learnerMock.setLearnedSkillLevel).toHaveBeenCalledWith(3, '4', 'expert', 'ada@example.com');

    learnerMock.setLearnedSkillLevel.mockRejectedValueOnce(new ValidationError('level must be one of: basic'));
    expect((await asAdmin(request(app).put('/assignment/competencies/learned/4/level')).send({ level: 'guru' })).status).toBe(400);

    learnerMock.setLearnedSkillLevel.mockRejectedValueOnce(new NotFoundError('Learned skill not found in this workspace'));
    expect((await asAdmin(request(app).put('/assignment/competencies/learned/99/level')).send({ level: 'basic' })).status).toBe(404);
  });
});
