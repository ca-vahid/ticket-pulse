import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import workspaceRepository from '../services/workspaceRepository.js';
import prisma from '../services/prisma.js';
import logger from '../utils/logger.js';

const router = express.Router();

// For SSE, accept JWT via query param since EventSource doesn't support headers
router.use((req, res, next) => {
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
});

router.use(requireAuth);

// Server-process epoch (realtime plan Phase 2): stamped into every event id
// and the `hello` event so clients can detect a backend restart — after a
// restart the per-workspace id counters reset, so a client cursor from the
// previous epoch can never be replayed and must trigger a full resync.
const SERVER_EPOCH = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// Replay ring buffer bounds: last ~500 events or 10 minutes per workspace,
// whichever is smaller. In-memory only — replay is an optimization, full
// refetch (resync) is the correctness mechanism.
export const RING_MAX_EVENTS = 500;
export const RING_MAX_AGE_MS = 10 * 60 * 1000;

// Long-poll hold ceiling — well under Azure's 230s no-byte kill and typical
// corporate-proxy request timeouts.
const POLL_MAX_WAIT_MS = 25000;

/**
 * SSE connection manager with per-workspace channels.
 * Clients register with a workspaceId; broadcasts target a specific workspace
 * (or all workspaces if workspaceId is omitted).
 *
 * Phase 2 additions:
 * - Monotonic per-workspace event ids (`<epoch>:<n>`) stamped as the SSE
 *   `id:` field on every data event.
 * - A per-workspace replay ring buffer that OUTLIVES connections, so a
 *   reconnecting client with a Last-Event-ID can catch up on missed events.
 * - Long-poll waiters: `waitForEvent` parks a promise that resolves when the
 *   next event lands on the workspace channel (used by GET /poll).
 */
class SSEConnectionManager {
  constructor() {
    this.channels = new Map();
    this.epoch = SERVER_EPOCH;
    // key -> { nextId, events: [{ id, event, data, message, ts }] }
    this.buffers = new Map();
    // key -> Set<resolve> — pending long-poll waiters
    this.waiters = new Map();
  }

  _key(workspaceId) {
    return workspaceId || '__global__';
  }

  _buffer(key) {
    if (!this.buffers.has(key)) {
      this.buffers.set(key, { nextId: 1, events: [] });
    }
    return this.buffers.get(key);
  }

  _prune(buf, now = Date.now()) {
    const cutoff = now - RING_MAX_AGE_MS;
    while (
      buf.events.length > RING_MAX_EVENTS
      || (buf.events.length > 0 && buf.events[0].ts < cutoff)
    ) {
      buf.events.shift();
    }
  }

  /** Cursor string for the LATEST buffered event of a workspace ("epoch:n"). */
  cursorFor(workspaceId) {
    const buf = this.buffers.get(this._key(workspaceId));
    const lastId = buf && buf.events.length > 0
      ? buf.events[buf.events.length - 1].id
      : (buf ? buf.nextId - 1 : 0);
    return `${this.epoch}:${lastId}`;
  }

  /** Parse an "epoch:n" cursor; null when malformed. */
  parseCursor(raw) {
    if (typeof raw !== 'string' || raw === '') return null;
    const sep = raw.lastIndexOf(':');
    if (sep <= 0) return null;
    const id = Number(raw.slice(sep + 1));
    if (!Number.isInteger(id) || id < 0) return null;
    return { epoch: raw.slice(0, sep), id };
  }

  /**
   * Events buffered AFTER the given cursor for a workspace.
   * @returns {{ resync: true } | { events: Array }} resync when the cursor is
   *   from another epoch, malformed, or older than the buffer retains — the
   *   client must full-refetch instead of trusting replay.
   */
  eventsAfter(workspaceId, cursorRaw) {
    const cursor = this.parseCursor(cursorRaw);
    if (!cursor) return { resync: true };
    if (cursor.epoch !== this.epoch) return { resync: true };

    const buf = this.buffers.get(this._key(workspaceId));
    if (!buf) {
      // Nothing ever emitted this epoch — only the zero cursor is coherent.
      return cursor.id === 0 ? { events: [] } : { resync: true };
    }
    this._prune(buf);

    const latest = buf.nextId - 1;
    if (cursor.id > latest) return { resync: true };
    if (cursor.id === latest) return { events: [] };
    // Some events after the cursor exist; they're replayable only if the
    // buffer still retains everything from cursor+1 onward.
    if (buf.events.length === 0 || buf.events[0].id > cursor.id + 1) {
      return { resync: true };
    }
    return { events: buf.events.filter((e) => e.id > cursor.id) };
  }

