import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import syncService from '../services/syncService.js';
import scheduledSyncService from '../services/scheduledSyncService.js';
import syncLogRepository from '../services/syncLogRepository.js';
import ticketRepository from '../services/ticketRepository.js';
import logger from '../utils/logger.js';
import { sseManager } from './sse.routes.js';
import { clearReadCache } from '../services/dashboardReadCache.js';

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

    const result = await scheduledSyncService.triggerManualSync(fullSync, daysToSync, req.workspaceId);
    clearReadCache();

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
    const latestSync = await syncLogRepository.getLatest(req.workspaceId);

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
 * Get sync logs with pagination, filtering, and total count
 * Query params:
 *   - limit (default 50)
 *   - offset (default 0)
 *   - status (completed | failed | started)
 *   - startDate, endDate (ISO strings)
 *   - search (free-text on error messages)
 */
router.get(
  '/logs',
  asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const { status, startDate, endDate, search } = req.query;

    const { logs, total } = await syncLogRepository.getRecent({
      limit,
      offset,
      status: status || null,
      startDate: startDate || null,
      endDate: endDate || null,
      search: search || null,
      workspaceId: req.workspaceId,
    });

    res.json({
      success: true,
      data: logs,
      pagination: { total, limit, offset, hasMore: offset + logs.length < total },
    });
  }),
);

/**
 * GET /api/sync/stats
 * Get sync statistics, gap analysis, and CSAT coverage
 */
router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const [stats, longestGap, csatPendingCount] = await Promise.all([
      syncLogRepository.getStats(null, null, req.workspaceId),
      syncLogRepository.getLongestGap(7, req.workspaceId),
      ticketRepository.getCSATPendingCount(req.workspaceId),
    ]);

    res.json({
      success: true,
      data: {
        ...stats,
        longestGap,
        csatPendingCount,
      },
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
      workspaceId: req.workspaceId,
    });

    res.json({
      success: true,
      data: result,
    });
  }),
);

/**
 * POST /api/sync/reset
 * Force-stop a stuck sync — clears the in-memory running flag and marks all
 * open sync log entries as failed.  Safe to call at any time; if no sync is
 * running it is a no-op that still returns success.
 */
router.post(
  '/reset',
  asyncHandler(async (req, res) => {
    const wasRunning = syncService.getSyncStatus().isRunning;

    // Clear in-memory running flag
    syncService.forceStop();

    // Mark any lingering 'started' sync logs as failed in the DB
    let logsResolved = 0;
    try {
      const { logs: stuckLogs } = await syncLogRepository.getRecent({ limit: 10, workspaceId: req.workspaceId });
      for (const log of stuckLogs) {
        if (log.status === 'started') {
          await syncLogRepository.failLog(log.id, 'Force stopped by user');
          logsResolved++;
        }
      }
    } catch (err) {
      logger.error('Failed to resolve stuck sync logs during reset:', err);
    }

    clearReadCache();

    logger.warn(`Sync force-reset by user (wasRunning=${wasRunning}, logsResolved=${logsResolved})`);

    res.json({
      success: true,
      data: {
        wasRunning,
        logsResolved,
        message: wasRunning
          ? `Sync stopped. ${logsResolved} log(s) marked as failed.`
          : 'No sync was running — state cleared.',
      },
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

    const result = await syncService.syncWeek({ startDate, endDate, workspaceId: req.workspaceId });
    clearReadCache();

    sseManager.broadcast('sync-completed', {
      syncType: 'week',
      result,
    }, req.workspaceId);

    res.json({
      success: true,
      data: result,
    });
  }),
);

/**
 * POST /api/sync/backfill
 * Historical backfill with live SSE progress streaming.
 * Body: { startDate, endDate, skipExisting?, activityConcurrency? }
 * Response: SSE stream with progress events, then a final JSON summary.
 */
router.post(
  '/backfill',
  asyncHandler(async (req, res) => {
    const { startDate, endDate, skipExisting = true, activityConcurrency = 3 } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, message: 'startDate and endDate are required (YYYY-MM-DD)' });
    }

    if (new Date(startDate) > new Date(endDate)) {
      return res.status(400).json({ success: false, message: 'startDate must be before endDate' });
    }

    // Set up SSE response for live progress
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('backfill-start', { startDate, endDate, workspaceId: req.workspaceId });

    logger.info(`Backfill triggered: ${startDate} to ${endDate}, workspace=${req.workspaceId}, skipExisting=${skipExisting}`);

    try {
      const result = await syncService.backfillDateRange({
        startDate,
        endDate,
        workspaceId: req.workspaceId,
        skipExisting,
        activityConcurrency,
        onProgress: (progress) => {
          send('backfill-progress', progress);
        },
      });

      clearReadCache();
      sseManager.broadcast('sync-completed', { syncType: 'backfill', result }, req.workspaceId);
      send('backfill-complete', result);
    } catch (err) {
      send('backfill-error', { message: err.message });
      logger.error('Backfill endpoint error:', err);
    } finally {
      res.end();
    }
  }),
);

/**
 * GET /api/sync/backfill/status
 * Check if a backfill is currently running for the current workspace.
 */
router.get(
  '/backfill/status',
  asyncHandler(async (req, res) => {
    const key = `backfill:${req.workspaceId}`;
    const isRunning = syncService.isRunning && syncService.runningWorkspaces?.has?.(key);

    res.json({
      success: true,
      data: { isRunning },
    });
  }),
);

export default router;
