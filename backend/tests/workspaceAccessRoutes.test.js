import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * Phase AC (Mega 08-23) — hardened workspace access-grant routes.
 *
 * The routes under /api/workspaces/:id/access mount BEFORE requireWorkspace
 * (routes/index.js), so req.workspaceId was never set: requireAdmin refused
 * every workspace-scoped admin outright, and role values were upserted raw
 * (`role || 'viewer'`) with no admin ceiling. The new contract:
 *   - the admin gate binds to the TARGET workspace (req.params.id) — a ws1
 *     admin cannot read or mutate ws5 grants (403 admin_required), and a
 *     request scoped to a different workspace than it targets is refused
 *     explicitly (403 workspace_mismatch)
 *   - role ∈ {viewer, reviewer, admin} (400 otherwise)
 *   - granting admin, changing an existing admin, or revoking an admin grant
 *     requires a GLOBAL admin (403 super_admin_required)
 *   - POST /workspaces/select re-resolves the role before re-signing the JWT
 *     (live role refresh, AC2)
 *   - GET /:id/members returns the access ∪ technician union (AC3)
 */

const getAccessRoleMock = jest.fn();
const hasActiveTechnicianMock = jest.fn();
const grantAccessMock = jest.fn();
const revokeAccessMock = jest.fn();
const getAccessListMock = jest.fn();
const getWorkspaceMembersMock = jest.fn();
const getByIdMock = jest.fn();
const resolveUserAccessMock = jest.fn();

jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({
  default: {
    getAccessRole: getAccessRoleMock,
    hasActiveTechnician: hasActiveTechnicianMock,
    grantAccess: grantAccessMock,
    revokeAccess: revokeAccessMock,
    getAccessList: getAccessListMock,
    getWorkspaceMembers: getWorkspaceMembersMock,
    getById: getByIdMock,
    getAll: jest.fn().mockResolvedValue([]),
    getMergedWorkspaces: jest.fn().mockResolvedValue([]),
  },
  mergeWorkspaceLists: () => [],
}));
jest.unstable_mockModule('../src/routes/auth.routes.js', () => ({
  default: express.Router(),
  resolveUserAccess: resolveUserAccessMock,
}));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: { get: jest.fn().mockResolvedValue(null), getFreshServiceConfig: jest.fn() },
}));
jest.unstable_mockModule('../src/services/availabilityService.js', () => ({
  default: { initializeDefaultBusinessHours: jest.fn() },
}));
jest.unstable_mockModule('../src/services/llmConfigService.js', () => ({
  default: { initializeDefaultConfig: jest.fn() },
}));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({
  default: { seedDefaults: jest.fn() },
}));
jest.unstable_mockModule('../src/services/scheduledSyncService.js', () => ({
  default: { startForWorkspace: jest.fn() },
}));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({
  createFreshServiceClient: jest.fn(),
}));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({
  default: { isConfigured: () => false, searchUsers: jest.fn() },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: workspaceRoutes } = await import('../src/routes/workspace.routes.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const { default: config } = await import('../src/config/index.js');

function makeApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = user ? { user } : {};
    next();
  });
  app.use('/api/workspaces', workspaceRoutes);
  app.use(errorHandler);
  return app;
}

// A workspace admin of ws1 ONLY (global role viewer + access row admin@ws1).
const ws1Admin = { email: 'wsadmin@bgc.ca', role: 'viewer', selectedWorkspaceId: 1 };
const globalAdmin = { email: 'root@bgc.ca', role: 'admin' };

beforeEach(() => {
  jest.clearAllMocks();
  // wsadmin@bgc.ca is admin of workspace 1 and nothing else.
  getAccessRoleMock.mockImplementation(async (email, workspaceId) => {
    if (email === 'wsadmin@bgc.ca' && workspaceId === 1) return 'admin';
    return null;
  });
  hasActiveTechnicianMock.mockResolvedValue(false);
  grantAccessMock.mockImplementation(async (email, workspaceId, role) => ({ email, workspaceId, role }));
  revokeAccessMock.mockResolvedValue(true);
  getAccessListMock.mockResolvedValue([]);
  getWorkspaceMembersMock.mockResolvedValue([]);
  resolveUserAccessMock.mockImplementation(async (email, role) => ({
    role,
    availableWorkspaces: [],
    agentProfiles: [],
  }));
});

