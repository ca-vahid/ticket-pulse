import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * QA 11-19 item 2 — Dashboard view grant.
 *
 * An admin lets one agent open the Dashboard read-only (Settings → Members →
 * "Can see the Dashboard"). The list lives in app_settings as
 * dashboard_viewers_ws<N> = [technician ids]. Pinned here with the REAL
 * middleware (auth.js), the REAL service and the REAL routers, over an
 * in-memory technician table and settings store:
 *   - a listed agent GETs the Dashboard endpoints (200), never writes (403);
 *   - an unlisted agent gets 403; removing them from the list removes access;
 *   - the grant is scoped to the workspace that gave it;
 *   - only admins read or change the list;
 *   - the two extra page reads answer listed viewers only and let everyone
 *     else fall through to their normal gates.
 */

// ---- in-memory data ---------------------------------------------------------
const TECHS = [
  { id: 12, workspaceId: 1, name: 'Dana Fox', email: 'dana.fox@example.com', isActive: true },
  { id: 13, workspaceId: 1, name: 'Eli Park', email: 'eli.park@example.com', isActive: true },
  { id: 14, workspaceId: 1, name: 'Priya Nair', email: 'priya.nair@example.com', isActive: false },
  { id: 21, workspaceId: 2, name: 'Sam Okafor', email: 'sam.okafor@example.com', isActive: true },
];
// workspace_access rows: email → { wsId: role }
const ACCESS = {
  'admin.one@example.com': { 1: 'admin' },
  'eli.park@example.com': { 1: 'viewer' },
  'olive.reader@example.com': { 1: 'readonly' },
};
const settings = new Map();

function matches(row, where = {}) {
  for (const [k, cond] of Object.entries(where)) {
    const v = row[k];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if (Array.isArray(cond.in) && !cond.in.includes(v)) return false;
      if (cond.equals !== undefined) {
        const a = cond.mode === 'insensitive' ? String(v || '').toLowerCase() : v;
        const b = cond.mode === 'insensitive' ? String(cond.equals || '').toLowerCase() : cond.equals;
        if (a !== b) return false;
      }
    } else if (v !== cond) {
      return false;
    }
  }
  return true;
}

