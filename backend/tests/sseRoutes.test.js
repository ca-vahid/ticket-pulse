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

const {
  default: sseRoutes,
  sseManager,
  resolveSseWorkspace,
  RING_MAX_EVENTS,
  RING_MAX_AGE_MS,
} = await import('../src/routes/sse.routes.js');

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
  sseManager.buffers.clear();
  sseManager.waiters.clear();
});

/** Read the SSE stream until a predicate matches (Express may split writes). */
async function readStreamUntil(reader, predicate, maxReads = 10) {
  let text = '';
  for (let i = 0; i < maxReads; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    text += Buffer.from(value).toString('utf8');
    if (predicate(text)) break;
  }
  return text;
}

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
    const controller = new AbortController();
    try {
      const port = server.address().port;
      const res = await fetch(`http://127.0.0.1:${port}/api/sse/events?workspaceId=2`, {
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const reader = res.body.getReader();
      const chunk = await readStreamUntil(reader, (t) => t.includes('event: connected') && t.match(/event: connected\ndata: .*\n\n/));
      expect(chunk).toContain('event: connected');
      const payload = JSON.parse(chunk.match(/event: connected\ndata: (.*)\n\n/)[1]);
      // Session said workspace 1 — the stream MUST be on the query's 2.
      expect(payload.workspaceId).toBe(2);
      expect(sseManager.getClientCount(2)).toBe(1);
      expect(sseManager.getClientCount(1)).toBe(0);
      // Access was validated against the QUERY workspace.
      expect(getAccessRoleMock).toHaveBeenCalledWith('viewer@bgc.ca', 2);
    } finally {
      // Abort BEFORE close — server.close waits for open connections, so an
      // un-aborted SSE stream would hang the test to timeout.
      controller.abort();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// ---------------------------------------------------------------------------
// Realtime plan Phase 2 — protocol: hello, monotonic ids, ring buffer,
// Last-Event-ID replay, resync, and the long-poll endpoint.
// ---------------------------------------------------------------------------

describe('broadcast — monotonic per-workspace ids + ring buffer', () => {
  test('data events carry an id: field with the epoch and a monotonic counter', () => {
    const ws1 = fakeClient();
    sseManager.addClient(ws1, 1);
    sseManager.broadcast('ticket-change', { a: 1 }, 1);
    sseManager.broadcast('sync-completed', { b: 2 }, 1);

    const first = ws1.write.mock.calls[0][0];
    const second = ws1.write.mock.calls[1][0];
    expect(first).toMatch(new RegExp(`^id: ${sseManager.epoch}:1\\n`));
    expect(second).toMatch(new RegExp(`^id: ${sseManager.epoch}:2\\n`));
    expect(second).toContain('event: sync-completed');
  });

  test('ids are independent per workspace', () => {
    sseManager.broadcast('ticket-change', {}, 1);
    sseManager.broadcast('ticket-change', {}, 1);
    sseManager.broadcast('ticket-change', {}, 2);
    expect(sseManager.cursorFor(1)).toBe(`${sseManager.epoch}:2`);
    expect(sseManager.cursorFor(2)).toBe(`${sseManager.epoch}:1`);
  });

  test('events are buffered even with no client connected (replay across reconnects)', () => {
    sseManager.broadcast('ticket-change', { while: 'disconnected' }, 3);
    const result = sseManager.eventsAfter(3, `${sseManager.epoch}:0`);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].data).toEqual({ while: 'disconnected' });
  });

  test('the ring buffer keeps at most RING_MAX_EVENTS', () => {
    for (let i = 0; i < RING_MAX_EVENTS + 50; i++) {
      sseManager.broadcast('ticket-change', { i }, 4);
    }
    const buf = sseManager.buffers.get(4);
    expect(buf.events).toHaveLength(RING_MAX_EVENTS);
    // Oldest retained id is 51 — a cursor before that can't be replayed.
    expect(buf.events[0].id).toBe(51);
  });

  test('events older than the age bound are pruned', () => {
    sseManager.broadcast('ticket-change', { old: true }, 5);
    const buf = sseManager.buffers.get(5);
    buf.events[0].ts = Date.now() - RING_MAX_AGE_MS - 1000;
    sseManager.broadcast('ticket-change', { fresh: true }, 5);
    expect(buf.events).toHaveLength(1);
    expect(buf.events[0].data).toEqual({ fresh: true });
  });

  test('heartbeats are NOT buffered and carry no id', () => {
    const ws = fakeClient();
    sseManager.addClient(ws, 6);
    sseManager.sendHeartbeat();
    expect(ws.write.mock.calls[0][0]).toMatch(/^event: heartbeat\n/);
    expect(sseManager.buffers.get(6)).toBeUndefined();
  });
});

describe('eventsAfter — replay/resync decisions', () => {
  test('replays only events after the cursor', () => {
    sseManager.broadcast('ticket-change', { n: 1 }, 1);
    sseManager.broadcast('ticket-change', { n: 2 }, 1);
    sseManager.broadcast('ticket-change', { n: 3 }, 1);
    const result = sseManager.eventsAfter(1, `${sseManager.epoch}:1`);
    expect(result.events.map((e) => e.data.n)).toEqual([2, 3]);
  });

  test('an up-to-date cursor replays nothing', () => {
    sseManager.broadcast('ticket-change', {}, 1);
    expect(sseManager.eventsAfter(1, `${sseManager.epoch}:1`)).toEqual({ events: [] });
  });

  test('a cursor from another epoch → resync (server restarted)', () => {
    sseManager.broadcast('ticket-change', {}, 1);
    expect(sseManager.eventsAfter(1, 'deadepoch:1')).toEqual({ resync: true });
  });

  test('a cursor older than the buffer retains → resync (gap exceeds buffer)', () => {
    for (let i = 0; i < RING_MAX_EVENTS + 10; i++) {
      sseManager.broadcast('ticket-change', { i }, 1);
    }
    expect(sseManager.eventsAfter(1, `${sseManager.epoch}:2`)).toEqual({ resync: true });
  });

  test('malformed and future cursors → resync', () => {
    sseManager.broadcast('ticket-change', {}, 1);
    expect(sseManager.eventsAfter(1, 'garbage')).toEqual({ resync: true });
    expect(sseManager.eventsAfter(1, `${sseManager.epoch}:999`)).toEqual({ resync: true });
  });
});

describe('GET /api/sse/events — hello + replay protocol', () => {
  async function openStream(app, path) {
    const server = app.listen(0);
    const port = server.address().port;
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: controller.signal });
    return {
      res,
      close: async () => {
        controller.abort();
        await new Promise((resolve) => server.close(resolve));
      },
    };
  }

  test('sends retry hint + hello (epoch, workspaceId, lastEventId) before connected', async () => {
    sseManager.broadcast('ticket-change', {}, 2);
    const { res, close } = await openStream(makeApp(admin), '/api/sse/events?workspaceId=2');
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toContain('no-transform');
      const reader = res.body.getReader();
      const text = await readStreamUntil(reader, (t) => t.includes('event: connected'));
      expect(text).toMatch(/^retry: 5000\n\n/);
      const hello = JSON.parse(text.match(/event: hello\ndata: (.*)\n/)[1]);
      expect(hello.epoch).toBe(sseManager.epoch);
      expect(hello.workspaceId).toBe(2);
      expect(hello.lastEventId).toBe(`${sseManager.epoch}:1`);
      expect(text.indexOf('event: hello')).toBeLessThan(text.indexOf('event: connected'));
    } finally {
      await close();
    }
  });

  test('Last-Event-ID header replays the buffered gap with ids', async () => {
    sseManager.broadcast('ticket-change', { n: 1 }, 2);
    sseManager.broadcast('ticket-change', { n: 2 }, 2);
    sseManager.broadcast('sync-completed', { n: 3 }, 2);

    const app = makeApp(admin);
    const server = app.listen(0);
    const controller = new AbortController();
    try {
      const port = server.address().port;
      const res = await fetch(`http://127.0.0.1:${port}/api/sse/events?workspaceId=2`, {
        headers: { 'Last-Event-ID': `${sseManager.epoch}:1` },
        signal: controller.signal,
      });
      const reader = res.body.getReader();
      const text = await readStreamUntil(reader, (t) => t.includes('event: sync-completed'));
      expect(text).toContain(`id: ${sseManager.epoch}:2\nevent: ticket-change`);
      expect(text).toContain(`id: ${sseManager.epoch}:3\nevent: sync-completed`);
      expect(text).not.toContain('"n":1'); // before the cursor — not replayed
      expect(text).not.toContain('event: resync');
    } finally {
      controller.abort();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('an epoch-mismatched Last-Event-ID gets a resync event instead of replay', async () => {
    sseManager.broadcast('ticket-change', { n: 1 }, 2);
    const { res, close } = await openStream(makeApp(admin), '/api/sse/events?workspaceId=2&lastEventId=oldepoch:99');
    try {
      const reader = res.body.getReader();
      const text = await readStreamUntil(reader, (t) => t.includes('event: resync'));
      expect(text).toContain('event: resync');
      const resync = JSON.parse(text.match(/event: resync\ndata: (.*)\n/)[1]);
      expect(resync.cursor).toBe(`${sseManager.epoch}:1`);
      expect(resync.epoch).toBe(sseManager.epoch);
    } finally {
      await close();
    }
  });
});

describe('GET /api/sse/poll — long-poll fallback', () => {
  test('same auth tiers as /events: 401 / 400 / 403', async () => {
    expect((await request(makeApp(null)).get('/api/sse/poll?workspaceId=1')).status).toBe(401);
    const missing = await request(makeApp(admin)).get('/api/sse/poll');
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('workspace_required');
    const forbidden = await request(makeApp(viewer)).get('/api/sse/poll?workspaceId=2');
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe('workspace_forbidden');
  });

  test('no cursor → immediate baseline (current cursor + epoch, no events)', async () => {
    sseManager.broadcast('ticket-change', {}, 1);
    const res = await request(makeApp(admin)).get('/api/sse/poll?workspaceId=1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [], cursor: `${sseManager.epoch}:1`, epoch: sseManager.epoch });
  });

  test('buffered events after the cursor return immediately', async () => {
    sseManager.broadcast('ticket-change', { n: 1 }, 1);
    sseManager.broadcast('sync-completed', { n: 2 }, 1);
    const res = await request(makeApp(admin))
      .get(`/api/sse/poll?workspaceId=1&cursor=${encodeURIComponent(`${sseManager.epoch}:1`)}`);
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([
      expect.objectContaining({ id: `${sseManager.epoch}:2`, event: 'sync-completed', data: { n: 2 } }),
    ]);
    expect(res.body.cursor).toBe(`${sseManager.epoch}:2`);
  });

  test('holds until a broadcast lands, then returns it (long-poll wake)', async () => {
    sseManager.broadcast('ticket-change', { n: 1 }, 1);
    const pending = request(makeApp(admin))
      .get(`/api/sse/poll?workspaceId=1&cursor=${encodeURIComponent(`${sseManager.epoch}:1`)}&wait=5000`);
    // Give the request a beat to register its waiter, then broadcast.
    await new Promise((resolve) => setTimeout(resolve, 150));
    sseManager.broadcast('ticket-change', { n: 2 }, 1);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body.events.map((e) => e.data.n)).toEqual([2]);
  });

  test('wait=0 acts as a short-poll: immediate empty response on no news', async () => {
    sseManager.broadcast('ticket-change', {}, 1);
    const started = Date.now();
    const res = await request(makeApp(admin))
      .get(`/api/sse/poll?workspaceId=1&cursor=${encodeURIComponent(`${sseManager.epoch}:1`)}&wait=0`);
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
    expect(res.body.cursor).toBe(`${sseManager.epoch}:1`);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('a stale/foreign cursor returns resync: true with the current cursor', async () => {
    sseManager.broadcast('ticket-change', {}, 1);
    const res = await request(makeApp(admin))
      .get('/api/sse/poll?workspaceId=1&cursor=deadepoch:9&wait=0');
    expect(res.status).toBe(200);
    expect(res.body.resync).toBe(true);
    expect(res.body.events).toEqual([]);
    expect(res.body.cursor).toBe(`${sseManager.epoch}:1`);
  });

  test('short hold times out and returns empty with the unchanged cursor', async () => {
    sseManager.broadcast('ticket-change', {}, 1);
    const res = await request(makeApp(admin))
      .get(`/api/sse/poll?workspaceId=1&cursor=${encodeURIComponent(`${sseManager.epoch}:1`)}&wait=300`);
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
    expect(res.body.cursor).toBe(`${sseManager.epoch}:1`);
    expect(res.body.resync).toBeUndefined();
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