describe('cross-workspace escalation is closed (AC1)', () => {
  test('a ws1 admin scoped to ws1 targeting ws5 → 403 workspace_mismatch', async () => {
    const res = await request(makeApp(ws1Admin))
      .post('/api/workspaces/5/access')
      .set('x-workspace-id', '1')
      .send({ email: 'victim@bgc.ca', role: 'admin' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('workspace_mismatch');
    expect(grantAccessMock).not.toHaveBeenCalled();
  });

  test('mismatch also falls back to the session selection when no header is sent', async () => {
    const res = await request(makeApp(ws1Admin)) // selectedWorkspaceId: 1
      .post('/api/workspaces/5/access')
      .send({ email: 'victim@bgc.ca', role: 'viewer' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('workspace_mismatch');
  });

  test('re-scoping the header to the target does not help: the admin role is checked against the TARGET workspace', async () => {
    const res = await request(makeApp(ws1Admin))
      .post('/api/workspaces/5/access')
      .set('x-workspace-id', '5') // attacker-controlled header now matches the param…
      .send({ email: 'wsadmin@bgc.ca', role: 'reviewer' });
    expect(res.status).toBe(403); // …but they are not an admin OF workspace 5
    expect(res.body.code).toBe('admin_required');
    expect(getAccessRoleMock).toHaveBeenCalledWith('wsadmin@bgc.ca', 5);
    expect(grantAccessMock).not.toHaveBeenCalled();
  });

  test('a global admin may operate on any workspace regardless of scope', async () => {
    const res = await request(makeApp(globalAdmin))
      .post('/api/workspaces/5/access')
      .set('x-workspace-id', '1')
      .send({ email: 'someone@bgc.ca', role: 'viewer' });
    expect(res.status).toBe(200);
    expect(grantAccessMock).toHaveBeenCalledWith('someone@bgc.ca', 5, 'viewer');
  });

  test('GET /:id/access is bound to the target workspace too', async () => {
    const res = await request(makeApp(ws1Admin))
      .get('/api/workspaces/5/access')
      .set('x-workspace-id', '1');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('workspace_mismatch');
  });

  test('a non-numeric target id is a 400', async () => {
    const res = await request(makeApp(globalAdmin)).get('/api/workspaces/abc/access');
    expect(res.status).toBe(400);
  });
});

describe('role whitelist (AC1)', () => {
  test('unknown role values are rejected with 400 (no raw upsert)', async () => {
    const res = await request(makeApp(globalAdmin))
      .post('/api/workspaces/1/access')
      .send({ email: 'someone@bgc.ca', role: 'superuser' });
    expect(res.status).toBe(400);
    expect(grantAccessMock).not.toHaveBeenCalled();
  });

  test('missing role still defaults to viewer', async () => {
    const res = await request(makeApp(globalAdmin))
      .post('/api/workspaces/1/access')
      .send({ email: 'someone@bgc.ca' });
    expect(res.status).toBe(200);
    expect(grantAccessMock).toHaveBeenCalledWith('someone@bgc.ca', 1, 'viewer');
  });

  test('missing email is a 400', async () => {
    const res = await request(makeApp(globalAdmin))
      .post('/api/workspaces/1/access')
      .send({ role: 'viewer' });
    expect(res.status).toBe(400);
  });
});

describe('admin ceiling (AC1): only global admins hand out or take away admin', () => {
  test('a workspace admin can grant reviewer on their own workspace', async () => {
    const res = await request(makeApp(ws1Admin))
      .post('/api/workspaces/1/access')
      .set('x-workspace-id', '1')
      .send({ email: 'marcus@bgc.ca', role: 'reviewer' });
    expect(res.status).toBe(200);
    expect(grantAccessMock).toHaveBeenCalledWith('marcus@bgc.ca', 1, 'reviewer');
  });

  test('a workspace admin can NOT grant admin', async () => {
    const res = await request(makeApp(ws1Admin))
      .post('/api/workspaces/1/access')
      .set('x-workspace-id', '1')
      .send({ email: 'marcus@bgc.ca', role: 'admin' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('super_admin_required');
    expect(grantAccessMock).not.toHaveBeenCalled();
  });

  test('a workspace admin can NOT downgrade an existing admin (change ceiling)', async () => {
    getAccessRoleMock.mockImplementation(async (email, workspaceId) => {
      if (email === 'wsadmin@bgc.ca' && workspaceId === 1) return 'admin';
      if (email === 'peer-admin@bgc.ca' && workspaceId === 1) return 'admin';
      return null;
    });
    const res = await request(makeApp(ws1Admin))
      .post('/api/workspaces/1/access')
      .set('x-workspace-id', '1')
      .send({ email: 'peer-admin@bgc.ca', role: 'viewer' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('super_admin_required');
  });

  test('a workspace admin can NOT revoke an admin grant', async () => {
    getAccessRoleMock.mockImplementation(async (email, workspaceId) => {
      if (workspaceId !== 1) return null;
      if (email === 'wsadmin@bgc.ca' || email === 'peer-admin@bgc.ca') return 'admin';
      return null;
    });
    const res = await request(makeApp(ws1Admin))
      .delete('/api/workspaces/1/access/peer-admin@bgc.ca')
      .set('x-workspace-id', '1');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('super_admin_required');
    expect(revokeAccessMock).not.toHaveBeenCalled();
  });

  test('a workspace admin CAN revoke a viewer grant', async () => {
    getAccessRoleMock.mockImplementation(async (email, workspaceId) => {
      if (workspaceId !== 1) return null;
      if (email === 'wsadmin@bgc.ca') return 'admin';
      if (email === 'marcus@bgc.ca') return 'viewer';
      return null;
    });
    const res = await request(makeApp(ws1Admin))
      .delete('/api/workspaces/1/access/marcus@bgc.ca')
      .set('x-workspace-id', '1');
    expect(res.status).toBe(200);
    expect(revokeAccessMock).toHaveBeenCalledWith('marcus@bgc.ca', 1);
  });

  test('a global admin can grant admin and revoke an admin grant', async () => {
    const grant = await request(makeApp(globalAdmin))
      .post('/api/workspaces/1/access')
      .send({ email: 'new-admin@bgc.ca', role: 'admin' });
    expect(grant.status).toBe(200);
    expect(grantAccessMock).toHaveBeenCalledWith('new-admin@bgc.ca', 1, 'admin');

    getAccessRoleMock.mockResolvedValue('admin');
    const revoke = await request(makeApp(globalAdmin))
      .delete('/api/workspaces/1/access/new-admin@bgc.ca');
    expect(revoke.status).toBe(200);
    expect(revokeAccessMock).toHaveBeenCalledWith('new-admin@bgc.ca', 1);
  });

  test('revoking a non-existent grant is a 404', async () => {
    const res = await request(makeApp(globalAdmin))
      .delete('/api/workspaces/1/access/nobody@bgc.ca');
    expect(res.status).toBe(404);
    expect(revokeAccessMock).not.toHaveBeenCalled();
  });
});

describe('GET /:id/members (AC3)', () => {
  test('returns the union for the target workspace, admin-gated the same way', async () => {
    getWorkspaceMembersMock.mockResolvedValue([
      { email: 'marcus@bgc.ca', name: 'Marcus', photoUrl: null, technicianId: 7, accessRole: null },
      { email: 'adrian@bgc.ca', name: 'Adrian', photoUrl: null, technicianId: 8, accessRole: 'viewer' },
      { email: 'ops@bgc.ca', name: null, photoUrl: null, technicianId: null, accessRole: 'reviewer' },
    ]);
    const res = await request(makeApp(ws1Admin))
      .get('/api/workspaces/1/members')
      .set('x-workspace-id', '1');
    expect(res.status).toBe(200);
    expect(getWorkspaceMembersMock).toHaveBeenCalledWith(1);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.data.find(m => m.email === 'marcus@bgc.ca').accessRole).toBeNull();

    const denied = await request(makeApp(ws1Admin))
      .get('/api/workspaces/5/members')
      .set('x-workspace-id', '1');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('workspace_mismatch');
  });
});

describe('POST /workspaces/select re-signs with the LIVE role (AC2)', () => {
  test('a stale agent session gets the upgraded role in the fresh JWT and session', async () => {
    getByIdMock.mockResolvedValue({ id: 2, name: 'Accounting', slug: 'ap' });
    getAccessRoleMock.mockImplementation(async (email, workspaceId) =>
      (email === 'marcus@bgc.ca' && workspaceId === 2 ? 'reviewer' : null));
    resolveUserAccessMock.mockResolvedValue({
      role: 'viewer', // stale 'agent' upgraded by the resolver
      availableWorkspaces: [{ id: 2, name: 'Accounting', slug: 'ap', role: 'reviewer' }],
      agentProfiles: [],
    });

    const staleAgent = { email: 'marcus@bgc.ca', name: 'Marcus', role: 'agent' };
    const app = express();
    app.use(express.json());
    let capturedSession;
    app.use((req, _res, next) => {
      req.session = { user: { ...staleAgent } };
      capturedSession = req.session;
      next();
    });
    app.use('/api/workspaces', workspaceRoutes);
    app.use(errorHandler);

    const res = await request(app).post('/api/workspaces/select').send({ workspaceId: 2 });
    expect(res.status).toBe(200);
    expect(resolveUserAccessMock).toHaveBeenCalledWith('marcus@bgc.ca', 'agent');
    const decoded = jwt.verify(res.body.authToken, config.session.secret, { algorithms: ['HS256'] });
    expect(decoded.role).toBe('viewer');
    expect(decoded.selectedWorkspaceId).toBe(2);
    expect(capturedSession.user.role).toBe('viewer');
  });

  test('a resolver failure keeps the session role (best-effort, never a lockout)', async () => {
    getByIdMock.mockResolvedValue({ id: 1, name: 'IT', slug: 'it' });
    resolveUserAccessMock.mockRejectedValue(new Error('db down'));
    const res = await request(makeApp({ ...ws1Admin })).post('/api/workspaces/select').send({ workspaceId: 1 });
    expect(res.status).toBe(200);
    const decoded = jwt.verify(res.body.authToken, config.session.secret, { algorithms: ['HS256'] });
    expect(decoded.role).toBe('viewer');
  });
});