  /** Record an event in a workspace buffer; returns the entry (with id). */
  _record(key, event, data) {
    const buf = this._buffer(key);
    const id = buf.nextId++;
    const entry = {
      id,
      event,
      data,
      message: JSON.stringify(data),
      ts: Date.now(),
    };
    buf.events.push(entry);
    this._prune(buf);
    return entry;
  }

  _notifyWaiters(key) {
    const set = this.waiters.get(key);
    if (!set) return;
    this.waiters.delete(key);
    for (const resolve of set) resolve(true);
  }

  /**
   * Park until the next event lands on the workspace channel (long-poll).
   * Resolves true when notified, false on timeout. `signal`-style early
   * release via the returned cancel function.
   */
  waitForEvent(workspaceId, timeoutMs) {
    const key = this._key(workspaceId);
    let resolveFn;
    let timer;
    const promise = new Promise((resolve) => {
      resolveFn = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      timer = setTimeout(() => {
        this._removeWaiter(key, resolveFn);
        resolveFn(false);
      }, timeoutMs);
      timer.unref?.();
      if (!this.waiters.has(key)) this.waiters.set(key, new Set());
      this.waiters.get(key).add(resolveFn);
    });
    return {
      promise,
      cancel: () => {
        this._removeWaiter(key, resolveFn);
        resolveFn(false);
      },
    };
  }

  _removeWaiter(key, resolveFn) {
    const set = this.waiters.get(key);
    if (!set) return;
    set.delete(resolveFn);
    if (set.size === 0) this.waiters.delete(key);
  }

  addClient(client, workspaceId = null) {
    const key = this._key(workspaceId);
    if (!this.channels.has(key)) {
      this.channels.set(key, new Set());
    }
    this.channels.get(key).add(client);
    logger.info(`SSE client connected (workspace=${workspaceId || 'global'}). Total clients: ${this._totalClients()}`);
  }

  removeClient(client) {
    for (const [key, clients] of this.channels) {
      if (clients.has(client)) {
        clients.delete(client);
        if (clients.size === 0) this.channels.delete(key);
        break;
      }
    }
    logger.info(`SSE client disconnected. Total clients: ${this._totalClients()}`);
  }

  /**
   * Broadcast to clients in a specific workspace.
   * If workspaceId is null, broadcasts to all clients.
   * Every data event gets a monotonic per-workspace id (SSE `id:` field) and
   * is recorded in that workspace's replay ring buffer.
   */
  broadcast(event, data, workspaceId = null) {
    let count = 0;

    const sendTo = (clients, formatted) => {
      if (!clients) return;
      clients.forEach(client => {
        try {
          client.write(formatted);
          count++;
        } catch (error) {
          logger.error('Error sending SSE to client:', error);
          this.removeClient(client);
        }
      });
    };

    const emitOn = (key) => {
      const entry = this._record(key, event, data);
      const formatted = `id: ${this.epoch}:${entry.id}\nevent: ${event}\ndata: ${entry.message}\n\n`;
      sendTo(this.channels.get(key), formatted);
      this._notifyWaiters(key);
    };

    if (workspaceId) {
      emitOn(this._key(workspaceId));
    } else {
      // Global broadcast: stamp a per-workspace id on every known channel and
      // buffer, so replay/polling stays coherent per workspace.
      const keys = new Set([...this.channels.keys(), ...this.buffers.keys()]);
      for (const key of keys) emitOn(key);
    }

    logger.debug(`Broadcasted ${event} to ${count} clients (workspace=${workspaceId || 'all'})`);
  }

  sendHeartbeat() {
    // A NAMED event, not an SSE comment: comments are invisible to the
    // browser's EventSource API, so clients had no way to notice a half-dead
    // connection (backend restarted behind a proxy/LB that keeps the client
    // socket open → no error, no events, stale screen forever). A real
    // heartbeat event lets the client's staleness watchdog detect the silence
    // and force a reconnect. Clients without a 'heartbeat' listener ignore it.
    //
    // CHANNEL-SCOPED with a membership proof (realtime plan Phase 1): each
    // channel gets its own payload carrying that channel's workspaceId, so a
    // client that landed on the WRONG channel (session/query divergence) can
    // detect the mismatch and reconnect with a corrected URL. A single
    // broadcast-to-all heartbeat used to keep such zombies looking "Live"
    // forever while their data events went to a channel nobody was on.
    //
    // Heartbeats are NOT recorded in the ring buffer and carry no id: they
    // are liveness pings, not data — replaying them is pointless and they
    // would evict real events.
    for (const [key, clients] of this.channels) {
      const workspaceId = key === '__global__' ? null : key;
      const heartbeat = `event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now(), workspaceId })}\n\n`;
      clients.forEach(client => {
        try {
          client.write(heartbeat);
        } catch (error) {
          logger.error('Error sending heartbeat:', error);
          this.removeClient(client);
        }
      });
    }
  }

