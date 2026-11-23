import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Personal API keys (4.4.05), the app's session routes and the hooks around
 * them:
 *   - /api/me/api-keys (owner) and /api/admin/personal-api-keys (admin of THIS
 *     workspace or super admin) reach the service with the right arguments;
 *   - the access list is never written through the generic settings writers,
 *     not even by a super admin (it is an audited access grant);
 *   - offboarding: removing someone's workspace access, or switching their
 *     agent profile off, revokes their personal keys.
 */
const ACCESS = { 'admin.one@example.com': { 1: 'admin' }, 'dana.fox@example.com': { 1: 'viewer' } };
const settings = new Map();
const prismaMock = { technician: { findFirst: jest.fn().mockResolvedValue(null) } };
const settingsRepositoryMock = {
  get: jest.fn(async (key) => (settings.has(key) ? settings.get(key) : null)),
  set: jest.fn(async (key, value) => { settings.set(key, String(value)); return { key }; }),
  setMany: jest.fn(async (obj) => Object.keys(obj).length),
  getAll: jest.fn(async () => Object.fromEntries(settings)),
  getFreshServiceConfig: jest.fn(),
};
const workspaceRepoMock = {
  getAccessRole: jest.fn(async (email, wsId) => ACCESS[String(email).toLowerCase()]?.[wsId] || null),
  hasActiveTechnician: jest.fn(async () => true),
  revokeAccess: jest.fn(async () => true),
  getAll: jest.fn().mockResolvedValue([]),
  getMergedWorkspaces: jest.fn().mockResolvedValue([]),
};
const technicianRepoMock = { update: jest.fn(), getById: jest.fn() };
const personalSvcMock = {
  getOwnerOverview: jest.fn().mockResolvedValue({ enabled: true, keys: [] }),
  ownerGuide: jest.fn().mockResolvedValue({ markdown: '# g', filename: 'ticket-pulse-api-guide.md' }),
  createOwnKey: jest.fn().mockResolvedValue({ key: { id: 1 }, secret: 'tpu_x' }),
  rotateOwnKey: jest.fn().mockResolvedValue({ key: { id: 2 }, secret: 'tpu_y' }),
  revokeOwnKey: jest.fn().mockResolvedValue({ revoked: true }),
  adminList: jest.fn().mockResolvedValue({ enabled: true, keys: [] }),
  adminUsers: jest.fn().mockResolvedValue({ technicianIds: [12], people: [] }),
  adminSetUsers: jest.fn().mockResolvedValue({ technicianIds: [], revokedKeyIds: [31] }),
  adminSetDisabled: jest.fn().mockResolvedValue({ id: 31, status: 'disabled' }),
  adminRevoke: jest.fn().mockResolvedValue({ revoked: true }),
};
const revokeForEmail = jest.fn().mockResolvedValue([31]);
const revokeForTechnician = jest.fn().mockResolvedValue([31]);

