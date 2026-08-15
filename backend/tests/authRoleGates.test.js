import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * Phase A1 (Mega 08-15) — auth vs authorization semantics.
 *
 * The headline bug: requireWorkspaceAccess & friends threw 401
 * AuthenticationError for AUTHENTICATED users who merely lacked a role/access
 * row, which drove the frontend's credential-recovery loop into sign-outs
 * (Marcus/Adrian). These tests pin the new contract:
 *   - credential failures stay 401 (code auth_required)
 *   - permission refusals are 403 AuthorizationError with a problem code
 *   - Bearer requests populate req.user and DO NOT write req.session.user
 *     (no more one-session-row-per-API-call churn)
 *   - the agent-allowed tier (requireWorkspaceMemberOrAgent) admits active
 *     technicians without workspace_access rows.
 */

const getAccessRoleMock = jest.fn();
const hasActiveTechnicianMock = jest.fn();

jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({
  default: {
    getAccessRole: getAccessRoleMock,
    hasActiveTechnician: hasActiveTechnicianMock,
  },
  mergeWorkspaceLists: () => [],
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  requireAuth,
  requireAdmin,
  requireReviewer,
  requireGlobalAdmin,
  requireWorkspaceAccess,
  requireWorkspaceMemberOrAgent,
  sessionUser,
} = await import('../src/middleware/auth.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const { default: config } = await import('../src/config/index.js');

function makeApp(gate, { user = null, bearerUser = null, workspaceId = 1 } = {}) {
  const app = express();
  app.use((req, _res, next) => {
    req.session = user ? { user } : {};
    if (bearerUser) req.user = bearerUser;
    if (workspaceId) req.workspaceId = workspaceId;
    next();
  });
  app.get('/probe', gate, (req, res) => res.json({ success: true }));
  app.use(errorHandler);
  return app;
}

const viewer = { email: 'viewer@bgc.ca', role: 'viewer' };
const agent = { email: 'tech@bgc.ca', role: 'agent' };

beforeEach(() => {
  jest.clearAllMocks();
  getAccessRoleMock.mockResolvedValue(null);
  hasActiveTechnicianMock.mockResolvedValue(false);
});

describe('403 semantics + problem codes', () => {
  test('requireWorkspaceAccess refuses a no-access user with 403 workspace_access_denied', async () => {
    const res = await request(makeApp(requireWorkspaceAccess, { user: agent })).get('/probe');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('workspace_access_denied');
  });

  test('requireWorkspaceAccess passes a user with any access row', async () => {
    getAccessRoleMock.mockResolvedValue('viewer');
    const res = await request(makeApp(requireWorkspaceAccess, { user: viewer })).get('/probe');
    expect(res.status).toBe(200);
  });

  test('requireAdmin refuses non-admins with 403 admin_required', async () => {
    getAccessRoleMock.mockResolvedValue('viewer');
    const res = await request(makeApp(requireAdmin, { user: viewer })).get('/probe');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('admin_required');
  });

  test('requireReviewer refuses plain members with 403 reviewer_required', async () => {
    getAccessRoleMock.mockResolvedValue('viewer');
    const res = await request(makeApp(requireReviewer, { user: viewer })).get('/probe');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reviewer_required');
  });

  test('requireReviewer passes workspace reviewers', async () => {
    getAccessRoleMock.mockResolvedValue('reviewer');
    const res = await request(makeApp(requireReviewer, { user: viewer })).get('/probe');
    expect(res.status).toBe(200);
  });

  test('requireGlobalAdmin refuses workspace admins with 403 super_admin_required', async () => {
    getAccessRoleMock.mockResolvedValue('admin');
    const res = await request(makeApp(requireGlobalAdmin, { user: viewer })).get('/probe');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('super_admin_required');
  });

  test('global admins pass every gate without a DB lookup', async () => {
    const admin = { email: 'admin@bgc.ca', role: 'admin' };
    for (const gate of [requireWorkspaceAccess, requireAdmin, requireReviewer, requireGlobalAdmin, requireWorkspaceMemberOrAgent]) {
      const res = await request(makeApp(gate, { user: admin })).get('/probe');
      expect(res.status).toBe(200);
    }
    expect(getAccessRoleMock).not.toHaveBeenCalled();
  });
});

describe('Bearer identity fallback (req.user)', () => {
  test('role gates read req.user when there is no session user', async () => {
    getAccessRoleMock.mockResolvedValue('admin');
    const res = await request(makeApp(requireAdmin, { bearerUser: viewer })).get('/probe');
    expect(res.status).toBe(200);
    expect(getAccessRoleMock).toHaveBeenCalledWith('viewer@bgc.ca', 1);
  });

  test('sessionUser prefers the session over the token identity', () => {
    const req = { session: { user: viewer }, user: agent };
    expect(sessionUser(req)).toBe(viewer);
    expect(sessionUser({ user: agent })).toBe(agent);
    expect(sessionUser({ session: {} })).toBeNull();
  });
});

describe('requireAuth', () => {
  function makeAuthApp() {
    const app = express();
    app.use((req, _res, next) => { req.session = {}; next(); });
    app.get('/probe', requireAuth, (req, res) => res.json({
      success: true,
      tokenEmail: req.user?.email || null,
      sessionUserWritten: req.session.user !== undefined,
    }));
    app.use(errorHandler);
    return app;
  }

  test('valid Bearer sets req.user and does NOT write req.session.user (no session-row churn)', async () => {
    const token = jwt.sign(
      { email: 'tech@bgc.ca', name: 'Tech', role: 'agent', selectedWorkspaceId: 2 },
      config.session.secret,
      { algorithm: 'HS256', expiresIn: '1h' },
    );
    const res = await request(makeAuthApp()).get('/probe').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.tokenEmail).toBe('tech@bgc.ca');
    expect(res.body.sessionUserWritten).toBe(false);
  });

  test('missing credentials stay 401 with code auth_required', async () => {
    const res = await request(makeAuthApp()).get('/probe');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('auth_required');
  });

  test('an invalid Bearer token stays 401 (credential problem, not permission)', async () => {
    const res = await request(makeAuthApp()).get('/probe').set('Authorization', 'Bearer garbage');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('auth_required');
  });
});

describe('agent-allowed tier (requireWorkspaceMemberOrAgent)', () => {
  test('an active technician with NO access row passes', async () => {
    hasActiveTechnicianMock.mockResolvedValue(true);
    const res = await request(makeApp(requireWorkspaceMemberOrAgent, { user: agent })).get('/probe');
    expect(res.status).toBe(200);
    expect(hasActiveTechnicianMock).toHaveBeenCalledWith('tech@bgc.ca', 1);
  });

  test('a workspace member passes', async () => {
    getAccessRoleMock.mockResolvedValue('viewer');
    const res = await request(makeApp(requireWorkspaceMemberOrAgent, { user: viewer })).get('/probe');
    expect(res.status).toBe(200);
  });

  test('neither member nor technician → 403 workspace_access_denied', async () => {
    const res = await request(makeApp(requireWorkspaceMemberOrAgent, { user: viewer })).get('/probe');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('workspace_access_denied');
  });

  test('agents do NOT gain admin-gated surfaces: requireAdmin still refuses a technician', async () => {
    hasActiveTechnicianMock.mockResolvedValue(true); // technician everywhere
    const res = await request(makeApp(requireAdmin, { user: agent })).get('/probe');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('admin_required');
  });
});
