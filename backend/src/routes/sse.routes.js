import express from 'express';
import { requireAuth, requireAdmin, createStreamReauthCheck } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import workspaceRepository from '../services/workspaceRepository.js';
import prisma from '../services/prisma.js';
import realtimeTelemetry from '../services/realtimeTelemetryService.js';
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

// Phase 3 hardening bounds (realtime plan):
// - Per-user connection cap. A misbehaving client (tab-restore storm, retry
//   bug) can otherwise pin dozens of sockets per person. Opening one past the
//   cap closes the user's OLDEST stream, after a `too_many_connections` event
//   so that tab shows a message instead of blind-reconnect-looping.
export const MAX_CONNECTIONS_PER_USER = 8;
// - Idle reap: a socket with no SUCCESSFUL write in this window is half-dead
//   (writes buffering into a dead pipe, or errors swallowed elsewhere) —
//   destroy it. Healthy sockets get a heartbeat write every 30s, so this is
//   ~4 missed heartbeats.
export const IDLE_REAP_MS = 120000;
// - Periodic re-auth of long-lived streams: re-validate the session/token the
//   stream connected with. On failure send `reauth` then close — the client
//   reconnects with fresh credentials.
export const REAUTH_INTERVAL_MS = 15 * 60 * 1000;
const HARDENING_TICK_MS = 60000;

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
    // Connection registry (Phase 3): client(res) -> { key, userEmail,
    // connectedAt, lastWriteOkAt, lastAuthCheckAt, revalidate, destroy }
    this.meta = new Map();
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

  addClient(client, workspaceId = null, { userEmail = null, revalidate = null, destroy = null } = {}) {
    const email = userEmail ? String(userEmail).toLowerCase() : null;
    // Enforce the per-user cap BEFORE adding, so the newest connection always
    // survives and the user's oldest one(s) get closed.
    this._enforceUserCap(email);

    const key = this._key(workspaceId);
    if (!this.channels.has(key)) {
      this.channels.set(key, new Set());
    }
    this.channels.get(key).add(client);
    const now = Date.now();
    this.meta.set(client, {
      key,
      userEmail: email,
      connectedAt: now,
      lastWriteOkAt: now,
      lastAuthCheckAt: now,
      revalidate,
      destroy,
    });
    logger.info(`SSE client connected (workspace=${workspaceId || 'global'}). Total clients: ${this._totalClients()}`);
  }

  removeClient(client) {
    this.meta.delete(client);
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
   * Write to one client, tracking write success in the registry. A throwing
   * write means the socket is dead — destroy + deregister it immediately.
   * @returns {boolean} whether the write succeeded
   */
  _write(client, text) {
    const meta = this.meta.get(client);
    try {
      const flushed = client.write(text);
      // res.write() returning false is backpressure (data queued, not lost) —
      // a HEALTHY socket drains quickly, so only a flushed write refreshes the
      // liveness stamp. A half-dead pipe buffers forever and gets reaped.
      if (flushed && meta) meta.lastWriteOkAt = Date.now();
      return true;
    } catch (error) {
      logger.error('Error writing to SSE client:', error);
      this._destroyClient(client);
      return false;
    }
  }

  /** Send an optional farewell event, tear the socket down, deregister. */
  _destroyClient(client, farewell = null) {
    const meta = this.meta.get(client);
    if (farewell) {
      try {
        client.write(`event: ${farewell.event}\ndata: ${JSON.stringify(farewell.data)}\n\n`);
      } catch { /* already dead — the farewell was best-effort */ }
    }
    try {
      if (meta?.destroy) meta.destroy();
      else client.end?.();
    } catch { /* already closed */ }
    this.removeClient(client);
  }

  /** Close the user's oldest connection(s) so a new one stays under the cap. */
  _enforceUserCap(userEmail) {
    if (!userEmail) return;
    const mine = [];
    for (const [client, meta] of this.meta) {
      if (meta.userEmail === userEmail) mine.push([client, meta]);
    }
    if (mine.length < MAX_CONNECTIONS_PER_USER) return;
    mine.sort((a, b) => a[1].connectedAt - b[1].connectedAt);
    const excess = mine.length - MAX_CONNECTIONS_PER_USER + 1;
    for (let i = 0; i < excess; i++) {
      logger.warn(`SSE per-user cap: closing oldest connection for ${userEmail} (${mine.length} open, cap ${MAX_CONNECTIONS_PER_USER})`);
      this._destroyClient(mine[i][0], {
        event: 'too_many_connections',
        data: {
          message: `Too many live connections for your account (limit ${MAX_CONNECTIONS_PER_USER}) — this one was closed in favor of a newer tab. Close unused tabs before reconnecting.`,
          limit: MAX_CONNECTIONS_PER_USER,
        },
      });
    }
  }

  /**
   * Reap half-dead sockets: already-ended responses, and connections with no
   * flushed write inside IDLE_REAP_MS (a dead pipe swallows writes silently —
   * see F4 "zombie" in docs/research/REALTIME_RELIABILITY_NOTES.md).
   * @returns {number} clients destroyed
   */
  reapIdleClients(now = Date.now()) {
    let reaped = 0;
    for (const [client, meta] of [...this.meta]) {
      const ended = client.writableEnded || client.destroyed;
      const idle = now - meta.lastWriteOkAt > IDLE_REAP_MS;
      if (ended || idle) {
        logger.warn(`SSE reaping ${ended ? 'ended' : 'idle'} connection (user=${meta.userEmail || 'unknown'}, last ok write ${Math.round((now - meta.lastWriteOkAt) / 1000)}s ago)`);
        this._destroyClient(client);
        reaped++;
      }
    }
    return reaped;
  }

  /**
   * Re-validate long-lived streams' credentials (every REAUTH_INTERVAL_MS per
   * connection). Invalid → `reauth` event, then close; the client reconnects
   * with a freshly-refreshed token.
   * @returns {Promise<{checked: number, dropped: number}>}
   */
  async revalidateClients(now = Date.now()) {
    const result = { checked: 0, dropped: 0 };
    for (const [client, meta] of [...this.meta]) {
      if (!meta.revalidate || now - meta.lastAuthCheckAt < REAUTH_INTERVAL_MS) continue;
      meta.lastAuthCheckAt = now;
      result.checked++;
      let valid = false;
      try {
        valid = await meta.revalidate();
      } catch {
        valid = false;
      }
      if (!valid && this.meta.has(client)) {
        logger.info(`SSE re-auth failed for ${meta.userEmail || 'unknown'} — dropping stream with reauth event`);
        this._destroyClient(client, {
          event: 'reauth',
          data: { message: 'Credentials expired — reconnect with a fresh session', ts: now },
        });
        result.dropped++;
      }
    }
    return result;
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
      // Snapshot: _write may destroy dead clients (mutating the live Set).
      for (const client of [...clients]) {
        if (this._write(client, formatted)) count++;
      }
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
      for (const client of [...clients]) {
        this._write(client, heartbeat);
      }
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

// Phase 3 hardening tick: reap half-dead sockets + re-auth due streams. The
// per-connection re-auth cadence lives in revalidateClients (REAUTH_INTERVAL_MS);
// this timer merely visits the registry once a minute.
const hardeningInterval = setInterval(() => {
  try {
    sseManager.reapIdleClients();
  } catch (error) {
    logger.debug(`SSE idle reap failed: ${error.message}`);
  }
  sseManager.revalidateClients().catch((error) => {
    logger.debug(`SSE re-auth sweep failed: ${error.message}`);
  });
}, HARDENING_TICK_MS);
hardeningInterval.unref?.();

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

  sseManager.addClient(res, workspaceId, {
    userEmail: (req.session?.user || req.user)?.email || null,
    revalidate: createStreamReauthCheck(req),
    destroy: () => {
      try { res.end(); } catch { /* already gone */ }
      // A half-dead pipe never acks end() — hard-destroy the socket too.
      try { res.socket?.destroy(); } catch { /* already gone */ }
    },
  });

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

/**
 * POST /api/sse/telemetry
 * Lightweight client-health reports (realtime plan Phase 3): the realtime
 * client samples ~10% of sessions (always on terminal offline) and reports
 * transport downgrades / offline transitions / reconnect churn. Stored only
 * as an in-memory per-day aggregate — fire-and-forget, never fails the
 * client, no table.
 */
router.post('/telemetry', (req, res) => {
  const user = req.session?.user || req.user;
  realtimeTelemetry.record({
    userEmail: user?.email || null,
    type: req.body?.type,
    transport: req.body?.transport,
    churn: req.body?.churn,
  });
  res.status(202).json({ success: true });
});

/**
 * GET /api/sse/telemetry/summary
 * Admin: today/yesterday realtime-health aggregate for the Settings
 * "Realtime health" block (downgrades, offline transitions, top affected
 * users with truncated emails — a support triage hint, not a leaderboard).
 */
router.get('/telemetry/summary', requireAdmin, (req, res) => {
  res.json({
    success: true,
    data: {
      ...realtimeTelemetry.summary(),
      activeConnections: sseManager.getClientCount(),
      epoch: sseManager.epoch,
    },
  });
});

export default router;
