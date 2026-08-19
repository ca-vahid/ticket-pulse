import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Phase EB — /settings/sender-identity is admin-gated and workspace-scoped,
 * and the global settings PUT validates sendgrid_from_name.
 */

const identityServiceMock = {
  getSenderIdentity: jest.fn(),
  upsertSenderIdentity: jest.fn(),
  clearSenderIdentityCache: jest.fn(),
};

const settingsRepositoryMock = {
  getAll: jest.fn().mockResolvedValue({}),
  setMany: jest.fn().mockResolvedValue(1),
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
  requireWorkspace: (req, _res, next) => { req.workspaceId = 1; next(); },
}));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepositoryMock }));
jest.unstable_mockModule('../src/services/workspaceEmailIdentityService.js', () => ({
  getSenderIdentity: identityServiceMock.getSenderIdentity,
  upsertSenderIdentity: identityServiceMock.upsertSenderIdentity,
  clearSenderIdentityCache: identityServiceMock.clearSenderIdentityCache,
  default: identityServiceMock,
}));
jest.unstable_mockModule('../src/services/prisma.js', stub);
jest.unstable_mockModule('../src/services/technicianRepository.js', stub);
jest.unstable_mockModule('../src/services/groupRepository.js', stub);
jest.unstable_mockModule('../src/services/approvalCategoryService.js', stub);
jest.unstable_mockModule('../src/services/azureAdService.js', stub);
jest.unstable_mockModule('../src/services/syncService.js', stub);
jest.unstable_mockModule('../src/services/scheduledSyncService.js', () => ({
  default: { restart: jest.fn() },
}));
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

describe('sender identity routes (Phase EB)', () => {
  const app = buildApp();

  beforeEach(() => {
    jest.clearAllMocks();
    settingsRepositoryMock.getAll.mockResolvedValue({});
    settingsRepositoryMock.setMany.mockResolvedValue(1);
    identityServiceMock.getSenderIdentity.mockResolvedValue({
      workspaceId: 1,
      fromName: 'Ticket Pulse IT',
      globalFromName: 'Ticket Pulse',
      effectiveFromName: 'Ticket Pulse IT',
      fromEmail: 'ticketpulse@bgcengineering.ca',
      mailboxAddress: null,
    });
    identityServiceMock.upsertSenderIdentity.mockResolvedValue({
      workspaceId: 1,
      fromName: 'Ticket Pulse IT',
      effectiveFromName: 'Ticket Pulse IT',
    });
  });

  test('GET returns the workspace identity for admins', async () => {
    const res = await request(app).get('/settings/sender-identity').set('x-test-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.data.effectiveFromName).toBe('Ticket Pulse IT');
    expect(identityServiceMock.getSenderIdentity).toHaveBeenCalledWith(1);
  });

  test('PUT upserts the workspace override with the actor', async () => {
    const res = await request(app)
      .put('/settings/sender-identity')
      .set('x-test-role', 'admin')
      .send({ fromName: 'Ticket Pulse IT' });
    expect(res.status).toBe(200);
    expect(identityServiceMock.upsertSenderIdentity).toHaveBeenCalledWith(
      1,
      { fromName: 'Ticket Pulse IT' },
      null,
    );
  });

  test('non-admins are rejected before the service runs', async () => {
    expect((await request(app).get('/settings/sender-identity')).status).toBe(403);
    expect((await request(app).put('/settings/sender-identity').send({ fromName: 'X' })).status).toBe(403);
    expect(identityServiceMock.getSenderIdentity).not.toHaveBeenCalled();
    expect(identityServiceMock.upsertSenderIdentity).not.toHaveBeenCalled();
  });

  test('PUT rejects names with angle brackets or over 80 chars', async () => {
    const bad = await request(app)
      .put('/settings/sender-identity')
      .set('x-test-role', 'admin')
      .send({ fromName: 'Evil <spoof>' });
    expect(bad.status).toBe(400);

    const long = await request(app)
      .put('/settings/sender-identity')
      .set('x-test-role', 'admin')
      .send({ fromName: 'A'.repeat(81) });
    expect(long.status).toBe(400);
    expect(identityServiceMock.upsertSenderIdentity).not.toHaveBeenCalled();
  });

  test('global settings PUT accepts and trims sendgrid_from_name', async () => {
    const res = await request(app)
      .put('/settings')
      .set('x-test-role', 'admin')
      .send({ settings: { sendgrid_from_name: '  Ticket Pulse  ' } });
    expect(res.status).toBe(200);
    expect(settingsRepositoryMock.setMany).toHaveBeenCalledWith({ sendgrid_from_name: 'Ticket Pulse' });
    expect(identityServiceMock.clearSenderIdentityCache).toHaveBeenCalled();
  });

  test('global settings PUT rejects an invalid sendgrid_from_name', async () => {
    const res = await request(app)
      .put('/settings')
      .set('x-test-role', 'admin')
      .send({ settings: { sendgrid_from_name: 'Bad\nName' } });
    expect(res.status).toBe(400);
    expect(settingsRepositoryMock.setMany).not.toHaveBeenCalled();
  });
});
