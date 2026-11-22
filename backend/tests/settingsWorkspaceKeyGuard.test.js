import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Second look on QA 11-19 item 2 (High): the generic settings writers
 * (PUT /api/settings, PUT /api/settings/:key) take ANY app_settings key behind
 * requireAdmin for the caller's OWN workspace, so an admin of workspace 2
 * could write `dashboard_viewers_ws1` and grant a workspace-1 agent (or
 * themselves) the ws1 Dashboard. Now, for everyone but super admins:
 *   - `dashboard_viewers_ws*` is refused (403): it changes under Members only;
 *   - any other key ending `_ws<N>` is refused unless N is the caller's
 *     admin workspace.
 * The real auth.js gates run here; the own-workspace Members route still works.
 */

const TECHS = [
  { id: 12, workspaceId: 1, name: 'Dana Fox', email: 'dana.fox@example.com', isActive: true },
];
const ACCESS = {
  'admin.two@example.com': { 2: 'admin' },
  'admin.one@example.com': { 1: 'admin' },
};
const settings = new Map();

const prismaMock = {
  technician: {
    findFirst: jest.fn(async ({ where }) => {
      const row = TECHS.find((t) => t.id === where.id && t.workspaceId === where.workspaceId);
      return row ? { id: row.id, name: row.name } : null;
    }),
  },
};
const settingsRepositoryMock = {
  get: jest.fn(async (key) => (settings.has(key) ? settings.get(key) : null)),
  set: jest.fn(async (key, value) => { settings.set(key, String(value)); return { key }; }),
  setMany: jest.fn(async (obj) => {
    for (const [k, v] of Object.entries(obj)) settings.set(k, String(v));
    return Object.keys(obj).length;
  }),
  getAll: jest.fn(async () => Object.fromEntries(settings)),
  getFreshServiceConfig: jest.fn(),
};

const stub = () => ({ default: {} });
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepositoryMock }));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({
  default: {
    getAccessRole: jest.fn(async (email, wsId) => ACCESS[String(email).toLowerCase()]?.[wsId] || null),
    hasActiveTechnician: jest.fn(async () => false),
    getAll: jest.fn().mockResolvedValue([]),
    getMergedWorkspaces: jest.fn().mockResolvedValue([]),
  },
  mergeWorkspaceLists: () => [],
}));
for (const mod of [
  'technicianRepository', 'groupRepository', 'approvalCategoryService', 'syncService',
  'emailHealthService', 'afterHoursUrgentEscalationService', 'userSignatureService',
  'llmConfigService', 'noiseRuleService', 'availabilityService', 'groupCoordinatorService',
]) {
  jest.unstable_mockModule(`../src/services/${mod}.js`, stub);
}
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
jest.unstable_mockModule('../src/routes/auth.routes.js', () => ({ default: express.Router(), resolveUserAccess: jest.fn() }));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient: jest.fn() }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: settingsRouter } = await import('../src/routes/settings.routes.js');
const { default: workspaceRoutes } = await import('../src/routes/workspace.routes.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const { resetDashboardViewerCache } = await import('../src/services/dashboardViewerService.js');

const USERS = {
  root: { email: 'root@example.com', role: 'admin' },
  adminTwo: { email: 'admin.two@example.com', role: 'viewer', selectedWorkspaceId: 2 },
  adminOne: { email: 'admin.one@example.com', role: 'viewer', selectedWorkspaceId: 1 },
};

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const who = USERS[req.headers['x-test-user']];
  req.session = who ? { user: { ...who } } : {};
  next();
});
app.use('/api/workspaces', workspaceRoutes);
app.use('/api/settings', settingsRouter);
app.use(errorHandler);

const as = (user, req) => req.set('x-test-user', user);

beforeEach(() => {
  settings.clear();
  resetDashboardViewerCache();
  jest.clearAllMocks();
});

