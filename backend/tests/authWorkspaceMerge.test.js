import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * Phase A1 (Mega 08-15) — workspace picker merge + session token bootstrap.
 *
 * Login/session paths used to be either/or: one workspace_access row hid
 * every technician workspace from the picker (the "partial grant shrinks the
 * picker" trap that Adrian's ops grant would have tripped). The merge rules:
 *   - ≥1 access row → global role unchanged; picker = access ∪ technician
 *     workspaces (access-role label wins on overlap)
 *   - 0 access rows + ≥1 technician profile → global role 'agent'; picker =
 *     technician workspaces (pure technicians keep the agent-portal UX)
 * Also: GET /auth/session on the session-cookie branch now returns a fresh
 * authToken so a brand-new tab (cookie, no sessionStorage JWT) can bootstrap.
 */

const workspaceAccessFindMany = jest.fn();
const technicianFindMany = jest.fn();
const workspaceFindMany = jest.fn();
const getAgentProfilesMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: {
    workspaceAccess: { findMany: workspaceAccessFindMany },
    technician: { findMany: technicianFindMany },
    workspace: { findMany: workspaceFindMany },
  },
}));
jest.unstable_mockModule('../src/services/agentCompetencyService.js', () => ({
  default: { getAgentProfiles: getAgentProfilesMock },
}));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: { get: jest.fn().mockResolvedValue(null) },
}));
jest.unstable_mockModule('../src/services/apiRateLimitService.js', () => ({
  default: { hit: jest.fn().mockResolvedValue({ allowed: true }) },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { mergeWorkspaceLists } = await import('../src/services/workspaceRepository.js');
const { default: authRoutes, resolveUserAccess } = await import('../src/routes/auth.routes.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const { default: config } = await import('../src/config/index.js');

const wsRow = (id, name, extra = {}) => ({
  id,
  name,
  slug: name.toLowerCase(),
  isActive: true,
  // Plain number, not BigInt: the app installs a BigInt JSON serializer in
  // app.js which this route-level test harness doesn't load.
  freshserviceWorkspaceId: id,
  defaultTimezone: 'America/Vancouver',
  nativeTicketingEnabled: true,
  ...extra,
});

function accessRecord(workspace, role) {
  return { email: 'user@bgc.ca', role, workspace };
}

function technicianRecord(workspace) {
  return { workspaceId: workspace.id, workspace };
}

beforeEach(() => {
  jest.clearAllMocks();
  workspaceAccessFindMany.mockResolvedValue([]);
  technicianFindMany.mockResolvedValue([]);
  workspaceFindMany.mockResolvedValue([]);
  getAgentProfilesMock.mockResolvedValue([]);
});

describe('mergeWorkspaceLists', () => {
  const access = [{ id: 1, name: 'IT', slug: 'it', role: 'reviewer' }];
  const tech = [
    { id: 1, name: 'IT', slug: 'it', role: 'agent' },
    { id: 2, name: 'Accounting', slug: 'ap', role: 'agent' },
  ];

  test('unions both lists deduped by id, access-role wins the label', () => {
    const merged = mergeWorkspaceLists(access, tech);
    expect(merged.map(w => w.id).sort()).toEqual([1, 2]);
    expect(merged.find(w => w.id === 1).role).toBe('reviewer');
    expect(merged.find(w => w.id === 2).role).toBe('agent');
  });

  test('handles empty inputs', () => {
    expect(mergeWorkspaceLists([], [])).toEqual([]);
    expect(mergeWorkspaceLists(access, []).map(w => w.id)).toEqual([1]);
    expect(mergeWorkspaceLists([], tech).map(w => w.id).sort()).toEqual([1, 2]);
  });
});

describe('resolveUserAccess matrix', () => {
  const it = wsRow(1, 'IT');
  const ap = wsRow(2, 'Accounting');

  test('access-only user: role stays viewer, picker = access rows', async () => {
    workspaceAccessFindMany.mockResolvedValue([accessRecord(it, 'viewer')]);
    const out = await resolveUserAccess('user@bgc.ca', 'viewer');
    expect(out.role).toBe('viewer');
    expect(out.availableWorkspaces.map(w => w.id)).toEqual([1]);
    expect(out.availableWorkspaces[0].role).toBe('viewer');
  });

  test('technician-only user KEEPS global agent role and technician picker', async () => {
    technicianFindMany.mockResolvedValue([technicianRecord(it), technicianRecord(ap)]);
    getAgentProfilesMock.mockResolvedValue([{ id: 9, email: 'user@bgc.ca' }]);
    const out = await resolveUserAccess('user@bgc.ca', 'viewer');
    expect(out.role).toBe('agent');
    expect(out.availableWorkspaces.map(w => w.id).sort()).toEqual([1, 2]);
    expect(out.availableWorkspaces.every(w => w.role === 'agent')).toBe(true);
  });

  test('mixed user with a PARTIAL grant: picker never shrinks, access label wins', async () => {
    workspaceAccessFindMany.mockResolvedValue([accessRecord(it, 'reviewer')]);
    technicianFindMany.mockResolvedValue([technicianRecord(it), technicianRecord(ap)]);
    getAgentProfilesMock.mockResolvedValue([{ id: 9, email: 'user@bgc.ca' }]);
    const out = await resolveUserAccess('user@bgc.ca', 'viewer');
    expect(out.role).toBe('viewer'); // ≥1 access row → full-app UX
    expect(out.availableWorkspaces.map(w => w.id).sort()).toEqual([1, 2]);
    expect(out.availableWorkspaces.find(w => w.id === 1).role).toBe('reviewer');
    expect(out.availableWorkspaces.find(w => w.id === 2).role).toBe('agent');
  });

  test('a stale agent role upgrades to viewer once an access row exists (ops-grant flow)', async () => {
    workspaceAccessFindMany.mockResolvedValue([accessRecord(it, 'reviewer')]);
    technicianFindMany.mockResolvedValue([technicianRecord(it)]);
    getAgentProfilesMock.mockResolvedValue([{ id: 9, email: 'user@bgc.ca' }]);
    const out = await resolveUserAccess('user@bgc.ca', 'agent');
    expect(out.role).toBe('viewer');
    expect(out.availableWorkspaces.find(w => w.id === 1).role).toBe('reviewer');
  });

  test('no access rows and no technician profiles: viewer with an empty picker', async () => {
    const out = await resolveUserAccess('user@bgc.ca', 'viewer');
    expect(out.role).toBe('viewer');
    expect(out.availableWorkspaces).toEqual([]);
  });

  test('admin gets every active workspace as admin', async () => {
    workspaceFindMany.mockResolvedValue([it, ap]);
    const out = await resolveUserAccess('admin@bgc.ca', 'admin');
    expect(out.role).toBe('admin');
    expect(out.availableWorkspaces.map(w => w.role)).toEqual(['admin', 'admin']);
  });
});

describe('GET /auth/session', () => {
  function makeApp(sessionUserValue = null) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.session = sessionUserValue ? { user: sessionUserValue } : {};
      next();
    });
    app.use('/api/auth', authRoutes);
    app.use(errorHandler);
    return app;
  }

  test('session-cookie branch returns a fresh authToken a new tab can bootstrap from', async () => {
    const res = await request(makeApp({
      email: 'user@bgc.ca',
      name: 'User',
      role: 'viewer',
      selectedWorkspaceId: 3,
      availableWorkspaces: [{ id: 3, name: 'IT', slug: 'it', role: 'viewer' }],
      agentProfiles: [],
    })).get('/api/auth/session');

    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(typeof res.body.authToken).toBe('string');
    const decoded = jwt.verify(res.body.authToken, config.session.secret, { algorithms: ['HS256'] });
    expect(decoded.email).toBe('user@bgc.ca');
    expect(decoded.role).toBe('viewer');
    expect(decoded.selectedWorkspaceId).toBe(3);
  });

  test('JWT fallback resolves the MERGED picker for a partially-granted user', async () => {
    const it = wsRow(1, 'IT');
    const ap = wsRow(2, 'Accounting');
    workspaceAccessFindMany.mockResolvedValue([accessRecord(it, 'viewer')]);
    technicianFindMany.mockResolvedValue([technicianRecord(it), technicianRecord(ap)]);
    getAgentProfilesMock.mockResolvedValue([]);

    const token = jwt.sign(
      { email: 'user@bgc.ca', name: 'User', role: 'viewer' },
      config.session.secret,
      { algorithm: 'HS256', expiresIn: '1h' },
    );
    const res = await request(makeApp(null))
      .get('/api/auth/session')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.user.role).toBe('viewer');
    expect(res.body.availableWorkspaces.map(w => w.id).sort()).toEqual([1, 2]);
    expect(res.body.availableWorkspaces.find(w => w.id === 1).role).toBe('viewer');
    expect(res.body.availableWorkspaces.find(w => w.id === 2).role).toBe('agent');
  });

  test('unauthenticated stays a clean authenticated:false (no token minted)', async () => {
    const res = await request(makeApp(null)).get('/api/auth/session');
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(false);
    expect(res.body.authToken).toBeUndefined();
  });
});
