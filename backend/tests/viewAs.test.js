import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * "View as" (QA 10-08 #2): a super admin tries on a workspace role, or looks
 * at Ticket Pulse as a named person.
 *
 *   role    the admin keeps their own e-mail (writes stay theirs) and holds
 *           ONE workspace with the chosen role — whatever their real access
 *           row says, and for every gate (cookie session or Bearer token);
 *   person  the session is the other person, and nothing can be written.
 *
 * Also QA 10-08 #1: an open sign-in session follows the super-admin list live.
 */

const workspaceAccessFindUnique = jest.fn();
const workspaceAccessFindMany = jest.fn();
const technicianFindMany = jest.fn();
const technicianFindFirst = jest.fn();
const workspaceFindMany = jest.fn();
const getAgentProfilesMock = jest.fn();
const settingsGet = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: {
    workspaceAccess: { findUnique: workspaceAccessFindUnique, findMany: workspaceAccessFindMany },
    technician: { findMany: technicianFindMany, findFirst: technicianFindFirst },
    workspace: { findMany: workspaceFindMany },
  },
}));
jest.unstable_mockModule('../src/services/agentCompetencyService.js', () => ({ default: { getAgentProfiles: getAgentProfilesMock } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: { get: settingsGet } }));
jest.unstable_mockModule('../src/services/apiRateLimitService.js', () => ({ default: { hit: jest.fn().mockResolvedValue({ allowed: true }) } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { requireAuth, requireAdmin, requireReviewer, requireGlobalAdmin, requireWorkspaceAccess, blockReadonlyWrites } = await import('../src/middleware/auth.js');
const { default: authRoutes } = await import('../src/routes/auth.routes.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const { default: config } = await import('../src/config/index.js');

const ADMIN = 'vahid@bgc.ca';
const SUSAN = 'susan@bgc.ca';
const ws = (id, name) => ({ id, name, slug: name.toLowerCase(), isActive: true, freshserviceWorkspaceId: id, defaultTimezone: 'America/Vancouver', nativeTicketingEnabled: true });
const roleView = (role, workspaceId = 1) => ({ mode: 'role', role, workspaceId, by: ADMIN, byName: 'Vahid', label: `${role} in IT` });
const personView = { mode: 'person', by: ADMIN, byName: 'Vahid', label: 'Susan Xu' };
const token = (claims) => jwt.sign(claims, config.session.secret, { algorithm: 'HS256', expiresIn: '5m' });

beforeEach(() => {
  jest.clearAllMocks();
  settingsGet.mockResolvedValue(`${ADMIN}`);
  workspaceFindMany.mockResolvedValue([ws(1, 'IT'), ws(2, 'Accounting')]);
  workspaceAccessFindMany.mockResolvedValue([]);
  technicianFindMany.mockResolvedValue([]);
  technicianFindFirst.mockResolvedValue(null);
  getAgentProfilesMock.mockResolvedValue([]);
  // The admin's REAL row in every workspace is 'admin': a view must not fall back to it.
  workspaceAccessFindUnique.mockResolvedValue({ role: 'admin' });
});

/** An app with the real gates; identity by cookie session (user) or Bearer token. */
function gated(gate, { user = null, workspaceId = 1 } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = user ? { user } : {}; req.workspaceId = workspaceId; next(); });
  app.use(blockReadonlyWrites);
  app.use(requireAuth);
  for (const path of ['/probe', '/usage/batch', '/things/preview']) {
    app.get(path, gate, (req, res) => res.json({ success: true }));
    app.post(path, gate, (req, res) => res.json({ success: true }));
  }
  app.use(errorHandler);
  return app;
}
const pass = (req, res, next) => next();

describe('trying on a role', () => {
  const me = (role, workspaceId = 1) => ({ email: ADMIN, name: 'Vahid', role: 'viewer', selectedWorkspaceId: workspaceId, viewAs: roleView(role, workspaceId) });

  test('Reviewer: the admin gate refuses, the reviewer gate passes — the real admin row is never read', async () => {
    expect((await request(gated(requireAdmin, { user: me('reviewer') })).get('/probe')).body.code).toBe('admin_required');
    expect((await request(gated(requireReviewer, { user: me('reviewer') })).get('/probe')).status).toBe(200);
    expect((await request(gated(requireGlobalAdmin, { user: me('reviewer') })).get('/probe')).body.code).toBe('super_admin_required');
    expect(workspaceAccessFindUnique).not.toHaveBeenCalled();
  });

  test('the view holds ONE workspace: any other workspace is refused', async () => {
    const r = await request(gated(requireWorkspaceAccess, { user: me('reviewer', 1), workspaceId: 2 })).get('/probe');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('workspace_access_denied');
  });

  test('Read-only: reads pass, writes are refused by the same gate real read-only users meet', async () => {
    const app = gated(pass, { user: me('readonly') });
    expect((await request(app).get('/probe')).status).toBe(200);
    const w = await request(app).post('/probe').set('x-workspace-id', '1').send({});
    expect(w.status).toBe(403);
    expect(w.body.code).toBe('read_only_role');
  });

  test('Standard and Workspace admin may write (the admin stays the actor)', async () => {
    expect((await request(gated(pass, { user: me('viewer') })).post('/probe').set('x-workspace-id', '1').send({})).status).toBe(200);
    expect((await request(gated(requireAdmin, { user: me('admin') })).post('/probe').set('x-workspace-id', '1').send({})).status).toBe(200);
    expect((await request(gated(requireGlobalAdmin, { user: me('admin') })).get('/probe')).status).toBe(403);
  });

  test('a cookie-blocked browser (Bearer token only) is held to the same view', async () => {
    const t = token({ email: ADMIN, name: 'Vahid', role: 'viewer', selectedWorkspaceId: 1, viewAs: roleView('reviewer') });
    expect((await request(gated(requireAdmin)).get('/probe').set('Authorization', `Bearer ${t}`)).body.code).toBe('admin_required');
    expect((await request(gated(requireReviewer)).get('/probe').set('Authorization', `Bearer ${t}`)).status).toBe(200);
  });

  test('without a view nothing changes: the database decides', async () => {
    workspaceAccessFindUnique.mockResolvedValue({ role: 'reviewer' });
    const plain = { email: SUSAN, name: 'Susan', role: 'viewer', selectedWorkspaceId: 1 };
    expect((await request(gated(requireAdmin, { user: plain })).get('/probe')).status).toBe(403);
    expect((await request(gated(requireReviewer, { user: plain })).get('/probe')).status).toBe(200);
    expect(workspaceAccessFindUnique).toHaveBeenCalled();
  });
});

describe('read-only for a token-only browser (second look)', () => {
  test('a real read-only member whose cookie is blocked is still refused writes', async () => {
    workspaceAccessFindUnique.mockResolvedValue({ role: 'readonly' });
    const t = token({ email: SUSAN, name: 'Susan', role: 'viewer', selectedWorkspaceId: 1 });
    const app = gated(pass);
    const w = await request(app).post('/probe').set('Authorization', `Bearer ${t}`).set('x-workspace-id', '1').send({});
    expect(w.status).toBe(403);
    expect(w.body.code).toBe('read_only_role');
    expect((await request(app).get('/probe').set('Authorization', `Bearer ${t}`)).status).toBe(200);
  });

  test('a token that is not ours (an API key) is not touched by this gate', async () => {
    const app = express();
    app.use(blockReadonlyWrites);
    app.post('/probe', (req, res) => res.json({ ok: true }));
    expect((await request(app).post('/probe').set('Authorization', 'Bearer tp_live_abc').set('x-workspace-id', '1')).status).toBe(200);
    expect(workspaceAccessFindUnique).not.toHaveBeenCalled();
  });
});

describe('viewing as a person: nothing can be changed', () => {
  const asSusan = { email: SUSAN, name: 'Susan Xu', role: 'viewer', selectedWorkspaceId: 1, viewAs: personView };

  test('reads pass with HER access; every write is refused with a message that names the view', async () => {
    workspaceAccessFindUnique.mockResolvedValue({ role: 'reviewer' });
    const app = gated(requireReviewer, { user: asSusan });
    expect((await request(app).get('/probe')).status).toBe(200);
    const w = await request(app).post('/probe').send({});
    expect(w.status).toBe(403);
    expect(w.body.code).toBe('view_as_read_only');
    expect(w.body.message).toMatch(/viewing Ticket Pulse as Susan Xu/);
    expect(workspaceAccessFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { email_workspaceId: { email: SUSAN, workspaceId: 1 } } }));
  });

  test('background beacons are dropped quietly and reads sent as POST still work', async () => {
    const app = gated(pass, { user: asSusan });
    expect((await request(app).post('/usage/batch').send({})).status).toBe(204);
    expect((await request(app).post('/things/preview').send({})).status).toBe(200);
  });

  test('the same holds for a token-only browser', async () => {
    const t = token({ email: SUSAN, name: 'Susan Xu', role: 'viewer', viewAs: personView });
    expect((await request(gated(pass)).post('/probe').set('Authorization', `Bearer ${t}`).send({})).body.code).toBe('view_as_read_only');
  });
});

