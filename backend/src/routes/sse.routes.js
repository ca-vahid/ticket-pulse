import express from 'express';
import { requireAuth } from '../middleware/auth.js';
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
    const heartbeat = `:heartbeat ${Date.now()}\n\n`;

    for (const clients of this.channels.values()) {
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

// Start heartbeat interval (every 30 seconds)
setInterval(() => {
  sseManager.sendHeartbeat();
}, 30000);

/**
 * GET /api/sse/events
 * SSE endpoint for real-time dashboard updates
 */
router.get('/events', (req, res) => {
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable buffering in nginx

  const workspaceId = req.workspaceId || (req.query.workspaceId ? Number(req.query.workspaceId) : null);

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
});

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