  getClientCount(workspaceId = null) {
    if (workspaceId) {
      return this.channels.get(workspaceId)?.size || 0;
    }
    return this._totalClients();
  }

  _totalClients() {
    let total = 0;
    for (const clients of this.channels.values()) {
      total += clients.size;
    }
    return total;
  }
}

// Create singleton instance
export const sseManager = new SSEConnectionManager();

// Start heartbeat interval (every 30 seconds). unref() so the timer never
// pins the process (matters for test runners; harmless in production).
const heartbeatInterval = setInterval(() => {
  sseManager.sendHeartbeat();
}, 30000);
heartbeatInterval.unref?.();

/**
 * Resolve and validate the stream's workspace for GET /events and GET /poll.
 *
 * The workspace comes from the EXPLICIT `?workspaceId=` query param — never
 * the session. The global workspace middleware prefers the session, which for
 * a multi-tab user meant a tab could silently join another tab's channel and
 * zombify (heartbeats kept it "Live" while its data events went elsewhere).
 * This is deliberately scoped to the SSE routes only — the global middleware
 * order is untouched.
 *
 * Access model mirrors /api/search + /api/tickets: global admin, a
 * workspace_access row, or an active technician profile in the workspace
 * (agent-role users have no access rows but are first-class SSE consumers).
 *
 * @returns {Promise<number>} the validated workspaceId
 * @throws {{ status, code, message }} on validation failure
 */
export async function resolveSseWorkspace(req) {
  const raw = req.query.workspaceId;
  if (raw === undefined || raw === null || raw === '') {
    throw { status: 400, code: 'workspace_required', message: 'workspaceId query parameter is required for the event stream' };
  }
  const workspaceId = Number(raw);
  if (!Number.isInteger(workspaceId) || workspaceId <= 0) {
    throw { status: 400, code: 'workspace_invalid', message: 'workspaceId must be a positive integer' };
  }

  const user = req.session?.user || req.user;
  if (user?.role === 'admin') return workspaceId;

  const email = user?.email?.toLowerCase();
  if (!email) {
    throw { status: 403, code: 'workspace_forbidden', message: 'You do not have access to this workspace' };
  }

  try {
    const [accessRole, technician] = await Promise.all([
      workspaceRepository.getAccessRole(email, workspaceId),
      prisma.technician.findFirst({
        where: {
          workspaceId,
          isActive: true,
          email: { equals: email, mode: 'insensitive' },
        },
        select: { id: true },
      }),
    ]);
    if (accessRole || technician) return workspaceId;
  } catch (error) {
    // A DB hiccup is not an access denial (mirrors requireWorkspaceAccess's
    // posture) — let the stream through rather than locking users out.
    logger.error('SSE workspace validation failed (DB); allowing stream:', error.message);
    return workspaceId;
  }

  logger.warn(`SSE access denied for ${email} to workspace ${workspaceId}`);
  throw { status: 403, code: 'workspace_forbidden', message: 'You do not have access to this workspace' };
}

/**
 * GET /api/sse/events
 * SSE endpoint for real-time dashboard updates.
 *
 * Protocol (Phase 2):
 * - `retry: 5000` hint so native clients don't hammer at the 3s default.
 * - Immediate `hello` event: `{ epoch, workspaceId, lastEventId }` — the
 *   client REQUIRES it within 5s of headers, which converts a proxy-buffered
 *   stream ("eternal connecting") into a detectable failure.
 * - `connected` event kept unchanged for old deployed bundles.
 * - `Last-Event-ID` header (or `?lastEventId=`) triggers replay of buffered
 *   events after that cursor; when the gap exceeds the buffer or the epoch
 *   changed, a `resync` event tells the client to full-refetch instead.
 */
