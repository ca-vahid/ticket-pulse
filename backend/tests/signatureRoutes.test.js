import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Mega 08-15 Phase D — signature route contracts.
 *
 * Self routes (/agent/signature): session-email keyed — the owner is ALWAYS
 * the authenticated identity, so a body cannot target someone else.
 * Admin routes (/settings/signatures*): admin-gated management surface.
 */

const userSignatureServiceMock = {
  resolveSignatureWorkspaceId: jest.fn(),
  getSignature: jest.fn(),
  saveSignature: jest.fn(),
  listWorkspaceSignatures: jest.fn(),
  massApplySignatureTemplate: jest.fn(),
};

jest.unstable_mockModule('../src/middleware/errorHandler.js', () => ({
  asyncHandler: (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
}));
jest.unstable_mockModule('../src/services/userSignatureService.js', () => ({ default: userSignatureServiceMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ---- agent self routes ------------------------------------------------------

const agentStub = () => ({ default: {} });
jest.unstable_mockModule('../src/services/agentCompetencyService.js', agentStub);
jest.unstable_mockModule('../src/services/summitWorkshopService.js', agentStub);
jest.unstable_mockModule('../src/services/notificationPreferenceService.js', agentStub);
jest.unstable_mockModule('../src/services/agentAlertService.js', agentStub);

// ---- settings routes (same mock recipe as settingsApprovalCategoryRoutes) --

const roleOf = (req) => req.headers['x-test-role'] || 'viewer';
const requireAdminMock = jest.fn((req, res, next) => {
  if (roleOf(req) === 'admin') return next();
  return res.status(403).json({ success: false, error: 'Admin access required' });
});
jest.unstable_mockModule('../src/middleware/auth.js', () => ({
  requireAuth: (_req, _res, next) => next(),
  requireAdmin: requireAdminMock,
  requireReviewer: (_req, _res, next) => next(),
  requireWorkspaceAccess: (_req, _res, next) => next(),
  requireWorkspaceMemberOrAgent: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../src/middleware/workspace.js', () => ({
  requireWorkspace: (req, _res, next) => { req.workspaceId = 1; next(); },
}));
const stub = () => ({ default: {} });
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

const { default: agentRouter } = await import('../src/routes/agent.routes.js');
const { default: settingsRouter } = await import('../src/routes/settings.routes.js');

function buildApp({ sessionEmail = 'me@bgc.ca' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { user: { email: sessionEmail, role: 'agent' } };
    next();
  });
  app.use('/agent', agentRouter);
  app.use('/settings', settingsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  });
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  userSignatureServiceMock.resolveSignatureWorkspaceId.mockResolvedValue(1);
  userSignatureServiceMock.getSignature.mockResolvedValue({ workspaceId: 1, ownerEmail: 'me@bgc.ca', enabled: true, html: '<p>Sig</p>' });
  userSignatureServiceMock.saveSignature.mockResolvedValue({ workspaceId: 1, ownerEmail: 'me@bgc.ca', enabled: true, html: '<p>Sig</p>' });
  userSignatureServiceMock.listWorkspaceSignatures.mockResolvedValue({ members: [] });
  userSignatureServiceMock.massApplySignatureTemplate.mockResolvedValue({ preview: true, applied: 0, results: [], skipped: [] });
});

describe('/agent/signature (self-service)', () => {
  test('GET resolves the workspace for the SESSION email and returns the signature', async () => {
    const app = buildApp();
    const res = await request(app).get('/agent/signature?workspaceId=1');
    expect(res.status).toBe(200);
    expect(res.body.data.html).toBe('<p>Sig</p>');
    expect(userSignatureServiceMock.resolveSignatureWorkspaceId).toHaveBeenCalledWith('me@bgc.ca', '1');
    expect(userSignatureServiceMock.getSignature).toHaveBeenCalledWith(1, 'me@bgc.ca');
  });

  test('PUT saves for the SESSION identity — a spoofed owner in the body cannot target someone else', async () => {
    const app = buildApp();
    const res = await request(app).put('/agent/signature').send({
      workspaceId: 1,
      ownerEmail: 'victim@bgc.ca',
      email: 'victim@bgc.ca',
      html: '<p>Mine</p>',
      enabled: true,
    });
    expect(res.status).toBe(200);
    expect(userSignatureServiceMock.saveSignature).toHaveBeenCalledTimes(1);
    const [wsId, owner] = userSignatureServiceMock.saveSignature.mock.calls[0];
    expect(wsId).toBe(1);
    expect(owner).toBe('me@bgc.ca'); // never the body's victim address
  });
});

describe('/settings/signatures (admin management)', () => {
  test('admin: list, per-user edit, and mass-apply all reach the service', async () => {
    const app = buildApp();
    const asAdmin = (r) => r.set('x-test-role', 'admin');

    expect((await asAdmin(request(app).get('/settings/signatures'))).status).toBe(200);
    expect(userSignatureServiceMock.listWorkspaceSignatures).toHaveBeenCalledWith(1);

    const put = await asAdmin(request(app).put('/settings/signatures/ana%40bgc.ca').send({ enabled: false }));
    expect(put.status).toBe(200);
    expect(userSignatureServiceMock.saveSignature).toHaveBeenCalledWith(
      1, 'ana@bgc.ca', { enabled: false }, expect.objectContaining({ email: 'me@bgc.ca' }),
    );

    const mass = await asAdmin(request(app).post('/settings/signatures/mass-apply').send({
      template: '<p>{{name}}</p>', technicianIds: [11], preview: true,
    }));
    expect(mass.status).toBe(200);
    expect(userSignatureServiceMock.massApplySignatureTemplate).toHaveBeenCalledWith(
      1, { template: '<p>{{name}}</p>', technicianIds: [11], preview: true }, expect.anything(),
    );
  });

  test('non-admins are rejected before the service runs', async () => {
    const app = buildApp();
    expect((await request(app).get('/settings/signatures')).status).toBe(403);
    expect((await request(app).put('/settings/signatures/ana%40bgc.ca').send({ enabled: false })).status).toBe(403);
    expect((await request(app).post('/settings/signatures/mass-apply').send({ template: 'x' })).status).toBe(403);
    expect(userSignatureServiceMock.listWorkspaceSignatures).not.toHaveBeenCalled();
    expect(userSignatureServiceMock.saveSignature).not.toHaveBeenCalled();
    expect(userSignatureServiceMock.massApplySignatureTemplate).not.toHaveBeenCalled();
  });
});
