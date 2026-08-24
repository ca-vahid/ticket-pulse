import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Mega 08-23 Phase TF — GET/PUT /settings/ticket-form are ADMIN-gated (same
 * requireAdmin chain as the sibling ticket-ops routes) and pass the payload +
 * actor email through to ticketFormConfigService.
 */

const ticketFormConfigServiceMock = {
  getResolvedForm: jest.fn(),
  update: jest.fn(),
};

const roleOf = (req) => req.headers['x-test-role'] || 'viewer';
const requireAdminMock = jest.fn((req, res, next) => {
  if (roleOf(req) === 'admin') return next();
  return res.status(403).json({ success: false, error: 'Admin access required' });
});

const stub = () => ({ default: {} });
jest.unstable_mockModule('../src/middleware/errorHandler.js', () => ({
  asyncHandler: (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
}));
jest.unstable_mockModule('../src/middleware/auth.js', () => ({
  requireAuth: (_req, _res, next) => next(),
  requireAdmin: requireAdminMock,
  requireReviewer: (_req, _res, next) => next(),
  requireWorkspaceAccess: (_req, _res, next) => next(),
  requireWorkspaceMemberOrAgent: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../src/middleware/workspace.js', () => ({
  requireWorkspace: (req, _res, next) => {
    req.workspaceId = 1;
    req.session = { user: { email: 'Admin@X.io', role: roleOf(req) } };
    next();
  },
}));
jest.unstable_mockModule('../src/services/settingsRepository.js', stub);
jest.unstable_mockModule('../src/services/prisma.js', stub);
jest.unstable_mockModule('../src/services/technicianRepository.js', stub);
jest.unstable_mockModule('../src/services/groupRepository.js', stub);
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
jest.unstable_mockModule('../src/services/ticketFormConfigService.js', () => ({ default: ticketFormConfigServiceMock }));
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
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  });
  return app;
}

const RESOLVED = { fields: [], defaultSource: 103, defaultGroup: null, defaults: { notifyRequester: true, aiClassify: true, assignMode: 'none' } };

describe('/settings/ticket-form routes (Phase TF)', () => {
  const app = buildApp();

  beforeEach(() => {
    jest.clearAllMocks();
    ticketFormConfigServiceMock.getResolvedForm.mockResolvedValue(RESOLVED);
    ticketFormConfigServiceMock.update.mockResolvedValue(RESOLVED);
  });

  test('admins can read the resolved form', async () => {
    const res = await request(app).get('/settings/ticket-form').set('x-test-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(RESOLVED);
    expect(ticketFormConfigServiceMock.getResolvedForm).toHaveBeenCalledWith(1);
  });

  test('admin PUT passes the body and actor email through to the service', async () => {
    const body = { defaultSource: 3, fields: [{ key: 'group', visible: false }] };
    const res = await request(app).put('/settings/ticket-form').set('x-test-role', 'admin').send(body);
    expect(res.status).toBe(200);
    expect(ticketFormConfigServiceMock.update).toHaveBeenCalledWith(1, body, 'Admin@X.io');
  });

  test('service validation errors surface as 400', async () => {
    const { ValidationError } = await import('../src/utils/errors.js');
    ticketFormConfigServiceMock.update.mockRejectedValue(new ValidationError('Unknown form field "department"'));
    const res = await request(app).put('/settings/ticket-form').set('x-test-role', 'admin').send({ fields: [{ key: 'department' }] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Unknown form field/);
  });

  test('non-admins are rejected on both verbs, before the service runs', async () => {
    expect((await request(app).get('/settings/ticket-form')).status).toBe(403);
    expect((await request(app).put('/settings/ticket-form').send({ defaultSource: 3 })).status).toBe(403);
    expect(ticketFormConfigServiceMock.getResolvedForm).not.toHaveBeenCalled();
    expect(ticketFormConfigServiceMock.update).not.toHaveBeenCalled();
  });
});