router.get('/events', asyncHandler(async (req, res) => {
  let workspaceId;
  try {
    workspaceId = await resolveSseWorkspace(req);
  } catch (problem) {
    if (problem?.status) {
      return res.status(problem.status).json({ success: false, code: problem.code, message: problem.message });
    }
    throw problem;
  }

  // Set headers for SSE. `no-transform` asks compliant intermediaries not to
  // buffer/transform; X-Accel-Buffering unbuffers nginx-family hops.
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable buffering in nginx

  res.write('retry: 5000\n\n');

  // Hello-within-5s contract: epoch (restart detection) + channel workspace
  // (membership proof) + the latest buffered cursor (replay baseline).
  res.write(`event: hello\ndata: ${JSON.stringify({
    epoch: sseManager.epoch,
    workspaceId,
    lastEventId: sseManager.cursorFor(workspaceId),
  })}\n\n`);

  // Membership proof: the client validates this workspaceId against the
  // workspace it EXPECTS to be watching and reconnects on mismatch.
  res.write(`event: connected\ndata: ${JSON.stringify({ message: 'Connected to dashboard updates', workspaceId })}\n\n`);

  // Replay after Last-Event-ID (native EventSource sends the header on its
  // auto-reconnects; the fetch client sends it explicitly).
  const lastEventId = req.headers['last-event-id'] || req.query.lastEventId;
  if (lastEventId) {
    const result = sseManager.eventsAfter(workspaceId, String(lastEventId));
    if (result.resync) {
      res.write(`event: resync\ndata: ${JSON.stringify({
        reason: 'gap-or-epoch',
        cursor: sseManager.cursorFor(workspaceId),
        epoch: sseManager.epoch,
      })}\n\n`);
    } else {
      for (const entry of result.events) {
        res.write(`id: ${sseManager.epoch}:${entry.id}\nevent: ${entry.event}\ndata: ${entry.message}\n\n`);
      }
    }
  }

  sseManager.addClient(res, workspaceId);

  // Clean up on client disconnect
  req.on('close', () => {
    sseManager.removeClient(res);
  });

  req.on('error', error => {
    logger.error('SSE request error:', error);
    sseManager.removeClient(res);
  });
}));

/**
 * GET /api/sse/poll?workspaceId=&cursor=&wait=
 * Transport-ladder fallback (long-poll / short-poll) sharing the SSE ring
 * buffer + cursor scheme, so demotion/promotion between transports never
 * loses or duplicates events. Same auth tiers as /events.
 *
 * - Events already buffered after `cursor` → returned immediately.
 * - Otherwise holds up to 25s (`wait` caps it; `wait=0` = short-poll) and
 *   returns whatever arrived, or empty with the current cursor on timeout.
 * - `resync: true` when the cursor fell out of the buffer / epoch changed —
 *   the client must full-refetch.
 */
router.get('/poll', asyncHandler(async (req, res) => {
  let workspaceId;
  try {
    workspaceId = await resolveSseWorkspace(req);
  } catch (problem) {
    if (problem?.status) {
      return res.status(problem.status).json({ success: false, code: problem.code, message: problem.message });
    }
    throw problem;
  }

  const rawWait = req.query.wait;
  const waitMs = rawWait === undefined
    ? POLL_MAX_WAIT_MS
    : Math.max(0, Math.min(POLL_MAX_WAIT_MS, Number(rawWait) || 0));

  const respond = (events, { resync = false } = {}) => {
    res.json({
      events: events.map((e) => ({
        id: `${sseManager.epoch}:${e.id}`,
        event: e.event,
        data: e.data,
        ts: e.ts,
      })),
      cursor: events.length > 0
        ? `${sseManager.epoch}:${events[events.length - 1].id}`
        : sseManager.cursorFor(workspaceId),
      epoch: sseManager.epoch,
      ...(resync ? { resync: true } : {}),
    });
  };

  // No cursor yet: establish a baseline immediately — the client's consumers
  // full-refetch on transport (re)establishment anyway.
  const cursorRaw = req.query.cursor;
  if (cursorRaw === undefined || cursorRaw === null || cursorRaw === '') {
    return respond([]);
  }

  let result = sseManager.eventsAfter(workspaceId, String(cursorRaw));
  if (result.resync) return respond([], { resync: true });
  if (result.events.length > 0 || waitMs === 0) return respond(result.events);

  // Hold until the next event lands on this workspace channel or timeout.
  const waiter = sseManager.waitForEvent(workspaceId, waitMs);
  const onClose = () => waiter.cancel();
  req.on('close', onClose);
  await waiter.promise;
  req.removeListener('close', onClose);
  if (res.writableEnded || req.destroyed) return undefined;

  result = sseManager.eventsAfter(workspaceId, String(cursorRaw));
  if (result.resync) return respond([], { resync: true });
  return respond(result.events);
}));

/**
 * GET /api/sse/status
 * Get SSE connection status
 */
router.get('/status', (req, res) => {
  res.json({
    success: true,
    data: {
      activeConnections: sseManager.getClientCount(),
      epoch: sseManager.epoch,
    },
  });
});

export default router;
