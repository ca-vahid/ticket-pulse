import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Phase RM (Mega 08-26, QA 08-24 #3) — role model lockdown.
 *
 * Viewers and reviewers are ticket-surface users: Tickets + Approvals, plus
 * (reviewers) the AI decide/override path and approval-category CRUD.
 * Dashboard, Analytics, Agent Maps, the Summit workshop, Assignment-Review
 * reads, AI-provider reads and the global settings bundle are workspace-admin
 * only — the same as "No access" for everyone else. `/sse` stays open to every
 * member (live queue), mounted ABOVE the admin gates.
 *
 * Three layers are pinned here, each with the real router and role stand-ins
 * that mirror the real middleware contracts (those contracts themselves are
 * pinned by authRoleGates.test.js):
 *   A. routes/index.js mount-level gates (every route module stubbed);
 *   B. assignment.routes.js — page reads flipped to admin, ticket-surface AI
 *      path kept reviewer;
 *   C. settings.routes.js — GET /, test-connection, initialize closed to
 *      admins; approval-categories still reviewer; ticket-types still
 *      member-or-agent.
 */

const roleOf = (req) => req.headers['x-test-role'] || 'viewer';
const refuse = (res, code, message) => res.status(403).json({ success: false, code, message });

const requireAdminMock = jest.fn((req, res, next) => {
  if (roleOf(req) === 'admin') return next();
  return refuse(res, 'admin_required', 'Admin access required');
});
const requireReviewerMock = jest.fn((req, res, next) => {
  if (['admin', 'reviewer'].includes(roleOf(req))) return next();
  return refuse(res, 'reviewer_required', 'Reviewer access required');
});
const requireWorkspaceAccessMock = jest.fn((req, res, next) => {
  if (['admin', 'reviewer', 'viewer'].includes(roleOf(req))) return next();
  return refuse(res, 'workspace_access_denied', 'Workspace access denied');
});
const requireWorkspaceMemberOrAgentMock = jest.fn((req, res, next) => {
  if (['admin', 'reviewer', 'viewer', 'agent'].includes(roleOf(req))) return next();
  return refuse(res, 'workspace_access_denied', 'Workspace access denied');
});

const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const stub = () => ({ default: {} });

// A stub router that answers any path with its mount name, so a 200 proves
// the request got THROUGH the index.js gates, not what the real router does.
const stubRouter = (name) => {
  const r = express.Router();
  r.all('*', (req, res) => res.json({ ok: true, mount: name, role: roleOf(req) }));
  return r;
};
const routeStub = (name, extraNamed = {}) => () => ({ default: stubRouter(name), ...extraNamed });

jest.unstable_mockModule('../src/middleware/errorHandler.js', () => ({
  asyncHandler: (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
}));
jest.unstable_mockModule('../src/middleware/auth.js', () => ({
  requireAuth: (_req, _res, next) => next(),
  requireAdmin: requireAdminMock,
  requireReviewer: requireReviewerMock,
  requireGlobalAdmin: requireAdminMock,
  requireWorkspaceAccess: requireWorkspaceAccessMock,
  requireWorkspaceMemberOrAgent: requireWorkspaceMemberOrAgentMock,
}));
jest.unstable_mockModule('../src/middleware/workspace.js', () => ({
  requireWorkspace: (req, _res, next) => { req.workspaceId = 1; next(); },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../src/config/index.js', () => ({ default: { freshservice: { domain: 'test' } } }));

// ---- A. every route module index.js mounts, stubbed -----------------------
for (const name of [
  'auth', 'workspace', 'dashboard', 'sync', 'sse', 'photos', 'webhook', 'freshserviceWebhook',
  'autoresponse', 'llmAdmin', 'aiUsage', 'visuals', 'noise', 'vacationTracker', 'calendarLeave',
  'notifications', 'notificationWorkflow', 'aiProvider', 'analytics', 'agent', 'statuses', 'search',
  'apiV1', 'backup',
]) {
  jest.unstable_mockModule(`../src/routes/${name}.routes.js`, routeStub(name));
}
jest.unstable_mockModule('../src/routes/summit.routes.js', routeStub('summit', { summitPublicRouter: stubRouter('summit-public') }));
jest.unstable_mockModule('../src/routes/publicTicketStatus.routes.js', () => ({ publicTicketStatusPublicRouter: stubRouter('ticket-status-public') }));
jest.unstable_mockModule('../src/routes/tickets.routes.js', routeStub('tickets', { ticketApprovalPublicRouter: stubRouter('approvals-public') }));

// ---- B. assignment.routes.js, real router ----------------------------------
const assignmentRepositoryMock = {
  getConfig: jest.fn(), upsertConfig: jest.fn(), getQueuedRuns: jest.fn().mockResolvedValue([]),
  listRuns: jest.fn().mockResolvedValue({ runs: [], total: 0 }), getRun: jest.fn().mockResolvedValue(null),
  getLatestRunForTicket: jest.fn().mockResolvedValue(null), getRunsForTicket: jest.fn().mockResolvedValue([]),
};
jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({ default: assignmentRepositoryMock }));
for (const mod of [
  'competencyRepository', 'agentCompetencyService', 'assignmentPipelineService', 'competencyAnalysisService',
  'competencyPromptRepository', 'freshServiceActionService', 'competencyFeedbackService',
  'assignmentDailyReviewService', 'assignmentDailyReviewConsolidationService', 'assignmentCorrectionService',
  'skillHierarchyService', 'ticketReclassificationService', 'syncService', 'promptRepository',
  'priorityBackfillService', 'workspaceWebhookService', 'availabilityService', 'settingsRepository',
  'prisma', 'technicianRepository', 'groupRepository', 'approvalCategoryService', 'azureAdService',
  'scheduledSyncService', 'emailHealthService', 'afterHoursUrgentEscalationService', 'userSignatureService',
]) {
  jest.unstable_mockModule(`../src/services/${mod}.js`, stub);
}
jest.unstable_mockModule('../src/services/emailPollingService.js', () => ({ default: {}, emailPollingService: {} }));
jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({ default: {}, providerGateway: {} }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: {}, createGraphMailClient: jest.fn() }));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient: jest.fn() }));
jest.unstable_mockModule('../src/integrations/freshserviceTransformer.js', () => ({ analyzeTicketActivities: jest.fn() }));
jest.unstable_mockModule('../src/utils/timezone.js', () => ({ convertToTimezone: jest.fn() }));
jest.unstable_mockModule('../src/utils/anthropicModels.js', () => ({ DEFAULT_ANTHROPIC_MODEL: 'claude-test' }));
jest.unstable_mockModule('../src/utils/aiProviders.js', () => ({
  normalizeAiModel: jest.fn((m) => m), providerForModel: jest.fn(() => 'anthropic'),
}));
jest.unstable_mockModule('../src/utils/sseDisconnect.js', () => ({ attachSseDisconnectAbort: jest.fn() }));
jest.unstable_mockModule('../src/utils/workspaceFeatureFlags.js', () => ({
  isSkillHierarchyWorkspace: () => true, isCanonicalCategoryWorkspace: () => true, isFsTaxonomySyncWorkspace: () => true,
}));

