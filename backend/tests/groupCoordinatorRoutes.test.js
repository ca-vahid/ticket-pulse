import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Group coordinators in Settings → Groups (QA 10-14): the group list carries
 * each group's coordinator and backup, and PUT /groups/:id/coordinator saves
 * them — admins only, like the rest of group editing.
 */

const groupRepositoryMock = { listForWorkspace: jest.fn() };
const groupCoordinatorMock = { getAll: jest.fn(), setForGroup: jest.fn() };
const prismaMock = { workspace: { findUnique: jest.fn() } };

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
  requireWorkspaceMemberOrAgent: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../src/middleware/workspace.js', () => ({
  requireWorkspace: (req, _res, next) => { req.workspaceId = 1; next(); },
}));
jest.unstable_mockModule('../src/services/settingsRepository.js', stub);
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/technicianRepository.js', stub);
jest.unstable_mockModule('../src/services/groupRepository.js', () => ({ default: groupRepositoryMock }));
jest.unstable_mockModule('../src/services/groupCoordinatorService.js', () => ({ default: groupCoordinatorMock }));
jest.unstable_mockModule('../src/services/approvalCategoryService.js', stub);
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
const { ValidationError } = await import('../src/utils/errors.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { email: 'vhaeri@example.com', name: 'Dana Whitfield' } }; next(); });
  app.use('/settings', settingsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  });
  return app;
}

describe('group coordinators in Settings → Groups', () => {
  const app = buildApp();

  beforeEach(() => {
    jest.clearAllMocks();
    groupRepositoryMock.listForWorkspace.mockResolvedValue([
      { id: 8, name: 'Service Desk', origin: 'freshservice', isActive: true, memberCount: 4 },
      { id: 9, name: 'Logistics', origin: 'local', isActive: true, memberCount: 1 },
    ]);
    prismaMock.workspace.findUnique.mockResolvedValue({ defaultInternalGroupId: 9 });
    groupCoordinatorMock.getAll.mockResolvedValue({ 8: { coordinatorTechnicianId: 11, backupTechnicianId: 22 } });
    groupCoordinatorMock.setForGroup.mockImplementation(async (_ws, groupId, body) => ({ groupId, ...body, changed: true }));
  });

  test('GET /groups: every group with its coordinator and backup (null when none)', async () => {
    const res = await request(app).get('/settings/groups').set('x-test-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.data.map((g) => [g.id, g.isDefault, g.coordinatorTechnicianId, g.backupTechnicianId])).toEqual([[8, false, 11, 22], [9, true, null, null]]);
    expect(groupCoordinatorMock.getAll).toHaveBeenCalledWith(1);
  });

  test('PUT /groups/:id/coordinator saves for an admin, with the session user for the audit', async () => {
    const res = await request(app).put('/settings/groups/8/coordinator').set('x-test-role', 'admin').send({ coordinatorTechnicianId: 11, backupTechnicianId: null });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ groupId: 8, coordinatorTechnicianId: 11, backupTechnicianId: null, changed: true });
    expect(groupCoordinatorMock.setForGroup).toHaveBeenCalledWith(1, 8, { coordinatorTechnicianId: 11, backupTechnicianId: null }, { email: 'vhaeri@example.com', name: 'Dana Whitfield' });
  });

  test('PUT /groups/:id/coordinator: a refused save is a 400 with the plain reason', async () => {
    groupCoordinatorMock.setForGroup.mockRejectedValue(new ValidationError('The backup must be a different person from the coordinator'));
    const res = await request(app).put('/settings/groups/8/coordinator').set('x-test-role', 'admin').send({ coordinatorTechnicianId: 11, backupTechnicianId: 11 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('The backup must be a different person from the coordinator');
  });

  test.each(['viewer', 'reviewer'])('a %s cannot read or change coordinators', async (role) => {
    expect((await request(app).get('/settings/groups').set('x-test-role', role)).status).toBe(403);
    expect((await request(app).put('/settings/groups/8/coordinator').set('x-test-role', role).send({ coordinatorTechnicianId: 11 })).status).toBe(403);
    expect(groupCoordinatorMock.setForGroup).not.toHaveBeenCalled();
  });
});
