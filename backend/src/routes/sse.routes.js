import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Protect all SSE routes with authentication
router.use(requireAuth);

/**
 * SSE connection manager
 */
class SSEConnectionManager {
  constructor() {
    this.clients = new Set();
  }

  /**
   * Add a new client connection
   */
  addClient(client) {
    this.clients.add(client);
    logger.info(`SSE client connected. Total clients: ${this.clients.size}`);
  }

  /**
   * Remove a client connection
   */
  removeClient(client) {
    this.clients.delete(client);
    logger.info(`SSE client disconnected. Total clients: ${this.clients.size}`);
  }

  /**
   * Broadcast data to all connected clients
   */
  broadcast(event, data) {
    const message = JSON.stringify(data);
    const formatted = `event: ${event}\ndata: ${message}\n\n`;

    this.clients.forEach(client => {
      try {
        client.write(formatted);
      } catch (error) {
        logger.error('Error sending SSE to client:', error);
        this.removeClient(client);
      }
    });

    logger.debug(`Broadcasted ${event} to ${this.clients.size} clients`);
  }

  /**
   * Send heartbeat to keep connections alive
   */
  sendHeartbeat() {
    const heartbeat = `:heartbeat ${Date.now()}\n\n`;

    this.clients.forEach(client => {
      try {
        client.write(heartbeat);
      } catch (error) {
        logger.error('Error sending heartbeat:', error);
        this.removeClient(client);
      }
    });
  }

  /**
   * Get number of active connections
   */
  getClientCount() {
    return this.clients.size;
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

  // Send initial connection message
  res.write('event: connected\ndata: {"message":"Connected to dashboard updates"}\n\n');

  // Add client to manager
  sseManager.addClient(res);

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
