import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Route wiring for the Phase 3 draft lifecycle:
 *  - DELETE /assignment/skills/draft is admin-gated like its siblings and
 *    delegates to skillHierarchyService.discardDraft (audit-logged);
 *  - the retired draft-editor endpoints stay callable but log
 *    "Legacy draft endpoint used".
 */

const skillHierarchyServiceMock = {
  getDraft: jest.fn(),
  saveDraft: jest.fn(),
  importSummit: jest.fn(),
  publish: jest.fn(),
  getMappings: jest.fn(),
  updateMappings: jest.fn(),
  discardDraft: jest.fn(),
  getFreshserviceFields: jest.fn(),
  getFreshserviceDrift: jest.fn(),
  syncFreshserviceObjects: jest.fn(),
};

const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

// requireAdmin stand-in mirrors the real gate's contract: only admin sessions
// pass; everyone else is rejected before the handler runs.
const requireAdminMock = jest.fn((req, res, next) => {
  if (req.headers['x-test-admin'] === '1') {
    req.session = { user: { email: 'admin@test', role: 'admin' } };
    return next();
  }
  return res.status(403).json({ success: false, error: 'Admin access required' });
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
jest.unstable_mockModule('../src/services/competencyFeedbackService.js', stub);
jest.unstable_mockModule('../src/services/assignmentDailyReviewService.js', stub);
jest.unstable_mockModule('../src/services/assignmentDailyReviewConsolidationService.js', stub);
jest.unstable_mockModule('../src/services/assignmentCorrectionService.js', stub);
jest.unstable_mockModule('../src/services/skillHierarchyService.js', () => ({ default: skillHierarchyServiceMock }));
jest.unstable_mockModule('../src/services/ticketReclassificationService.js', stub);
jest.unstable_mockModule('../src/services/syncService.js', stub);
jest.unstable_mockModule('../src/services/emailPollingService.js', stub);
jest.unstable_mockModule('../src/services/promptRepository.js', stub);
jest.unstable_mockModule('../src/services/priorityBackfillService.js', stub);
jest.unstable_mockModule('../src/services/workspaceWebhookService.js', stub);
jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', stub);
jest.unstable_mockModule('../src/integrations/graphMailClient.js', stub);
jest.unstable_mockModule('../src/services/availabilityService.js', stub);
jest.unstable_mockModule('../src/services/settingsRepository.js', stub);
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
jest.unstable_mockModule('../src/utils/workspaceFeatureFlags.js', () => ({ isSkillHierarchyWorkspace: () => true }));
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));

const { default: assignmentRouter } = await import('../src/routes/assignment.routes.js');
const { NotFoundError } = await import('../src/utils/errors.js');

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

describe('DELETE /assignment/skills/draft', () => {
  const app = buildApp();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rejects non-admin callers before touching the service', async () => {
    const res = await request(app).delete('/assignment/skills/draft');
    expect(res.status).toBe(403);
    expect(skillHierarchyServiceMock.discardDraft).not.toHaveBeenCalled();
  });

  test('admin discard archives the draft and writes an audit log line', async () => {
    skillHierarchyServiceMock.discardDraft.mockResolvedValue({ id: 50, status: 'discarded', source: 'summit_workshop' });

    const res = await request(app).delete('/assignment/skills/draft').set('x-test-admin', '1');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { id: 50, status: 'discarded' } });
    expect(skillHierarchyServiceMock.discardDraft).toHaveBeenCalledWith(1, 'admin@test');
    expect(loggerMock.info).toHaveBeenCalledWith('Legacy skill hierarchy draft discarded', expect.objectContaining({
      workspaceId: 1,
      draftId: 50,
      actorEmail: 'admin@test',
    }));
  });

  test('404s when there is no draft to discard', async () => {
    skillHierarchyServiceMock.discardDraft.mockRejectedValue(new NotFoundError('No editable skill draft found'));
    const res = await request(app).delete('/assignment/skills/draft').set('x-test-admin', '1');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/No editable skill draft/);
  });
});

describe('retired draft endpoints log their use', () => {
  const app = buildApp();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('POST /skills/publish stays admin-callable but logs "Legacy draft endpoint used"', async () => {
    skillHierarchyServiceMock.publish.mockResolvedValue({ skillCount: 3, subskillCount: 5, retiredCount: 0 });
    const res = await request(app).post('/assignment/skills/publish').set('x-test-admin', '1');
    expect(res.status).toBe(200);
    expect(loggerMock.warn).toHaveBeenCalledWith('Legacy draft endpoint used', expect.objectContaining({
      endpoint: 'POST /skills/publish',
      workspaceId: 1,
      actorEmail: 'admin@test',
    }));
  });

  test('POST /skills/draft logs too', async () => {
    skillHierarchyServiceMock.saveDraft.mockResolvedValue({ id: 51 });
    const res = await request(app).post('/assignment/skills/draft').set('x-test-admin', '1').send({ state: { skills: [] } });
    expect(res.status).toBe(200);
    expect(loggerMock.warn).toHaveBeenCalledWith('Legacy draft endpoint used', expect.objectContaining({
      endpoint: 'POST /skills/draft',
    }));
  });

  test('GET /skills/draft (read-only, still used by the migration banner) does NOT log', async () => {
    skillHierarchyServiceMock.getDraft.mockResolvedValue({ draft: null, published: { skills: [] } });
    const res = await request(app).get('/assignment/skills/draft').set('x-test-admin', '1');
    expect(res.status).toBe(200);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });
});
