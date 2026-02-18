import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import syncService from '../services/syncService.js';
import scheduledSyncService from '../services/scheduledSyncService.js';
import syncLogRepository from '../services/syncLogRepository.js';
import logger from '../utils/logger.js';
import { sseManager } from './sse.routes.js';

const router = express.Router();

// Protect all sync routes with authentication
router.use(requireAuth);

/**
 * POST /api/sync/trigger
 * Trigger manual sync (incremental by default)
 * Query params:
 *   - fullSync=true: Force full sync
 *   - daysToSync=90: Number of days to sync (default: 30)
 */
router.post(
  '/trigger',
  asyncHandler(async (req, res) => {
    const fullSync = req.query.fullSync === 'true';
    const daysToSync = parseInt(req.query.daysToSync, 10) || 30;

    if (fullSync) {
      logger.info(`Manual FULL sync triggered via API (last ${daysToSync} days)`);
    } else {
      logger.info('Manual incremental sync triggered via API');
    }

    const result = await scheduledSyncService.triggerManualSync(fullSync, daysToSync);

    res.json({
      success: true,
      data: result,
    });
  }),
);

/**
 * GET /api/sync/status
 * Get sync status
 */
router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const syncStatus = syncService.getSyncStatus();
    const scheduleStatus = scheduledSyncService.getStatus();
    const latestSync = await syncLogRepository.getLatest();

    res.json({
      success: true,
      data: {
        sync: syncStatus,
        schedule: scheduleStatus,
        latestSync,
      },
    });
  }),
);

/**
 * GET /api/sync/logs
 * Get sync logs
 */
router.get(
  '/logs',
  asyncHandler(async (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 20;
    const logs = await syncLogRepository.getRecent(limit);

    res.json({
      success: true,
      data: logs,
    });
  }),
);

/**
 * GET /api/sync/stats
 * Get sync statistics
 */
router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const stats = await syncLogRepository.getStats();

    res.json({
      success: true,
      data: stats,
    });
  }),
);

/**
 * POST /api/sync/start-schedule
 * Start scheduled sync
 */
router.post(
  '/start-schedule',
  asyncHandler(async (req, res) => {
    logger.info('Starting scheduled sync via API');

    const started = await scheduledSyncService.start();

    res.json({
      success: true,
      message: started ? 'Scheduled sync started' : 'Failed to start scheduled sync',
    });
  }),
);

/**
 * POST /api/sync/stop-schedule
 * Stop scheduled sync
 */
router.post(
  '/stop-schedule',
  asyncHandler(async (req, res) => {
    logger.info('Stopping scheduled sync via API');

    scheduledSyncService.stop();

    res.json({
      success: true,
      message: 'Scheduled sync stopped',
    });
  }),
);

/**
 * POST /api/sync/backfill-pickup-times
 * Backfill pickup times for tickets missing firstAssignedAt
 * This fetches activities for assigned tickets without pickup times
 * Query params:
 *   - limit=100: Max tickets per batch (default: 100)
 *   - daysToSync=30: Only backfill tickets from last N days (default: 30)
 *   - processAll=true: Process all batches until complete (default: false)
 *   - concurrency=5: Number of parallel API calls (default: 5)
 */
router.post(
  '/backfill-pickup-times',
  asyncHandler(async (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 100;
    const daysToSync = parseInt(req.query.daysToSync, 10) || 30;
    const processAll = req.query.processAll === 'true';
    const concurrency = parseInt(req.query.concurrency, 10) || 5;

    logger.info(`Manual pickup time backfill triggered via API (limit=${limit}, daysToSync=${daysToSync}, processAll=${processAll}, concurrency=${concurrency})`);

    const result = await syncService.backfillPickupTimes({
      limit,
      daysToSync,
      processAll,
      concurrency,
    });

    res.json({
      success: true,
      data: result,
    });
  }),
);

/**
 * POST /api/sync/week
 * Sync a specific week with full details (tickets + activities + pickup times)
 * Body params:
 *   - startDate: Monday of the week (YYYY-MM-DD)
 *   - endDate: Sunday of the week (YYYY-MM-DD)
 */
router.post(
  '/week',
  asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'Both startDate and endDate are required',
      });
    }

    logger.info(`Week sync triggered via API (${startDate} to ${endDate})`);

    const result = await syncService.syncWeek({ startDate, endDate });

    // Broadcast sync completion to all SSE clients
    sseManager.broadcast('sync-completed', {
      syncType: 'week',
      result,
    });

    res.json({
      success: true,
      data: result,
    });
  }),
);

export default router;
