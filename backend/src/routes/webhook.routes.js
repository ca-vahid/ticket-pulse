import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { handleTicketWebhook, testWebhook, handleAssignmentWebhook } from '../controllers/webhook.controller.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import prisma from '../services/prisma.js';

const router = express.Router();

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
 * Resolve workspace from URL slug and set req.workspaceId.
 * Webhook URLs are: /api/webhook/:workspaceSlug/ticket
 */
const resolveWorkspaceSlug = async (req, res, next) => {
  const { workspaceSlug } = req.params;
  if (!workspaceSlug) {
    return res.status(400).json({ success: false, message: 'Workspace slug is required' });
  }

  try {
    const workspace = await prisma.workspace.findUnique({
      where: { slug: workspaceSlug },
      select: { id: true, isActive: true },
    });

    if (!workspace || !workspace.isActive) {
      return res.status(404).json({ success: false, message: `Workspace "${workspaceSlug}" not found or inactive` });
    }

    req.workspaceId = workspace.id;
    next();
  } catch (error) {
    logger.error('Error resolving workspace slug for webhook', { slug: workspaceSlug, error: error.message });
    return res.status(500).json({ success: false, message: 'Internal error resolving workspace' });
  }
};

// ── Workspace-scoped webhook endpoints ──────────────────────────────────

/**
 * POST /api/webhook/:workspaceSlug/ticket
 * Auto-response webhook (existing behavior)
 */
router.post(
  '/:workspaceSlug/ticket',
  authenticateWebhook,
  asyncHandler(resolveWorkspaceSlug),
  asyncHandler(handleTicketWebhook),
);

/**
 * POST /api/webhook/:workspaceSlug/assignment
 * Trigger the assignment pipeline for an incoming ticket
 */
router.post(
  '/:workspaceSlug/assignment',
  authenticateWebhook,
  asyncHandler(resolveWorkspaceSlug),
  asyncHandler(handleAssignmentWebhook),
);

/**
 * GET /api/webhook/test
 * Test endpoint to verify webhook is accessible
 */
router.get('/test', authenticateWebhook, asyncHandler(testWebhook));

export default router;
