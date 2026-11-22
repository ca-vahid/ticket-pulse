import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * 22 Nov 2026 — the Dashboard refuses outsiders.
 *
 * Since 4.3.99 /api/dashboard is mounted ABOVE the strict workspace gate, on
 * its own tier (requireDashboardView). That tier trusts requireAuth to have
 * run first. Pinned here with the REAL routes/index.js, the REAL auth and
 * workspace middleware, the REAL error handler, the REAL /api/v1 router with
 * its REAL key/OAuth auth, and a Dashboard router that only records whether
 * it was reached:
 *   - no session and no token → 401, the Dashboard is never reached;
 *   - a v1 API key or a v1 OAuth access token (valid on /api/v1) → 401 on
 *     /api/dashboard, in the header or in ?token=, and never reached;
 *   - control: a signed-in admin does reach it, so the 401s mean something.
 */

// ---- in-memory credentials for the v1 API ----------------------------------
const API_KEY_ROW = {
  id: 41, workspaceId: 1, name: 'Example integration', keyPrefix: 'tp_live_example', mode: 'live',
  scopes: ['*'], ipAllowlist: [], rateLimitPerMin: null, isEnabled: true, revokedAt: null, expiresAt: null, trustedIntake: false,
};
const OAUTH_CLIENT_ROW = {
  id: 7, workspaceId: 1, clientId: 'tpc_example', name: 'Example OAuth client', scopes: ['*'],
  isEnabled: true, revokedAt: null, expiresAt: null, ipAllowlist: [],
};
let apiKeyHash = null;

const prismaMock = {
  apiKey: {
    findUnique: jest.fn(async ({ where }) => (where.keyHash === apiKeyHash ? API_KEY_ROW : null)),
    update: jest.fn(async () => ({})),
  },
  oAuthClient: {
    findUnique: jest.fn(async ({ where }) => (where.clientId === OAUTH_CLIENT_ROW.clientId ? OAUTH_CLIENT_ROW : null)),
    update: jest.fn(async () => ({})),
  },
  apiRequestLog: { create: jest.fn(async () => ({})) },
  workspace: { findUnique: jest.fn(async () => ({ id: 1, name: 'IT', slug: 'it' })) },
  technician: { findFirst: jest.fn(async () => null) },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), http: jest.fn() },
}));
const getAccessRole = jest.fn(async () => null);
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({
  default: { getAccessRole, hasActiveTechnician: jest.fn(async () => false) },
}));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: { get: jest.fn(async () => null), set: jest.fn() },
}));
jest.unstable_mockModule('../src/services/analyticsService.js', () => ({ default: { getCategoryMetadata: jest.fn() } }));
jest.unstable_mockModule('../src/services/availabilityService.js', () => ({ default: { getHolidays: jest.fn() } }));
jest.unstable_mockModule('../src/services/apiRateLimitService.js', () => ({
  default: { hit: jest.fn(async () => ({ allowed: true, limit: 120, remaining: 119, reset: 0 })) },
}));
// /api/v1 neighbours (same set as apiV1ReadLimits.test.js).
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: { getTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/technicianRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/groupRepository.js', () => ({ default: { listForWorkspace: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketResubmissionService.js', () => ({
  default: { findByExternalRef: jest.fn(), deriveExternalRef: jest.fn(), applyResubmission: jest.fn() }, normalizeExternalRef: (v) => v,
}));
jest.unstable_mockModule('../src/middleware/apiIdempotency.js', () => ({ withIdempotency: (_req, _res, next) => next() }));

// ---- every other route module index.js mounts, stubbed ----------------------
const stubRouter = (name) => {
  const r = express.Router();
  r.all('*', (_req, res) => res.json({ ok: true, mount: name }));
  return r;
};
for (const name of [
  'auth', 'workspace', 'settings', 'sync', 'sse', 'photos', 'webhook', 'freshserviceWebhook', 'teamsAutofill',
  'availability', 'autoresponse', 'llmAdmin', 'aiUsage', 'visuals', 'noise', 'alertCorrelation', 'vacationTracker',
  'calendarLeave', 'notifications', 'notificationWorkflow', 'assignment', 'aiProvider', 'analytics', 'agent',
  'statuses', 'search', 'backup', 'knowledge', 'tone', 'handBacks', 'teamRoutingSettings', 'hrLifecycle',
  'urgentResponse', 'ticketGrouping', 'assignmentSpread', 'assignmentLevelMatch', 'assignmentShares', 'usage', 'siteStats',
]) {
  jest.unstable_mockModule(`../src/routes/${name}.routes.js`, () => ({ default: stubRouter(name) }));
}
jest.unstable_mockModule('../src/routes/teams.routes.js', () => ({ teamsBotRouter: stubRouter('teams-bot'), teamsAdminRouter: stubRouter('teams-admin') }));
jest.unstable_mockModule('../src/routes/summit.routes.js', () => ({ default: stubRouter('summit'), summitPublicRouter: stubRouter('summit-public') }));
jest.unstable_mockModule('../src/routes/publicTicketStatus.routes.js', () => ({ publicTicketStatusPublicRouter: stubRouter('ticket-status-public') }));
jest.unstable_mockModule('../src/routes/tickets.routes.js', () => ({
  default: stubRouter('tickets'), ticketApprovalPublicRouter: stubRouter('approvals-public'), approvalReplyPublicRouter: stubRouter('approvals-reply'),
}));