const prismaMock = {
  technician: {
    findFirst: jest.fn(async ({ where }) => {
      const row = TECHS.find((t) => matches(t, where));
      return row ? { id: row.id, name: row.name } : null;
    }),
  },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: {
    get: jest.fn(async (key) => (settings.has(key) ? settings.get(key) : null)),
    set: jest.fn(async (key, value) => { settings.set(key, String(value)); return { key, value }; }),
    getFreshServiceConfig: jest.fn(),
  },
}));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({
  default: {
    getAccessRole: jest.fn(async (email, wsId) => ACCESS[String(email).toLowerCase()]?.[wsId] || null),
    hasActiveTechnician: jest.fn(async (email, wsId) => TECHS.some((t) => t.workspaceId === wsId && t.isActive && t.email === String(email).toLowerCase())),
    getAll: jest.fn().mockResolvedValue([]),
    getMergedWorkspaces: jest.fn().mockResolvedValue([]),
  },
  mergeWorkspaceLists: () => [],
}));
const analyticsMock = { getCategoryMetadata: jest.fn(async () => ({ categoryMode: 'canonical', categoryTree: [] })) };
jest.unstable_mockModule('../src/services/analyticsService.js', () => ({ default: analyticsMock }));
const availabilityMock = {
  getHolidays: jest.fn(async () => [{ date: '2026-12-25', name: 'Christmas Day' }]),
  initializeDefaultBusinessHours: jest.fn(),
};
jest.unstable_mockModule('../src/services/availabilityService.js', () => ({ default: availabilityMock }));
// workspace.routes.js neighbours (same set as workspaceAccessRoutes.test.js).
jest.unstable_mockModule('../src/routes/auth.routes.js', () => ({ default: express.Router(), resolveUserAccess: jest.fn() }));
jest.unstable_mockModule('../src/services/llmConfigService.js', () => ({ default: { initializeDefaultConfig: jest.fn() } }));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: { seedDefaults: jest.fn() } }));
jest.unstable_mockModule('../src/services/scheduledSyncService.js', () => ({ default: { startForWorkspace: jest.fn() } }));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient: jest.fn() }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { isConfigured: () => false, searchUsers: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { requireDashboardView } = await import('../src/middleware/auth.js');
const { requireWorkspace } = await import('../src/middleware/workspace.js');
const { default: dashboardViewerRoutes } = await import('../src/routes/dashboardViewer.routes.js');
const { default: workspaceRoutes } = await import('../src/routes/workspace.routes.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const { resetDashboardViewerCache, dashboardViewersKey, parseViewerIds } = await import('../src/services/dashboardViewerService.js');

// A stand-in for dashboard.routes.js: the gate is what is under test.
const dashboardStub = express.Router();
dashboardStub.get('/', (_req, res) => res.json({ ok: true, page: 'dashboard' }));
dashboardStub.get('/weekly', (_req, res) => res.json({ ok: true, page: 'weekly' }));
dashboardStub.get('/technician/:id', (req, res) => res.json({ ok: true, page: 'technician', id: req.params.id }));
dashboardStub.post('/hide', (_req, res) => res.json({ ok: true, wrote: true }));

const USERS = {
  root: { email: 'root@example.com', role: 'admin' },
  admin: { email: 'admin.one@example.com', role: 'viewer', selectedWorkspaceId: 1 },
  dana: { email: 'dana.fox@example.com', role: 'agent', selectedWorkspaceId: 1 },
  eli: { email: 'eli.park@example.com', role: 'viewer', selectedWorkspaceId: 1 },
  priya: { email: 'priya.nair@example.com', role: 'agent', selectedWorkspaceId: 1 },
  sam: { email: 'sam.okafor@example.com', role: 'agent', selectedWorkspaceId: 2 },
  olive: { email: 'olive.reader@example.com', role: 'viewer', selectedWorkspaceId: 1 },
};

// Mirrors the order in routes/index.js: the viewer router and the Dashboard
// mount sit above the strict gate; "fell through" stands for every mount below.
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const who = USERS[req.headers['x-test-user']];
    req.session = who ? { user: { ...who } } : {};
    next();
  });
  app.use('/api/workspaces', workspaceRoutes);
  app.use('/api', dashboardViewerRoutes);
  app.use('/api/dashboard', requireWorkspace, requireDashboardView, dashboardStub);
  app.use('/api', (req, res) => res.status(418).json({ fellThrough: true, path: req.path }));
  app.use(errorHandler);
  return app;
}
const app = makeApp();
const as = (user, req) => req.set('x-test-user', user);
const grant = (user, techId, enabled, ws = 1) => as(user, request(app).put(`/api/workspaces/${ws}/dashboard-viewers/${techId}`).send({ enabled }));

beforeEach(() => {
  settings.clear();
  resetDashboardViewerCache();
  jest.clearAllMocks();
});

describe('the stored list', () => {
  test('one app_settings key per workspace, parsed forgivingly', () => {
    expect(dashboardViewersKey(1)).toBe('dashboard_viewers_ws1');
    expect(parseViewerIds('[12, 13, 12]')).toEqual([12, 13]);
    expect(parseViewerIds('12, x, 7')).toEqual([7, 12]);
    expect(parseViewerIds(null)).toEqual([]);
    expect(parseViewerIds('{"a":1}')).toEqual([]);
  });
});