// ---- C. settings.routes.js, real router -------------------------------------
const approvalCategoryServiceMock = { list: jest.fn().mockResolvedValue([]), create: jest.fn(), update: jest.fn(), remove: jest.fn() };
jest.unstable_mockModule('../src/services/approvalCategoryService.js', () => ({ default: approvalCategoryServiceMock }));
const settingsRepositoryMock = { getAll: jest.fn().mockResolvedValue({ a: 1 }), initializeDefaults: jest.fn().mockResolvedValue(3) };
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepositoryMock }));
jest.unstable_mockModule('../src/services/syncService.js', () => ({ default: { testConnection: jest.fn().mockResolvedValue(true) } }));
jest.unstable_mockModule('../src/services/dashboardReadCache.js', () => ({ clearReadCache: jest.fn() }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ sendAssignmentEmail: jest.fn() }));
jest.unstable_mockModule('../src/services/twilioNotificationService.js', () => ({ placeVoiceCall: jest.fn(), sendSms: jest.fn(), sendWhatsApp: jest.fn() }));
jest.unstable_mockModule('../src/services/publicTicketStatusService.js', () => ({
  buildPublicTicketStatusUrl: jest.fn(), ensurePublicTicketStatusLink: jest.fn(), getPublicTicketStatusSettings: jest.fn(),
  previewPublicTicketStatus: jest.fn(), resetPublicTicketStatusLink: jest.fn(), revokePublicTicketStatusLink: jest.fn(),
  updatePublicTicketStatusSettings: jest.fn(),
}));
jest.unstable_mockModule('../src/services/publicFeedbackService.js', () => ({
  getFeedbackSettings: jest.fn(), updateFeedbackSettings: jest.fn(), listFeedbackSubmissions: jest.fn(), deleteFeedbackSubmission: jest.fn(),
}));

const { default: apiRouter } = await import('../src/routes/index.js');
const { default: assignmentRouter } = await import('../src/routes/assignment.routes.js');
const { default: settingsRouter } = await import('../src/routes/settings.routes.js');

function withErrors(app) {
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  });
  return app;
}

const apiApp = withErrors(express().use('/api', apiRouter));
const assignmentApp = withErrors(express().use(express.json()).use((req, _res, next) => { req.workspaceId = 1; next(); }).use('/assignment', assignmentRouter));
const settingsApp = withErrors(express().use(express.json()).use('/settings', settingsRouter));

const as = (role, req) => req.set('x-test-role', role);

beforeEach(() => jest.clearAllMocks());