describe('POST / DELETE /auth/view-as', () => {
  function authApp(user) {
    const app = express();
    app.use(express.json());
    const session = { user, save: (cb) => cb(null) };
    app.use((req, _res, next) => { req.session = session; next(); });
    app.use('/api/auth', authRoutes);
    app.use(errorHandler);
    return { app, session };
  }
  const admin = { email: ADMIN, name: 'Vahid', role: 'admin', authMethod: 'sso', selectedWorkspaceId: 1 };

  test('only a super admin on the list may start a view; never a view inside a view', async () => {
    const viewer = authApp({ email: SUSAN, name: 'Susan', role: 'viewer', authMethod: 'sso' });
    expect((await request(viewer.app).post('/api/auth/view-as').send({ mode: 'role', role: 'reviewer', workspaceId: 1 })).body.code).toBe('super_admin_required');
    const nested = authApp({ ...admin, role: 'viewer', viewAs: roleView('reviewer') });
    expect((await request(nested.app).post('/api/auth/view-as').send({ mode: 'role', role: 'readonly', workspaceId: 1 })).body.code).toBe('view_as_active');
    expect((await request(authApp(null).app).post('/api/auth/view-as').send({})).status).toBe(401);
  });

  test('a role view: same person, one workspace with that role, the marker in session and token', async () => {
    const { app, session } = authApp({ ...admin });
    const r = await request(app).post('/api/auth/view-as').send({ mode: 'role', role: 'reviewer', workspaceId: 1 });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ email: ADMIN, role: 'viewer', viewAs: { mode: 'role', role: 'reviewer', workspaceId: 1, by: ADMIN, label: 'Reviewer in IT' } });
    expect(r.body.availableWorkspaces).toEqual([expect.objectContaining({ id: 1, role: 'reviewer' })]);
    expect(jwt.verify(r.body.authToken, config.session.secret)).toMatchObject({ email: ADMIN, role: 'viewer', viewAs: { mode: 'role', role: 'reviewer' } });
    expect(session.user).toMatchObject({ email: ADMIN, role: 'viewer', selectedWorkspaceId: 1, viewAs: { mode: 'role' } });
    // The next session check keeps the view (it does not re-promote from the super-admin list).
    const again = await request(app).get('/api/auth/session');
    expect(again.body.user).toMatchObject({ role: 'viewer', viewAs: { role: 'reviewer' } });
    expect(again.body.availableWorkspaces).toHaveLength(1);
  });

  test('bad input is refused: unknown role, unknown workspace, agent view without a technician profile, yourself, a stranger', async () => {
    const send = (body) => request(authApp({ ...admin }).app).post('/api/auth/view-as').send(body);
    expect((await send({ mode: 'role', role: 'owner', workspaceId: 1 })).status).toBe(400);
    expect((await send({ mode: 'role', role: 'reviewer', workspaceId: 99 })).status).toBe(400);
    expect((await send({ mode: 'role', role: 'agent', workspaceId: 1 })).body.message).toMatch(/no technician profile/);
    expect((await send({ mode: 'person', email: ADMIN })).status).toBe(400);
    expect((await send({ mode: 'person', email: 'nobody@bgc.ca' })).body.message).toMatch(/no access to Ticket Pulse/);
    expect((await send({ mode: 'ghost' })).status).toBe(400);
  });

  test('a person view takes their identity and access; exit gives the admin back', async () => {
    workspaceAccessFindMany.mockResolvedValue([{ email: SUSAN, role: 'reviewer', workspace: ws(1, 'IT') }]);
    getAgentProfilesMock.mockImplementation(async (email) => (email === SUSAN ? [{ id: 7, name: 'Susan Xu', workspaceId: 1 }] : []));
    const { app, session } = authApp({ ...admin });
    const r = await request(app).post('/api/auth/view-as').send({ mode: 'person', email: SUSAN });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ email: SUSAN, name: 'Susan Xu', role: 'viewer', viewAs: { mode: 'person', by: ADMIN, label: 'Susan Xu' } });
    expect(r.body.availableWorkspaces).toEqual([expect.objectContaining({ id: 1, role: 'reviewer' })]);
    expect(session.user.email).toBe(SUSAN);

    const out = await request(app).delete('/api/auth/view-as');
    expect(out.status).toBe(200);
    expect(out.body.user).toMatchObject({ email: ADMIN, role: 'admin' });
    expect(out.body.user.viewAs).toBeUndefined();
    expect(out.body.availableWorkspaces).toHaveLength(2);
    expect(session.user).toMatchObject({ email: ADMIN, role: 'admin' });
    expect(session.user.viewAs).toBeUndefined();
    expect((await request(app).delete('/api/auth/view-as')).body.code).toBe('view_as_inactive');
  });
});

