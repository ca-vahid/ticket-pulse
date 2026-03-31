import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();

/**
 * GET /api/notifications
 * Placeholder endpoint used by frontend polling.
 * Returns an empty notification list until notification features are implemented.
 */
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({
      success: true,
      data: [],
      unreadCount: 0,
      timestamp: new Date().toISOString(),
    });
  }),
);

export default router;

