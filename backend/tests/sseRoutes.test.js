import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Realtime reliability Phase 1 (plans/REALTIME_RELIABILITY_PLAN.md):
 *  1. Heartbeats are CHANNEL-scoped and carry the channel's workspaceId — a
 *     broadcast-to-all heartbeat used to keep wrong-channel zombies "Live"
 *     forever while their data events went to a channel nobody was on.
 *  2. GET /events resolves the workspace from the EXPLICIT ?workspaceId=
 *     query param (never the session), validates it against the user's
 *     accessible workspaces, and 400s when it's missing.
 */

const prismaMock = { technician: { findFirst: jest.fn() } };
const getAccessRoleMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({
  default: { getAccessRole: getAccessRoleMock },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// requireAuth pulls in jwt + config; the routes only need session-or-401.
jest.unstable_mockModule('../src/middleware/auth.js', () => ({
  requireAuth: (req, res, next) => {
    if (req.session?.user) return next();
    return res.status(401).json({ success: false, message: 'Authentication required' });
  },
}));

const { default: sseRoutes, sseManager, resolveSseWorkspace } = await import('../src/routes/sse.routes.js');

function makeApp(sessionUser, { sessionWorkspaceId = null } = {}) {
  const app = express();
  app.use((req, _res, next) => {
    if (sessionUser) req.session = { user: sessionUser };
    // Simulate the global workspace middleware having resolved the SESSION
    // workspace — the SSE route must ignore it in favor of the query param.
    if (sessionWorkspaceId) req.workspaceId = sessionWorkspaceId;
    next();
  });
  app.use('/api/sse', sseRoutes);
  return app;
}

function fakeClient() {
  return { write: jest.fn() };
}

const viewer = { email: 'Viewer@bgc.ca', role: 'viewer' };
const admin = { email: 'admin@bgc.ca', role: 'admin' };
const agent = { email: 'agent@bgc.ca', role: 'agent' };

beforeEach(() => {
  jest.clearAllMocks();
  getAccessRoleMock.mockResolvedValue(null);
  prismaMock.technician.findFirst.mockResolvedValue(null);
  sseManager.channels.clear();
});

describe('sendHeartbeat — channel-scoped with membership proof', () => {
  test('each channel receives ONLY its own heartbeat, stamped with its workspaceId', () => {
    const ws1a = fakeClient();
    const ws1b = fakeClient();
    const ws2 = fakeClient();
    sseManager.addClient(ws1a, 1);
    sseManager.addClient(ws1b, 1);
    sseManager.addClient(ws2, 2);

    sseManager.sendHeartbeat();

    for (const client of [ws1a, ws1b, ws2]) {
      expect(client.write).toHaveBeenCalledTimes(1);
    }

    const parse = (client) => {
      const raw = client.write.mock.calls[0][0];
      expect(raw).toMatch(/^event: heartbeat\n/);
      return JSON.parse(raw.match(/data: (.*)\n\n$/)[1]);
    };

    expect(parse(ws1a).workspaceId).toBe(1);
    expect(parse(ws1b).workspaceId).toBe(1);
    expect(parse(ws2).workspaceId).toBe(2);
    expect(typeof parse(ws2).ts).toBe('number');
  });

  test('global channel clients get workspaceId null', () => {
    const globalClient = fakeClient();
    sseManager.addClient(globalClient, null);
    sseManager.sendHeartbeat();
    const raw = globalClient.write.mock.calls[0][0];
    expect(JSON.parse(raw.match(/data: (.*)\n\n$/)[1]).workspaceId).toBeNull();
  });

  test('a client whose socket write throws is evicted, others still served', () => {
    const dead = { write: jest.fn(() => { throw new Error('EPIPE'); }) };
    const alive = fakeClient();
    sseManager.addClient(dead, 3);
    sseManager.addClient(alive, 3);

    sseManager.sendHeartbeat();

    expect(alive.write).toHaveBeenCalledTimes(1);
    expect(sseManager.getClientCount(3)).toBe(1);
  });
});

describe('broadcast — workspace scoping (regression guard)', () => {
  test('workspace-targeted events do not leak to other channels', () => {
    const ws1 = fakeClient();
    const ws2 = fakeClient();
    sseManager.addClient(ws1, 1);
    sseManager.addClient(ws2, 2);

    sseManager.broadcast('sync-completed', { ok: true }, 1);

    expect(ws1.write).toHaveBeenCalledTimes(1);
    expect(ws2.write).not.toHaveBeenCalled();
  });
});

describe('GET /api/sse/events — workspace resolution', () => {
  test('401 without auth', async () => {
    const res = await request(makeApp(null)).get('/api/sse/events?workspaceId=1');
    expect(res.status).toBe(401);
  });

  test('400 when workspaceId query param is missing (even with a session workspace)', async () => {
    const res = await request(makeApp(admin, { sessionWorkspaceId: 1 })).get('/api/sse/events');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('workspace_required');
  });

  test('400 when workspaceId is not a positive integer', async () => {
    const res = await request(makeApp(admin)).get('/api/sse/events?workspaceId=abc');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('workspace_invalid');
  });

  test('403 for a user with neither access row nor technician profile', async () => {
    const res = await request(makeApp(viewer)).get('/api/sse/events?workspaceId=2');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('workspace_forbidden');
    expect(getAccessRoleMock).toHaveBeenCalledWith('viewer@bgc.ca', 2);
  });

  test('query param wins over the session workspace and the connected event proves the channel', async () => {
    getAccessRoleMock.mockResolvedValue('viewer');
    const app = makeApp(viewer, { sessionWorkspaceId: 1 });
    const server = app.listen(0);
    try {
      const port = server.address().port;
      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/sse/events?workspaceId=2`, {
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');

      const reader = res.body.getReader();
      const { value } = await reader.read();
      const chunk = Buffer.from(value).toString('utf8');
      expect(chunk).toContain('event: connected');
      const payload = JSON.parse(chunk.match(/data: (.*)\n\n/)[1]);
      // Session said workspace 1 — the stream MUST be on the query's 2.
      expect(payload.workspaceId).toBe(2);
      expect(sseManager.getClientCount(2)).toBe(1);
      expect(sseManager.getClientCount(1)).toBe(0);
      // Access was validated against the QUERY workspace.
      expect(getAccessRoleMock).toHaveBeenCalledWith('viewer@bgc.ca', 2);
      controller.abort();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('resolveSseWorkspace — access tiers', () => {
  const reqFor = (user, workspaceId) => ({ query: { workspaceId }, session: { user } });

  test('admins pass without any membership lookup', async () => {
    await expect(resolveSseWorkspace(reqFor(admin, '5'))).resolves.toBe(5);
    expect(getAccessRoleMock).not.toHaveBeenCalled();
    expect(prismaMock.technician.findFirst).not.toHaveBeenCalled();
  });

  test('workspace members pass via their access row', async () => {
    getAccessRoleMock.mockResolvedValue('viewer');
    await expect(resolveSseWorkspace(reqFor(viewer, '3'))).resolves.toBe(3);
  });

  test('agent-role users pass via an active technician profile (no access rows)', async () => {
    prismaMock.technician.findFirst.mockResolvedValue({ id: 42 });
    await expect(resolveSseWorkspace(reqFor(agent, '4'))).resolves.toBe(4);
    expect(prismaMock.technician.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: 4, isActive: true }),
    }));
  });

  test('a DB error is NOT an access denial (mirrors requireWorkspaceAccess)', async () => {
    getAccessRoleMock.mockRejectedValue(new Error('db down'));
    prismaMock.technician.findFirst.mockRejectedValue(new Error('db down'));
    await expect(resolveSseWorkspace(reqFor(viewer, '6'))).resolves.toBe(6);
  });
});
