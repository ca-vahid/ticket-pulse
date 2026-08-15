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

/**
 * SSE connection manager with per-workspace channels.
 * Clients register with a workspaceId; broadcasts target a specific workspace
 * (or all workspaces if workspaceId is omitted).
 */
class SSEConnectionManager {
  constructor() {
    this.channels = new Map();
  }

  addClient(client, workspaceId = null) {
    const key = workspaceId || '__global__';
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
   */
  broadcast(event, data, workspaceId = null) {
    const message = JSON.stringify(data);
    const formatted = `event: ${event}\ndata: ${message}\n\n`;
    let count = 0;

    const sendTo = (clients) => {
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

    if (workspaceId) {
      const wsClients = this.channels.get(workspaceId);
      if (wsClients) sendTo(wsClients);
    } else {
      for (const clients of this.channels.values()) {
        sendTo(clients);
      }
    }

    logger.debug(`Broadcasted ${event} to ${count} clients (workspace=${workspaceId || 'all'})`);
  }

  sendHeartbeat() {
    // A NAMED event, not an SSE comment: comments are invisible to the
    // browser's EventSource API, so clients had no way to notice a half-dead
    // connection (backend restarted behind a proxy/LB that keeps the client
    // socket open → no error, no events, stale screen forever). A real
    // heartbeat event lets useSSE's staleness watchdog detect the silence and
    // force a reconnect. Clients without a 'heartbeat' listener ignore it.
    //
    // CHANNEL-SCOPED with a membership proof (realtime plan Phase 1): each
    // channel gets its own payload carrying that channel's workspaceId, so a
    // client that landed on the WRONG channel (session/query divergence) can
    // detect the mismatch and reconnect with a corrected URL. A single
    // broadcast-to-all heartbeat used to keep such zombies looking "Live"
    // forever while their data events went to a channel nobody was on.
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
 * Resolve and validate the stream's workspace for GET /events.
 *
 * The workspace comes from the EXPLICIT `?workspaceId=` query param — never
 * the session. The global workspace middleware prefers the session, which for
 * a multi-tab user meant a tab could silently join another tab's channel and
 * zombify (heartbeats kept it "Live" while its data events went elsewhere).
 * This is deliberately scoped to the SSE route only — the global middleware
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
 * SSE endpoint for real-time dashboard updates
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

  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable buffering in nginx

  // Membership proof: the client validates this workspaceId against the
  // workspace it EXPECTS to be watching and reconnects on mismatch.
  res.write(`event: connected\ndata: ${JSON.stringify({ message: 'Connected to dashboard updates', workspaceId })}\n\n`);

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
 * GET /api/sse/status
 * Get SSE connection status
 */
router.get('/status', (req, res) => {
  res.json({
    success: true,
    data: {
      activeConnections: sseManager.getClientCount(),
    },
  });
});

export default router;