describe('an agent on the list', () => {
  test('an unlisted agent is refused the Dashboard with 403 (never 401)', async () => {
    const res = await as('dana', request(app).get('/api/dashboard'));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('workspace_access_denied');
  });

  test('once listed, GETs the Dashboard and technician pages (200)', async () => {
    expect((await grant('admin', 12, true)).status).toBe(200);
    expect(settings.get('dashboard_viewers_ws1')).toBe('[12]');
    for (const path of ['/api/dashboard', '/api/dashboard/weekly', '/api/dashboard/technician/13']) {
      const res = await as('dana', request(app).get(path));
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    }
  });

  test('a listed agent can never write through the Dashboard mount (403)', async () => {
    await grant('admin', 12, true);
    const res = await as('dana', request(app).post('/api/dashboard/hide').send({}));
    expect(res.status).toBe(403);
    expect(res.body.wrote).toBeUndefined();
  });

  test('removing them from the list removes access at once', async () => {
    await grant('admin', 12, true);
    expect((await as('dana', request(app).get('/api/dashboard'))).status).toBe(200);
    const off = await grant('admin', 12, false);
    expect(off.status).toBe(200);
    expect(off.body.data.technicianIds).toEqual([]);
    expect((await as('dana', request(app).get('/api/dashboard'))).status).toBe(403);
  });

  test('the grant is scoped to the workspace that gave it', async () => {
    await grant('admin', 12, true);
    const res = await as('dana', request(app).get('/api/dashboard').set('x-workspace-id', '2'));
    expect(res.status).toBe(403);
  });

  test('a disabled technician on the list gets nothing', async () => {
    settings.set('dashboard_viewers_ws1', '[14]');
    expect((await as('priya', request(app).get('/api/dashboard'))).status).toBe(403);
  });

  test('a Standard member is refused (admin_required) until listed, then reads', async () => {
    expect((await as('eli', request(app).get('/api/dashboard'))).body.code).toBe('admin_required');
    await grant('admin', 13, true);
    expect((await as('eli', request(app).get('/api/dashboard'))).status).toBe(200);
  });

  test('GET /dashboard-access tells the person (and only about themselves)', async () => {
    const before = await as('dana', request(app).get('/api/dashboard-access'));
    expect(before.body.data).toEqual({ dashboard: false, viaGrant: false });
    await grant('admin', 12, true);
    const after = await as('dana', request(app).get('/api/dashboard-access'));
    expect(after.body.data).toEqual({ dashboard: true, viaGrant: true });
    const admin = await as('admin', request(app).get('/api/dashboard-access'));
    expect(admin.body.data).toEqual({ dashboard: true, viaGrant: false });
  });

  test('the page\'s two extra reads answer a listed viewer; everyone else falls through to their normal gate', async () => {
    const unlisted = await as('dana', request(app).get('/api/analytics/categories'));
    expect(unlisted.status).toBe(418);
    expect(unlisted.body.fellThrough).toBe(true);

    await grant('admin', 12, true);
    const cats = await as('dana', request(app).get('/api/analytics/categories'));
    expect(cats.status).toBe(200);
    expect(cats.body.data.categoryMode).toBe('canonical');
    const hol = await as('dana', request(app).get('/api/autoresponse/holidays'));
    expect(hol.status).toBe(200);
    expect(hol.body.data[0].name).toBe('Christmas Day');

    // Writes on the same paths never take the viewer route.
    const write = await as('dana', request(app).post('/api/autoresponse/holidays').send({}));
    expect(write.body.fellThrough).toBe(true);
    // Admins keep their own route.
    const admin = await as('admin', request(app).get('/api/analytics/categories'));
    expect(admin.body.fellThrough).toBe(true);
  });
});

describe('who keeps the Dashboard as before', () => {
  test('a global admin and a workspace admin read; the read-only observer reads but cannot write', async () => {
    expect((await as('root', request(app).get('/api/dashboard').set('x-workspace-id', '1'))).status).toBe(200);
    expect((await as('admin', request(app).get('/api/dashboard'))).status).toBe(200);
    expect((await as('olive', request(app).get('/api/dashboard'))).status).toBe(200);
    expect((await as('olive', request(app).post('/api/dashboard/hide'))).status).toBe(403);
  });
});

describe('only admins change the list', () => {
  test('the agent themself and a Standard member get 403; nothing is stored', async () => {
    expect((await grant('dana', 12, true)).status).toBe(403);
    expect((await grant('eli', 12, true)).status).toBe(403);
    expect(settings.has('dashboard_viewers_ws1')).toBe(false);
    expect((await as('eli', request(app).get('/api/workspaces/1/dashboard-viewers'))).status).toBe(403);
  });

  test('a workspace admin cannot change another workspace\'s list', async () => {
    const res = await grant('admin', 21, true, 2);
    expect(res.status).toBe(403);
    expect(settings.has('dashboard_viewers_ws2')).toBe(false);
  });

  test('admins read the list; bad input is refused', async () => {
    await grant('admin', 12, true);
    const list = await as('admin', request(app).get('/api/workspaces/1/dashboard-viewers'));
    expect(list.status).toBe(200);
    expect(list.body.data.technicianIds).toEqual([12]);
    expect((await grant('admin', 12, 'yes')).status).toBe(400);
    // Sam is a member of workspace 2, not 1.
    expect((await grant('admin', 21, true)).status).toBe(404);
    expect((await grant('root', 21, true, 2)).status).toBe(200);
  });
});