describe('an open sign-in session follows the super-admin list (QA 10-08 #1)', () => {
  function sessionApp(user) {
    const app = express();
    const session = { user };
    app.use((req, _res, next) => { req.session = session; next(); });
    app.use('/api/auth', authRoutes);
    app.use(errorHandler);
    return { app, session };
  }

  test('removed from the list → the next session check is no longer an admin (their workspace role applies)', async () => {
    workspaceAccessFindMany.mockResolvedValue([{ email: SUSAN, role: 'reviewer', workspace: ws(1, 'IT') }]);
    const { app } = sessionApp({ email: SUSAN, name: 'Susan', role: 'admin', authMethod: 'sso' });
    const r = await request(app).get('/api/auth/session');
    expect(r.body.user.role).toBe('viewer');
    expect(r.body.availableWorkspaces).toEqual([expect.objectContaining({ id: 1, role: 'reviewer' })]);
  });

  test('added to the list → admin on the next session check; a dev-login role is left alone', async () => {
    settingsGet.mockResolvedValue(`${ADMIN},${SUSAN}`);
    const promoted = await request(sessionApp({ email: SUSAN, name: 'Susan', role: 'viewer', authMethod: 'sso' }).app).get('/api/auth/session');
    expect(promoted.body.user.role).toBe('admin');
    settingsGet.mockResolvedValue(ADMIN);
    const dev = await request(sessionApp({ email: 'dev@local', name: 'Dev', role: 'admin', authMethod: 'dev-bypass' }).app).get('/api/auth/session');
    expect(dev.body.user.role).toBe('admin');
  });
});
