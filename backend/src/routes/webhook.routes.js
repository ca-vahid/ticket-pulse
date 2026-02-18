import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { handleTicketWebhook, testWebhook } from '../controllers/webhook.controller.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * Webhook authentication middleware
 * Verifies webhook requests using a shared secret
 */
const authenticateWebhook = (req, res, next) => {
  const authHeader = req.headers['x-webhook-secret'] || req.headers['authorization'];
  const expectedSecret = config.webhook.secret;

  if (!authHeader) {
    logger.warn('Webhook request missing authentication header', {
      ip: req.ip,
      path: req.path,
    });
    return res.status(401).json({
      success: false,
      message: 'Webhook authentication required',
    });
  }

  // Support both "Bearer <secret>" and direct secret
  const providedSecret = authHeader.startsWith('Bearer ')
    ? authHeader.substring(7)
    : authHeader;

  if (providedSecret !== expectedSecret) {
    logger.warn('Webhook request with invalid secret', {
      ip: req.ip,
      path: req.path,
    });
    return res.status(403).json({
      success: false,
      message: 'Invalid webhook secret',
    });
  }

  next();
};

/**
 * POST /api/webhook/ticket
 * Receive incoming ticket and trigger auto-response
 */
router.post('/ticket', authenticateWebhook, asyncHandler(handleTicketWebhook));

/**
 * GET /api/webhook/test
 * Test endpoint (authenticated)
 */
router.get('/test', authenticateWebhook, asyncHandler(testWebhook));

export default router;