// The Dashboard router: records every request that reaches it.
const dashboardReached = jest.fn();
jest.unstable_mockModule('../src/routes/dashboard.routes.js', () => {
  const r = express.Router();
  r.all('*', (req, res) => { dashboardReached(req.method, req.path); res.json({ ok: true, mount: 'dashboard' }); });
  return { default: r };
});

const { default: apiRouter } = await import('../src/routes/index.js');
const { errorHandler, notFoundHandler } = await import('../src/middleware/errorHandler.js');
const { generateApiKey } = await import('../src/services/apiKeyService.js');
const { issueAccessToken } = await import('../src/services/oauthClientService.js');

const SESSIONS = {
  admin: { email: 'dana.fox@example.com', role: 'admin', selectedWorkspaceId: 1 },
};

function makeApp() {
  const app = express();
  app.use(express.json());
  // express-session stand-in: a cookie names a session; no cookie, an empty one.
  app.use((req, _res, next) => {
    const who = SESSIONS[req.headers['x-test-session']];
    req.session = who ? { user: { ...who } } : {};
    next();
  });
  app.use('/api', apiRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
const app = makeApp();

const DASHBOARD_PATHS = ['/api/dashboard', '/api/dashboard/weekly', '/api/dashboard/monthly', '/api/dashboard/technician/12'];
let apiKey;
let oauthToken;

beforeAll(() => {
  const key = generateApiKey('live');
  apiKey = key.raw;
  apiKeyHash = key.hash;
  oauthToken = issueAccessToken(OAUTH_CLIENT_ROW).access_token;
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('control: the credentials are real and the Dashboard is wired', () => {
  test('the API key and the OAuth token both work on /api/v1', async () => {
    const byKey = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${apiKey}`);
    expect(byKey.status).toBe(200);
    expect(byKey.body.data.authType).toBe('api_key');
    const byOauth = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${oauthToken}`);
    expect(byOauth.status).toBe(200);
    expect(byOauth.body.data.authType).toBe('oauth');
  });

  test('a signed-in admin reaches the Dashboard', async () => {
    const res = await request(app).get('/api/dashboard').set('x-test-session', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.mount).toBe('dashboard');
    expect(dashboardReached).toHaveBeenCalledTimes(1);
  });
});

describe('no session', () => {
  test.each(DASHBOARD_PATHS)('GET %s → 401, never reached', async (path) => {
    const res = await request(app).get(path).set('x-workspace-id', '1');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(dashboardReached).not.toHaveBeenCalled();
  });

  test('without a workspace header too (401 before the workspace check)', async () => {
    const res = await request(app).get('/api/dashboard');
    expect(res.status).toBe(401);
    expect(dashboardReached).not.toHaveBeenCalled();
  });

  test('the Dashboard viewer router beside it does not answer an outsider either', async () => {
    const res = await request(app).get('/api/dashboard-access').set('x-workspace-id', '1');
    expect(res.status).toBe(401);
  });
});

describe('a v1 API credential is not a session', () => {
  test.each(DASHBOARD_PATHS)('API key in the Authorization header: GET %s → 401, never reached', async (path) => {
    const res = await request(app).get(path).set('Authorization', `Bearer ${apiKey}`).set('x-workspace-id', '1');
    expect(res.status).toBe(401);
    expect(dashboardReached).not.toHaveBeenCalled();
    // The key was never even looked up: only /api/v1 resolves keys.
    expect(prismaMock.apiKey.findUnique).not.toHaveBeenCalled();
  });

  test.each(DASHBOARD_PATHS)('OAuth access token: GET %s → 401, never reached', async (path) => {
    const res = await request(app).get(path).set('Authorization', `Bearer ${oauthToken}`).set('x-workspace-id', '1');
    expect(res.status).toBe(401);
    expect(dashboardReached).not.toHaveBeenCalled();
  });

  test('the ?token= promotion (meant for EventSource) does not let a key in', async () => {
    for (const token of [apiKey, oauthToken]) {
      const res = await request(app).get(`/api/dashboard?token=${encodeURIComponent(token)}&workspaceId=1`);
      expect(res.status).toBe(401);
    }
    expect(dashboardReached).not.toHaveBeenCalled();
  });

  test('a key never reaches the access lookups the Dashboard tier makes', async () => {
    await request(app).get('/api/dashboard').set('Authorization', `Bearer ${apiKey}`).set('x-workspace-id', '1');
    expect(getAccessRole).not.toHaveBeenCalled();
  });
});