const stub = () => ({ default: {} });
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepositoryMock }));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({ default: workspaceRepoMock, mergeWorkspaceLists: () => [] }));
jest.unstable_mockModule('../src/services/technicianRepository.js', () => ({ default: technicianRepoMock }));
jest.unstable_mockModule('../src/services/personalApiKeyService.js', () => ({ default: personalSvcMock, revokeForEmail, revokeForTechnician }));
for (const mod of [
  'groupRepository', 'approvalCategoryService', 'syncService', 'emailHealthService', 'afterHoursUrgentEscalationService',
  'userSignatureService', 'llmConfigService', 'noiseRuleService', 'availabilityService', 'groupCoordinatorService',
]) {
  jest.unstable_mockModule(`../src/services/${mod}.js`, stub);
}
jest.unstable_mockModule('../src/services/accessAuditService.js', () => ({
  recordAccessEvent: jest.fn().mockResolvedValue({}), recordCredentialEvent: jest.fn().mockResolvedValue({}), listAccessEvents: jest.fn(),
  ACTIONS: { ACCESS_REVOKED: 'access_revoked', ROLE_GRANTED: 'role_granted', ROLE_CHANGED: 'role_changed', DASHBOARD_VIEW_CHANGED: 'dashboard_view_changed', ADMIN_LIST_CHANGED: 'admin_list_changed' },
  default: {},
}));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { isConfigured: () => false, searchUsers: jest.fn() } }));
jest.unstable_mockModule('../src/services/scheduledSyncService.js', () => ({ default: { restart: jest.fn(), startForWorkspace: jest.fn() } }));
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
jest.unstable_mockModule('../src/services/workspaceEmailIdentityService.js', () => ({
  getSenderIdentity: jest.fn(), upsertSenderIdentity: jest.fn(), clearSenderIdentityCache: jest.fn(), default: {},
}));
jest.unstable_mockModule('../src/routes/auth.routes.js', () => ({ default: express.Router(), resolveUserAccess: jest.fn(), getAdminEmails: jest.fn(async () => []) }));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient: jest.fn() }));
jest.unstable_mockModule('../src/utils/publicBaseUrl.js', () => ({ resolvePublicBaseUrl: () => 'https://tickets.example.com' }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { personalKeysOwnerRouter, personalKeysAdminRouter } = await import('../src/routes/personalApiKeys.routes.js');
const { default: settingsRouter } = await import('../src/routes/settings.routes.js');
const { default: workspaceRoutes } = await import('../src/routes/workspace.routes.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const { requireWorkspace } = await import('../src/middleware/workspace.js');

const USERS = {
  root: { email: 'root@example.com', role: 'admin' },
  adminOne: { email: 'admin.one@example.com', role: 'viewer', selectedWorkspaceId: 1 },
  dana: { email: 'dana.fox@example.com', role: 'viewer', selectedWorkspaceId: 1 },
};

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const who = USERS[req.headers['x-test-user']];
  req.session = who ? { user: { ...who } } : {};
  next();
});
app.use('/api/me/api-keys', requireWorkspace, personalKeysOwnerRouter);
app.use('/api/admin/personal-api-keys', requireWorkspace, personalKeysAdminRouter);
app.use('/api/workspaces', workspaceRoutes);
app.use('/api/settings', settingsRouter);
app.use(errorHandler);

const as = (user, req) => req.set('x-test-user', user).set('x-workspace-id', '1');

beforeEach(() => {
  settings.clear();
  jest.clearAllMocks();
});

describe('owner routes', () => {
  test('GET, guide, create, rotate and revoke reach the service as the signed-in person', async () => {
    await as('dana', request(app).get('/api/me/api-keys')).expect(200);
    expect(personalSvcMock.getOwnerOverview).toHaveBeenCalledWith(1, expect.objectContaining({ email: 'dana.fox@example.com' }));
    const guide = await as('dana', request(app).get('/api/me/api-keys/guide')).expect(200);
    expect(guide.body.data.filename).toBe('ticket-pulse-api-guide.md');
    expect(personalSvcMock.ownerGuide).toHaveBeenCalledWith(1, expect.objectContaining({ email: 'dana.fox@example.com' }), { baseUrl: 'https://tickets.example.com' });
    const created = await as('dana', request(app).post('/api/me/api-keys')).send({ name: 'Script', abilities: ['reply'], expiresInDays: 90 }).expect(201);
    expect(created.body.data.secret).toBe('tpu_x');
    expect(personalSvcMock.createOwnKey).toHaveBeenCalledWith(1, expect.objectContaining({ email: 'dana.fox@example.com' }), { name: 'Script', abilities: ['reply'], expiresInDays: 90 }, expect.any(Object));
    await as('dana', request(app).post('/api/me/api-keys/5/rotate')).expect(200);
    expect(personalSvcMock.rotateOwnKey).toHaveBeenCalledWith(1, expect.anything(), '5', expect.any(Object));
    expect((await as('dana', request(app).delete('/api/me/api-keys/5')).expect(200)).body).toEqual({ success: true });
  });

  test('no session is 401', async () => {
    await request(app).get('/api/me/api-keys').set('x-workspace-id', '1').expect(401);
  });

  test('a personal key cannot manage keys: the session routes refuse a tpu_ bearer (it is not a sign-in)', async () => {
    const { requireAuth } = await import('../src/middleware/auth.js');
    const gated = express();
    gated.use(express.json());
    gated.use('/api', requireAuth);
    gated.use('/api/me/api-keys', requireWorkspace, personalKeysOwnerRouter);
    gated.use('/api/admin/personal-api-keys', requireWorkspace, personalKeysAdminRouter);
    gated.use(errorHandler);
    for (const [method, path] of [['post', '/api/me/api-keys'], ['post', '/api/me/api-keys/5/rotate'], ['get', '/api/admin/personal-api-keys'], ['put', '/api/admin/personal-api-keys/users']]) {
      await request(gated)[method](path).set('Authorization', 'Bearer tpu_personal-secret-for-jest-0001').set('x-workspace-id', '1').send({}).expect(401);
    }
    expect(personalSvcMock.createOwnKey).not.toHaveBeenCalled();
    expect(personalSvcMock.rotateOwnKey).not.toHaveBeenCalled();
    expect(personalSvcMock.adminSetUsers).not.toHaveBeenCalled();
  });
});

describe('admin routes', () => {
  test('a workspace admin and a super admin pass; a member is 403 admin_required', async () => {
    await as('adminOne', request(app).get('/api/admin/personal-api-keys')).expect(200);
    await as('root', request(app).get('/api/admin/personal-api-keys/users')).expect(200);
    const refused = await as('dana', request(app).get('/api/admin/personal-api-keys')).expect(403);
    expect(refused.body.code).toBe('admin_required');
    await as('dana', request(app).put('/api/admin/personal-api-keys/users')).send({ technicianIds: [12] }).expect(403);
    expect(personalSvcMock.adminSetUsers).not.toHaveBeenCalled();
  });

  test('PUT users, PATCH and DELETE pass the actor through', async () => {
    const put = await as('adminOne', request(app).put('/api/admin/personal-api-keys/users')).send({ technicianIds: [14] }).expect(200);
    expect(put.body.data).toEqual({ technicianIds: [], revokedKeyIds: [31] });
    expect(personalSvcMock.adminSetUsers).toHaveBeenCalledWith(1, [14], expect.objectContaining({ email: 'admin.one@example.com' }));
    await as('adminOne', request(app).patch('/api/admin/personal-api-keys/31')).send({ disabled: true }).expect(200);
    expect(personalSvcMock.adminSetDisabled).toHaveBeenCalledWith(1, '31', true, expect.objectContaining({ email: 'admin.one@example.com' }));
    await as('adminOne', request(app).delete('/api/admin/personal-api-keys/31')).expect(200);
    expect(personalSvcMock.adminRevoke).toHaveBeenCalledWith(1, '31', expect.objectContaining({ email: 'admin.one@example.com' }));
  });
});

describe('the access list is never written through the generic settings writers', () => {
  test('refused for a workspace admin and for a super admin, on both writers', async () => {
    for (const user of ['adminOne', 'root']) {
      const single = await as(user, request(app).put('/api/settings/personal_api_key_users_ws1').send({ value: '[12]' }));
      expect(single.status).toBe(403);
      expect(single.body.code).toBe('setting_not_writable');
      const bulk = await as(user, request(app).put('/api/settings').send({ settings: { personal_api_key_users_ws1: '[12]' } }));
      expect(bulk.status).toBe(403);
    }
    expect(settings.has('personal_api_key_users_ws1')).toBe(false);
    expect(settingsRepositoryMock.setMany).not.toHaveBeenCalled();
  });
});

describe('offboarding revokes personal keys', () => {
  test('removing someone\'s workspace access revokes their keys in that workspace', async () => {
    await as('adminOne', request(app).delete('/api/workspaces/1/access/dana.fox@example.com')).expect(200);
    expect(revokeForEmail).toHaveBeenCalledWith(1, 'dana.fox@example.com', { reason: 'offboarded', actorEmail: 'admin.one@example.com' });
  });

  test('switching an agent off revokes their keys; switching one on does not', async () => {
    technicianRepoMock.update.mockResolvedValue({ id: 12, workspaceId: 1, name: 'Dana Fox', isActive: false });
    await as('adminOne', request(app).put('/api/settings/technicians/12/active')).send({ isActive: false }).expect(200);
    expect(revokeForTechnician).toHaveBeenCalledWith(1, 12, { reason: 'offboarded', actorEmail: 'admin.one@example.com' });
    revokeForTechnician.mockClear();
    technicianRepoMock.update.mockResolvedValue({ id: 12, workspaceId: 1, name: 'Dana Fox', isActive: true });
    await as('adminOne', request(app).put('/api/settings/technicians/12/active')).send({ isActive: true }).expect(200);
    expect(revokeForTechnician).not.toHaveBeenCalled();
  });

  test('a revoke failure never fails the switch-off itself', async () => {
    revokeForTechnician.mockRejectedValueOnce(new Error('db down'));
    technicianRepoMock.update.mockResolvedValue({ id: 12, workspaceId: 1, name: 'Dana Fox', isActive: false });
    await as('adminOne', request(app).put('/api/settings/technicians/12/active')).send({ isActive: false }).expect(200);
  });
});
