import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * QA 11-23: the Assignment Review run detail (GET /assignment/runs/:id) carries
 * priorityReason on its ticket, from the same priorityReasonFrom helper as the
 * ticket page — so PipelineRunDetail can say "raised by Dana Fox from their
 * status link" with the note.
 */

const repoMock = { getPipelineRun: jest.fn() };
const prismaMock = { ticketActivity: { findFirst: jest.fn() } };

const stub = () => ({ default: {} });
jest.unstable_mockModule('../src/middleware/errorHandler.js', () => ({
  asyncHandler: (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
}));
jest.unstable_mockModule('../src/services/reviewQueueSettleService.js', stub);
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
jest.unstable_mockModule('../src/services/promptRepository.js', () => ({
  default: { getPublished: jest.fn().mockResolvedValue({ id: 7, version: 3 }), getVersion: jest.fn() },
}));
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
  requireAdmin: (_req, _res, next) => next(),
  requireReviewer: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../src/config/index.js', () => ({ default: { freshservice: { domain: 'test' } } }));
jest.unstable_mockModule('../src/utils/workspaceFeatureFlags.js', () => ({
  isSkillHierarchyWorkspace: () => true,
  isCanonicalCategoryWorkspace: () => true,
  isFsTaxonomySyncWorkspace: () => true,
}));
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: assignmentRouter } = await import('../src/routes/assignment.routes.js');

function buildApp() {
  const app = express();
  app.use((req, _res, next) => { req.workspaceId = 2; next(); });
  app.use('/assignment', assignmentRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, error: err.message }));
  return app;
}

const RAISED_AT = new Date('2026-11-23T18:17:00.000Z');
const run = (ticket) => ({ id: 36226, workspaceId: 2, promptVersionId: 7, steps: [], ticket });

beforeEach(() => jest.clearAllMocks());

test('a requester raise: priorityReason names them, the link and the note', async () => {
  repoMock.getPipelineRun.mockResolvedValue(run({
    id: 11, priority: 4, assessedPriority: 'Urgent', priorityRationale: 'Requester raised the ticket to urgent.', priorityConfidence: 'requester',
  }));
  prismaMock.ticketActivity.findFirst.mockResolvedValue({
    activityType: 'priority_changed', performedBy: 'Dana Fox', performedAt: RAISED_AT,
    details: { from: 'Medium', to: 'Urgent', source: 'requester_link', actorName: 'Dana Fox', note: 'Raised the priority to Urgent from their status link.' },
  });

  const res = await request(buildApp()).get('/assignment/runs/36226');

  expect(res.status).toBe(200);
  expect(res.body.data.ticket.priorityReason).toEqual({
    level: 'Urgent', source: 'requester_link', actorName: 'Dana Fox', at: RAISED_AT.toISOString(),
    note: 'Raised the priority to Urgent from their status link.',
  });
  expect(prismaMock.ticketActivity.findFirst).toHaveBeenCalledWith(expect.objectContaining({
    where: { ticketId: 11, activityType: 'priority_changed' },
  }));
  expect(res.body.data.promptVersionNumber).toBe(3);
});

test('no history row: falls back to the AI rationale; a failed read never breaks the run detail', async () => {
  repoMock.getPipelineRun.mockResolvedValue(run({
    id: 12, priority: 3, assessedPriority: 'High', priorityRationale: 'One person cannot sign in to Teams.',
  }));
  prismaMock.ticketActivity.findFirst.mockRejectedValue(new Error('db blip'));

  const res = await request(buildApp()).get('/assignment/runs/36226');

  expect(res.status).toBe(200);
  expect(res.body.data.ticket.priorityReason).toEqual(expect.objectContaining({
    level: 'High', source: 'ai_assessment', actorName: 'Ticket Pulse AI', note: 'One person cannot sign in to Teams.',
  }));
});