describe('A. index.js mounts — viewers keep the ticket surface, lose the admin pages', () => {
  const ADMIN_ONLY = ['/api/dashboard', '/api/dashboard/weekly', '/api/analytics/overview', '/api/visuals/agents', '/api/summit/workshop'];
  const MEMBER_TIER = ['/api/sse/events', '/api/tickets', '/api/tickets/approvals/inbox', '/api/search?q=x', '/api/agent/profile', '/api/notifications'];

  test.each(ADMIN_ONLY)('viewer → 403 admin_required on %s', async (path) => {
    const res = await as('viewer', request(apiApp).get(path));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('admin_required');
  });

  test.each(ADMIN_ONLY)('reviewer → 403 admin_required on %s (same as No access)', async (path) => {
    const res = await as('reviewer', request(apiApp).get(path));
    expect(res.status).toBe(403);
  });

  test.each(ADMIN_ONLY)('workspace admin → 200 on %s', async (path) => {
    const res = await as('admin', request(apiApp).get(path));
    expect(res.status).toBe(200);
  });

  test.each(MEMBER_TIER)('viewer → 200 on %s', async (path) => {
    const res = await as('viewer', request(apiApp).get(path));
    expect(res.status).toBe(200);
  });

  test('/sse is mounted ABOVE the admin gates: an agent (no access row) still streams', async () => {
    const res = await as('agent', request(apiApp).get('/api/sse/events'));
    expect(res.status).toBe(200);
    expect(res.body.mount).toBe('sse');
    expect(requireAdminMock).not.toHaveBeenCalled();
  });

  test('a user with no workspace access is still refused everywhere below the gate', async () => {
    const res = await as('none', request(apiApp).get('/api/dashboard'));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('workspace_access_denied');
  });
});

describe('B. assignment.routes.js — Assignment-Review reads are admin, the ticket-surface AI path stays reviewer', () => {
  const FLIPPED = [
    ['get', '/assignment/freshservice-domain'],
    ['get', '/assignment/queued'],
    ['post', '/assignment/queued/prune'],
    ['get', '/assignment/queue-status'],
    ['get', '/assignment/queue'],
    ['get', '/assignment/runs'],
    ['get', '/assignment/audit/priority-alerts'],
    ['get', '/assignment/runs/1'],
    ['get', '/assignment/runs/1/freshness'],
    ['get', '/assignment/competencies/technicians'],
  ];
  const KEPT = [
    ['post', '/assignment/runs/1/decide'],
    ['post', '/assignment/ticket/1/override-reason'],
    ['get', '/assignment/ticket/1/latest-run'],
    ['get', '/assignment/ticket/1/runs'],
  ];

  test.each(FLIPPED)('reviewer → 403 on %s %s', async (method, path) => {
    const res = await as('reviewer', request(assignmentApp)[method](path));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('admin_required');
    expect(requireReviewerMock).not.toHaveBeenCalled();
  });

  test.each(KEPT)('reviewer passes the gate on %s %s', async (method, path) => {
    const res = await as('reviewer', request(assignmentApp)[method](path).send({}));
    expect(res.status).not.toBe(403);
    expect(requireReviewerMock).toHaveBeenCalledTimes(1);
    expect(requireAdminMock).not.toHaveBeenCalled();
  });

  test.each(KEPT)('viewer → 403 reviewer_required on %s %s (sees suggestions, cannot act)', async (method, path) => {
    const res = await as('viewer', request(assignmentApp)[method](path).send({}));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reviewer_required');
  });
});

describe('C. settings.routes.js — auth-only holes closed, reviewer/member tiers kept', () => {
  test('GET /settings is admin-only (only the admin Settings page reads the bundle)', async () => {
    expect((await as('viewer', request(settingsApp).get('/settings'))).status).toBe(403);
    expect((await as('reviewer', request(settingsApp).get('/settings'))).status).toBe(403);
    const ok = await as('admin', request(settingsApp).get('/settings'));
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ a: 1 });
  });

  test('POST /settings/test-connection and /settings/initialize are admin-only', async () => {
    expect((await as('viewer', request(settingsApp).post('/settings/test-connection'))).status).toBe(403);
    expect((await as('reviewer', request(settingsApp).post('/settings/initialize'))).status).toBe(403);
    expect((await as('admin', request(settingsApp).post('/settings/test-connection'))).status).toBe(200);
    expect((await as('admin', request(settingsApp).post('/settings/initialize'))).status).toBe(200);
  });

  test('approval-categories stay reviewer-tier (reviewer 200, viewer 403)', async () => {
    expect((await as('reviewer', request(settingsApp).get('/settings/approval-categories'))).status).toBe(200);
    const denied = await as('viewer', request(settingsApp).get('/settings/approval-categories'));
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('reviewer_required');
  });

  test('ticket-types stay member-or-agent (viewer passes the gate)', async () => {
    const res = await as('viewer', request(settingsApp).get('/settings/ticket-types'));
    expect(res.status).not.toBe(403);
    expect(requireWorkspaceMemberOrAgentMock).toHaveBeenCalledTimes(1);
  });
});
