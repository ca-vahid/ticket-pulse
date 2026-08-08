import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * FR 08-07 #11 — approval categories are reviewer-tier, not admin-only:
 * the four /settings/approval-categories routes must gate on requireReviewer
 * (reviewers AND admins pass; viewers are rejected), while sibling settings
 * routes stay admin-gated.
 */

const approvalCategoryServiceMock = {
  list: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
};

// Role stand-ins mirror the real middleware contracts: requireAdmin passes
// admins only; requireReviewer passes reviewers and admins.
const roleOf = (req) => req.headers['x-test-role'] || 'viewer';
const requireAdminMock = jest.fn((req, res, next) => {
  if (roleOf(req) === 'admin') return next();
  return res.status(403).json({ success: false, error: 'Admin access required' });
});
const requireReviewerMock = jest.fn((req, res, next) => {
  if (['admin', 'reviewer'].includes(roleOf(req))) return next();
  return res.status(403).json({ success: false, error: 'Reviewer access required' });
});

const stub = () => ({ default: {} });
jest.unstable_mockModule('../src/middleware/errorHandler.js', () => ({
  asyncHandler: (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
}));
jest.unstable_mockModule('../src/middleware/auth.js', () => ({
  requireAuth: (_req, _res, next) => next(),
  requireAdmin: requireAdminMock,
  requireReviewer: requireReviewerMock,
  requireWorkspaceAccess: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../src/middleware/workspace.js', () => ({
  requireWorkspace: (req, _res, next) => { req.workspaceId = 1; next(); },
}));
jest.unstable_mockModule('../src/services/settingsRepository.js', stub);
jest.unstable_mockModule('../src/services/prisma.js', stub);
jest.unstable_mockModule('../src/services/technicianRepository.js', stub);
jest.unstable_mockModule('../src/services/groupRepository.js', stub);
jest.unstable_mockModule('../src/services/approvalCategoryService.js', () => ({ default: approvalCategoryServiceMock }));
jest.unstable_mockModule('../src/services/azureAdService.js', stub);
jest.unstable_mockModule('../src/services/syncService.js', stub);
jest.unstable_mockModule('../src/services/scheduledSyncService.js', stub);
jest.unstable_mockModule('../src/services/dashboardReadCache.js', () => ({ clearReadCache: jest.fn() }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ sendAssignmentEmail: jest.fn() }));
jest.unstable_mockModule('../src/services/emailHealthService.js', stub);
jest.unstable_mockModule('../src/services/twilioNotificationService.js', () => ({
  placeVoiceCall: jest.fn(), sendSms: jest.fn(), sendWhatsApp: jest.fn(),
}));
jest.unstable_mockModule('../src/services/publicTicketStatusService.js', () => ({
  buildPublicTicketStatusUrl: jest.fn(),
  ensurePublicTicketStatusLink: jest.fn(),
  getPublicTicketStatusSettings: jest.fn(),
  previewPublicTicketStatus: jest.fn(),
  resetPublicTicketStatusLink: jest.fn(),
  revokePublicTicketStatusLink: jest.fn(),
  updatePublicTicketStatusSettings: jest.fn(),
}));
jest.unstable_mockModule('../src/services/publicFeedbackService.js', () => ({
  getFeedbackSettings: jest.fn(),
  updateFeedbackSettings: jest.fn(),
  listFeedbackSubmissions: jest.fn(),
  deleteFeedbackSubmission: jest.fn(),
}));
jest.unstable_mockModule('../src/services/afterHoursUrgentEscalationService.js', stub);
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: settingsRouter } = await import('../src/routes/settings.routes.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/settings', settingsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  });
  return app;
}

describe('approval-category routes are reviewer-tier (FR 08-07 #11)', () => {
  const app = buildApp();

  beforeEach(() => {
    jest.clearAllMocks();
    approvalCategoryServiceMock.list.mockResolvedValue([{ id: 1, name: 'Laptop purchase' }]);
    approvalCategoryServiceMock.create.mockResolvedValue({ id: 2, name: 'Software license' });
    approvalCategoryServiceMock.update.mockResolvedValue({ id: 1, name: 'Laptop purchase (edited)' });
    approvalCategoryServiceMock.remove.mockResolvedValue({ deleted: true });
  });

  test('reviewers can list, create, update, and delete', async () => {
    const asReviewer = (r) => r.set('x-test-role', 'reviewer');

    expect((await asReviewer(request(app).get('/settings/approval-categories'))).status).toBe(200);
    expect((await asReviewer(request(app).post('/settings/approval-categories')
      .send({ name: 'Software license', managerEmails: ['boss@test'] }))).status).toBe(201);
    expect((await asReviewer(request(app).patch('/settings/approval-categories/1')
      .send({ name: 'Laptop purchase (edited)' }))).status).toBe(200);
    expect((await asReviewer(request(app).delete('/settings/approval-categories/1'))).status).toBe(200);

    expect(approvalCategoryServiceMock.list).toHaveBeenCalledWith(1);
    expect(approvalCategoryServiceMock.create).toHaveBeenCalled();
    expect(approvalCategoryServiceMock.update).toHaveBeenCalledWith(1, 1, { name: 'Laptop purchase (edited)' });
    expect(approvalCategoryServiceMock.remove).toHaveBeenCalledWith(1, 1);
  });

  test('admins still pass', async () => {
    const res = await request(app).get('/settings/approval-categories').set('x-test-role', 'admin');
    expect(res.status).toBe(200);
  });

  test('viewers are rejected on every approval-category route, before the service runs', async () => {
    expect((await request(app).get('/settings/approval-categories')).status).toBe(403);
    expect((await request(app).post('/settings/approval-categories').send({ name: 'X' })).status).toBe(403);
    expect((await request(app).patch('/settings/approval-categories/1').send({ name: 'X' })).status).toBe(403);
    expect((await request(app).delete('/settings/approval-categories/1')).status).toBe(403);

    expect(approvalCategoryServiceMock.list).not.toHaveBeenCalled();
    expect(approvalCategoryServiceMock.create).not.toHaveBeenCalled();
    expect(approvalCategoryServiceMock.update).not.toHaveBeenCalled();
    expect(approvalCategoryServiceMock.remove).not.toHaveBeenCalled();
  });

  test('sibling settings routes stay ADMIN-gated (reviewers rejected)', async () => {
    // Group membership editing is admin-only — a reviewer must still 403.
    const res = await request(app)
      .put('/settings/groups/1/members')
      .set('x-test-role', 'reviewer')
      .send({ technicianIds: [] });
    expect(res.status).toBe(403);
  });
});
