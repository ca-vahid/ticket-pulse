import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * FreshService switch (25 Nov 2026) — assignment routes when Off:
 *  - GET /groups lists the groups Ticket Pulse holds (no FreshService call);
 *  - GET /runs/:id/freshness reads { fresh: true, skipped: 'freshservice_off' }.
 * Harness from skillDraftDiscardRoute.test.js (route wiring for the Phase 3 draft lifecycle):
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
const assignmentRepositoryMock = { getPipelineRun: jest.fn() };
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
const settingsRepositoryMock = { getFreshServiceConfigForWorkspace: jest.fn(async () => ({ domain: 'example.freshservice.com', apiKey: 'k' })) };
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepositoryMock }));
const createFreshServiceClient = jest.fn(() => ({ listGroups: jest.fn(async () => []), getTicket: jest.fn(async () => ({})), fetchTicketActivities: jest.fn(async () => []) }));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient }));
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
const prismaMock = {
  workspace: { findUnique: jest.fn(async () => ({ freshserviceWorkspaceId: 1000208182n })) },
  group: { findMany: jest.fn(async () => []) },
  ticket: { findUnique: jest.fn(async () => ({ mirrorState: null })) },
  technician: { findFirst: jest.fn(async () => null) },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
const fsMode = { mode: 'off' };
jest.unstable_mockModule('../src/services/fsModeService.js', () => ({
  default: {},
  fsGate: jest.fn(async () => fsMode.mode !== 'off'),
  isFreshServiceOff: jest.fn(async () => fsMode.mode === 'off'),
  onModeChange: jest.fn(() => () => {}),
  getMode: jest.fn(async () => fsMode.mode),
  getModeRecord: jest.fn(async () => ({ mode: fsMode.mode })),
  setMode: jest.fn(),
  getShadowReport: jest.fn(async () => ({ since: null, counts: {}, total: 0 })),
  flushShadow: jest.fn(),
  FS_MODES: ['connected', 'shadow', 'off'],
  FS_PURPOSES: [],
  modeSettingKey: (ws) => `freshservice_mode_ws${ws}`,
  shadowSettingKey: (ws) => `freshservice_shadow_ws${ws}`,
  _resetFsModeCache: jest.fn(),
}));
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


const admin = (r) => r.set('x-test-admin', '1');

beforeEach(() => {
  jest.clearAllMocks();
  fsMode.mode = 'off';
});

describe('GET /assignment/groups', () => {
  test('Off: the groups Ticket Pulse holds, by their FreshService id; FreshService not called', async () => {
    prismaMock.group.findMany.mockResolvedValueOnce([
      { freshserviceId: 1000501n, name: 'Service Desk', _count: { members: 4 } },
    ]);
    const res = await admin(request(buildApp()).get('/assignment/groups'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      freshserviceOff: true,
      data: [{ id: 1000501, name: 'Service Desk', agentCount: 4, observerCount: 0, leaderCount: 0, source: 'ticketpulse' }],
    });
    expect(createFreshServiceClient).not.toHaveBeenCalled();
  });

  test('Off and never connected (FS id 0): an empty list, as before', async () => {
    prismaMock.workspace.findUnique.mockResolvedValueOnce({ freshserviceWorkspaceId: 0n });
    const res = await admin(request(buildApp()).get('/assignment/groups'));
    expect(res.body).toEqual({ success: true, data: [] });
  });

  test('Connected: FreshService is asked, as before', async () => {
    fsMode.mode = 'connected';
    const res = await admin(request(buildApp()).get('/assignment/groups'));
    expect(res.status).toBe(200);
    expect(createFreshServiceClient).toHaveBeenCalled();
  });
});

describe('GET /assignment/runs/:id/freshness', () => {
  const run = { id: 900, workspaceId: 1, ticketId: 77, ticket: { freshserviceTicketId: 245001n }, recommendation: {} };

  test('Off: fresh, skipped freshservice_off; FreshService not called', async () => {
    assignmentRepositoryMock.getPipelineRun.mockResolvedValueOnce(run);
    const res = await admin(request(buildApp()).get('/assignment/runs/900/freshness'));
    expect(res.body).toEqual({ success: true, data: { diffs: [], fresh: true, skipped: 'freshservice_off' } });
    expect(createFreshServiceClient).not.toHaveBeenCalled();
  });

  test('adopted (connected): fresh, skipped adopted', async () => {
    fsMode.mode = 'connected';
    assignmentRepositoryMock.getPipelineRun.mockResolvedValueOnce(run);
    prismaMock.ticket.findUnique.mockResolvedValueOnce({ mirrorState: 'adopted' });
    const res = await admin(request(buildApp()).get('/assignment/runs/900/freshness'));
    expect(res.body.data).toEqual({ diffs: [], fresh: true, skipped: 'adopted' });
    expect(createFreshServiceClient).not.toHaveBeenCalled();
  });
});