describe('generic settings writers refuse another workspace\'s keys', () => {
  test('a ws2 admin cannot write dashboard_viewers_ws1 through PUT /settings/:key', async () => {
    const res = await as('adminTwo', request(app).put('/api/settings/dashboard_viewers_ws1').set('x-workspace-id', '2').send({ value: '[12]' }));
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Settings → Members/);
    expect(settings.has('dashboard_viewers_ws1')).toBe(false);
  });

  test('…nor through the bulk PUT /settings', async () => {
    const res = await as('adminTwo', request(app).put('/api/settings').set('x-workspace-id', '2')
      .send({ settings: { dashboard_viewers_ws1: '[12]' } }));
    expect(res.status).toBe(403);
    expect(settingsRepositoryMock.setMany).not.toHaveBeenCalled();
  });

  test('not even its own workspace\'s list: that changes under Members only', async () => {
    const res = await as('adminOne', request(app).put('/api/settings/dashboard_viewers_ws1').set('x-workspace-id', '1').send({ value: '[12]' }));
    expect(res.status).toBe(403);
  });

  test('any other `_ws<N>` key of another workspace is refused; its own is allowed', async () => {
    const foreign = await as('adminTwo', request(app).put('/api/settings/group_coordinators_ws1').set('x-workspace-id', '2').send({ value: '{}' }));
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe('workspace_mismatch');
    const bulk = await as('adminTwo', request(app).put('/api/settings').set('x-workspace-id', '2')
      .send({ settings: { sync_interval_minutes: 5, mail_subject_ws1: '{}' } }));
    expect(bulk.status).toBe(403);
    expect(settingsRepositoryMock.setMany).not.toHaveBeenCalled();
    const own = await as('adminTwo', request(app).put('/api/settings/group_coordinators_ws2').set('x-workspace-id', '2').send({ value: '{}' }));
    expect(own.status).toBe(200);
  });

  // 22 Nov 2026: global keys need a super admin now (see the block below).
  test('global keys no longer save for a workspace admin', async () => {
    const res = await as('adminTwo', request(app).put('/api/settings').set('x-workspace-id', '2')
      .send({ settings: { dashboard_refresh_seconds: 60 } }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('super_admin_required');
    expect(settings.has('dashboard_refresh_seconds')).toBe(false);
  });

  test('a super admin may write any of them', async () => {
    expect((await as('root', request(app).put('/api/settings/dashboard_viewers_ws1').send({ value: '[12]' }))).status).toBe(200);
    expect(settings.get('dashboard_viewers_ws1')).toBe('[12]');
    expect((await as('root', request(app).put('/api/settings').set('x-workspace-id', '2')
      .send({ settings: { group_coordinators_ws1: '{}' } }))).status).toBe(200);
  });
});

/**
 * 22 Nov 2026: company-wide settings for super admins only. Every key that is
 * not a `_ws<N>` key of the caller's own admin workspace is global and needs a
 * super admin; a workspace admin gets 403 with a plain sentence.
 */
const SETTINGS_PAGE_GLOBAL_KEYS = {
  // The fixed list the Settings page saves (pages/Settings.jsx sectionKeys).
  freshservice_domain: 'example', freshservice_api_key: 'fs-secret-1', service_account_names: 'Ticket Pulse',
  sendgrid_api_key: 'SG.secret', sendgrid_from_email: 'tickets@example.com', sendgrid_from_name: 'Ticket Pulse',
  twilio_account_sid: 'AC123', twilio_auth_token: 'tw-secret', twilio_from_number: '+16045550100',
  sync_interval_minutes: 5, default_timezone: 'America/Vancouver', dashboard_refresh_seconds: 30,
};

describe('company-wide settings need a super admin', () => {
  test.each(Object.keys(SETTINGS_PAGE_GLOBAL_KEYS))('a workspace admin is refused %s on PUT /settings/:key', async (key) => {
    const res = await as('adminOne', request(app).put(`/api/settings/${key}`).set('x-workspace-id', '1').send({ value: String(SETTINGS_PAGE_GLOBAL_KEYS[key]) }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('super_admin_required');
    expect(res.body.message).toBe('Only a super admin can change company-wide settings.');
    expect(settingsRepositoryMock.set).not.toHaveBeenCalled();
  });

  test('a workspace admin is refused the whole Settings-page bundle on PUT /settings', async () => {
    const res = await as('adminOne', request(app).put('/api/settings').set('x-workspace-id', '1').send({ settings: SETTINGS_PAGE_GLOBAL_KEYS }));
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Only a super admin can change company-wide settings.');
    expect(settingsRepositoryMock.setMany).not.toHaveBeenCalled();
  });

  test('…and the super admin list itself (admin_emails) through the generic writer', async () => {
    const res = await as('adminOne', request(app).put('/api/settings/admin_emails').set('x-workspace-id', '1').send({ value: 'admin.one@example.com' }));
    expect(res.status).toBe(403);
    expect(settings.has('admin_emails')).toBe(false);
  });

  test('…not even a super admin may change admin_emails through the generic writers (Access history records only /admins)', async () => {
    const single = await as('root', request(app).put('/api/settings/admin_emails').send({ value: 'someone@example.com' }));
    expect(single.status).toBe(403);
    expect(single.body.code).toBe('setting_not_writable');
    const bulk = await as('root', request(app).put('/api/settings').set('x-workspace-id', '1').send({ settings: { admin_emails: 'someone@example.com' } }));
    expect(bulk.status).toBe(403);
    expect(settings.has('admin_emails')).toBe(false);
  });

  test('one global key in a bulk save with an own-workspace key refuses the lot', async () => {
    const res = await as('adminOne', request(app).put('/api/settings').set('x-workspace-id', '1')
      .send({ settings: { mail_subject_ws1: '{}', sendgrid_from_name: 'Desk' } }));
    expect(res.status).toBe(403);
    expect(settingsRepositoryMock.setMany).not.toHaveBeenCalled();
  });

  test('a workspace admin may still write their own workspace\'s `_ws` keys, on both routes', async () => {
    const single = await as('adminOne', request(app).put('/api/settings/mail_subject_ws1').set('x-workspace-id', '1').send({ value: '{"a":1}' }));
    expect(single.status).toBe(200);
    expect(settings.get('mail_subject_ws1')).toBe('{"a":1}');
    const bulk = await as('adminOne', request(app).put('/api/settings').set('x-workspace-id', '1').send({ settings: { group_coordinators_ws1: '{}' } }));
    expect(bulk.status).toBe(200);
    expect(settings.get('group_coordinators_ws1')).toBe('{}');
  });

  test('a super admin saves the Settings-page bundle and single global keys', async () => {
    const bulk = await as('root', request(app).put('/api/settings').set('x-workspace-id', '1').send({ settings: SETTINGS_PAGE_GLOBAL_KEYS }));
    expect(bulk.status).toBe(200);
    expect(settings.get('freshservice_api_key')).toBe('fs-secret-1');
    expect(settings.get('sync_interval_minutes')).toBe('5');
    const single = await as('root', request(app).put('/api/settings/dashboard_refresh_seconds').send({ value: '45' }));
    expect(single.status).toBe(200);
    expect(settings.get('dashboard_refresh_seconds')).toBe('45');
  });

  test('a masked value sent back is never stored as the secret', async () => {
    settings.set('sendgrid_event_webhook_token', 'real-token');
    const res = await as('root', request(app).put('/api/settings').send({ settings: { sendgrid_event_webhook_token: '***MASKED***', sendgrid_from_name: 'Desk' } }));
    expect(res.status).toBe(200);
    expect(settings.get('sendgrid_event_webhook_token')).toBe('real-token');
    expect(settings.get('sendgrid_from_name')).toBe('Desk');
  });

  test('PUT /settings/:key keeps the real secret when sent the mask or a blank', async () => {
    settings.set('freshservice_api_key', 'fs-real');
    settings.set('sendgrid_event_webhook_token', 'real-token');
    for (const [key, value] of [['freshservice_api_key', '***MASKED***'], ['freshservice_api_key', ''], ['sendgrid_event_webhook_token', '***MASKED***']]) {
      const res = await as('root', request(app).put(`/api/settings/${key}`).send({ value }));
      expect(res.status).toBe(200);
      expect(res.body.unchanged).toBe(true);
    }
    expect(settings.get('freshservice_api_key')).toBe('fs-real');
    expect(settings.get('sendgrid_event_webhook_token')).toBe('real-token');
    expect(settingsRepositoryMock.set).not.toHaveBeenCalled();
    // A blank non-secret still saves; a real new secret still saves.
    expect((await as('root', request(app).put('/api/settings/service_account_names').send({ value: '' }))).status).toBe(200);
    expect(settings.get('service_account_names')).toBe('');
    await as('root', request(app).put('/api/settings/freshservice_api_key').send({ value: 'fs-new' }));
    expect(settings.get('freshservice_api_key')).toBe('fs-new');
  });
});

describe('GET /settings never returns secrets', () => {
  test('the three provider secrets and any other secret-named key are masked', async () => {
    for (const [k, v] of Object.entries({
      freshservice_api_key: 'fs-secret-1', sendgrid_api_key: 'SG.secret', twilio_auth_token: 'tw-secret',
      sendgrid_event_webhook_token: 'bounce-token', some_client_secret_ws1: 'abc', sendgrid_from_email: 'tickets@example.com',
    })) settings.set(k, v);
    for (const user of ['adminOne', 'root']) {
      const res = await as(user, request(app).get('/api/settings').set('x-workspace-id', '1'));
      expect(res.status).toBe(200);
      const text = JSON.stringify(res.body.data);
      for (const secret of ['fs-secret-1', 'SG.secret', 'tw-secret', 'bounce-token', '"abc"']) expect(text).not.toContain(secret);
      expect(res.body.data.sendgrid_event_webhook_token).toBe('***MASKED***');
      expect(res.body.data.sendgrid_from_email).toBe('tickets@example.com');
    }
  });
});

describe('PUT /settings/admins (the Super admins panel)', () => {
  test('a super admin saves the list (it was answered by PUT /:key with 400 before)', async () => {
    const res = await as('root', request(app).put('/api/settings/admins').send({ emails: ['root@example.com', 'Priya.Nair@example.com'] }));
    expect(res.status).toBe(200);
    expect(res.body.data.emails).toEqual(['root@example.com', 'priya.nair@example.com']);
    expect(settings.get('admin_emails')).toBe('root@example.com,priya.nair@example.com');
  });

  test('a workspace admin is refused', async () => {
    const res = await as('adminOne', request(app).put('/api/settings/admins').set('x-workspace-id', '1').send({ emails: ['admin.one@example.com'] }));
    expect(res.status).toBe(403);
    expect(settings.has('admin_emails')).toBe(false);
  });
});

describe('the own-workspace path is unchanged', () => {
  test('a ws1 admin grants a ws1 agent under Members (workspace.routes)', async () => {
    const res = await as('adminOne', request(app).put('/api/workspaces/1/dashboard-viewers/12').send({ enabled: true }));
    expect(res.status).toBe(200);
    expect(settings.get('dashboard_viewers_ws1')).toBe('[12]');
  });

  test('a ws2 admin cannot use that route for workspace 1 either', async () => {
    const res = await as('adminTwo', request(app).put('/api/workspaces/1/dashboard-viewers/12').send({ enabled: true }));
    expect(res.status).toBe(403);
    expect(settings.has('dashboard_viewers_ws1')).toBe(false);
  });
});
