import cron from 'node-cron';
import syncService from './syncService.js';
import vtService from './vacationTrackerService.js';
import vtRepo from './vacationTrackerRepository.js';
import syncLogRepository from './syncLogRepository.js';
import workspaceRepository from './workspaceRepository.js';
import emailPollingService from './emailPollingService.js';
import availabilityService from './availabilityService.js';
import assignmentPipelineService from './assignmentPipelineService.js';
import assignmentRepository from './assignmentRepository.js';
import logger from '../utils/logger.js';

/**
 * Multi-workspace scheduled sync service.
 * Manages one cron job per active workspace, each with its own interval.
 */
class ScheduledSyncService {
  constructor() {
    this.cronJobs = new Map();
    this.vtCronJobs = new Map();
  }

  /**
   * Start sync schedules for all active workspaces.
   */
  async start() {
    try {
      this.stopAll();

      const workspaces = await workspaceRepository.getAllActive();
      if (workspaces.length === 0) {
        logger.warn('No active workspaces found, skipping scheduled sync');
        return false;
      }

      for (const ws of workspaces) {
        await this.startForWorkspace(ws);
        await this.startVTSyncForWorkspace(ws);
      }

      // Start email polling for assignment pipeline
      await emailPollingService.startAll();

      logger.info(`Scheduled sync started for ${workspaces.length} workspace(s)`);
      return true;
    } catch (error) {
      logger.error('Failed to start scheduled sync:', error);
      return false;
    }
  }

  /**
   * Start a cron job for a single workspace.
   */
  async startForWorkspace(workspace) {
    const wsId = workspace.id;
    const wsName = workspace.name;

    this.stopForWorkspace(wsId);

    let intervalMinutes = workspace.syncIntervalMinutes || 5;
    if (intervalMinutes < 1 || intervalMinutes > 60) {
      logger.warn(`Invalid sync interval ${intervalMinutes}m for workspace ${wsName}, defaulting to 5m`);
      intervalMinutes = 5;
    }

    const cronExpression = `*/${intervalMinutes} * * * *`;

    logger.info(`Starting scheduled sync for workspace "${wsName}" (id=${wsId}) every ${intervalMinutes}m`);

    const tz = workspace.defaultTimezone || 'America/Los_Angeles';

    const job = cron.schedule(
      cronExpression,
      async () => {
        let syncSucceeded = false;
        try {
          logger.info(`Scheduled sync triggered for workspace "${wsName}"`);
          await syncService.performFullSync({ workspaceId: wsId });
          syncSucceeded = true;
        } catch (error) {
          logger.error(`Scheduled sync failed for workspace "${wsName}":`, error);
        }

        // Drain queued assignment runs if inside business hours
        try {
          if (!syncSucceeded) {
            return;
          }
          const queuedCount = await assignmentRepository.countQueuedRuns(wsId);
          if (queuedCount > 0) {
            const bh = await availabilityService.isBusinessHours(new Date(), tz, wsId);
            if (bh.isBusinessHours) {
              logger.info(`[${wsName}] Draining ${queuedCount} queued assignment run(s)`);
              await assignmentPipelineService.drainQueuedRuns(wsId, 5);
            } else {
              logger.debug(`[${wsName}] ${queuedCount} queued run(s) waiting — still outside business hours`);
            }
          }
        } catch (error) {
          logger.error(`[${wsName}] Queue drain failed:`, error);
        }
      },
      {
        scheduled: true,
        timezone: tz,
      },
    );

    this.cronJobs.set(wsId, { job, workspaceName: wsName });

    setImmediate(async () => {
      try {
        const lastSync = await syncLogRepository.getLatestSuccessful(wsId);
        if (lastSync?.completedAt) {
          const gapMs = Date.now() - new Date(lastSync.completedAt).getTime();
          const gapHours = (gapMs / 3600000).toFixed(1);

          if (gapMs > 3600000) {
            const gapDays = Math.ceil(gapMs / 86400000);
            const daysToSync = Math.min(gapDays + 7, 90);
            logger.warn(`[${wsName}] Sync gap: ${gapHours}h. Running catch-up full sync (${daysToSync} days)`);
            await syncService.performFullSync({ workspaceId: wsId, fullSync: true, daysToSync });
          } else {
            const gapMinutes = Math.round(gapMs / 60000);
            logger.info(`[${wsName}] Last sync was ${gapMinutes}m ago. Running normal incremental sync`);
            await syncService.performFullSync({ workspaceId: wsId });
          }
        } else {
          logger.info(`[${wsName}] No previous sync found. Running initial full sync`);
          await syncService.performFullSync({ workspaceId: wsId, fullSync: true, daysToSync: 30 });
        }

        const queuedCount = await assignmentRepository.countQueuedRuns(wsId);
        if (queuedCount > 0) {
          const bh = await availabilityService.isBusinessHours(new Date(), tz, wsId);
          if (bh.isBusinessHours) {
            logger.info(`[${wsName}] Draining ${queuedCount} queued assignment run(s) after initial sync`);
            await assignmentPipelineService.drainQueuedRuns(wsId, 5);
          }
        }
      } catch (error) {
        logger.error(`[${wsName}] Initial sync failed:`, error);
      }
    });
  }

  async startVTSyncForWorkspace(workspace) {
    const wsId = workspace.id;
    const wsName = workspace.name;

    this.stopVTSyncForWorkspace(wsId);

    const config = await vtRepo.getConfig(wsId);
    if (!config?.apiKey || !config?.syncEnabled) {
      return;
    }

    logger.info(`Starting VT sync for workspace "${wsName}" (id=${wsId}) every 60m`);

    const job = cron.schedule(
      '0 * * * *',
      async () => {
        const logEntry = await syncLogRepository.createLog({
          syncType: 'vacation-tracker',
          status: 'started',
          workspaceId: wsId,
        });
        try {
          logger.info(`Scheduled VT sync triggered for workspace "${wsName}"`);
          const result = await vtService.fullSync(wsId);
          await syncLogRepository.completeLog(logEntry.id, {
            ticketsSynced: result.leaveDaysCreated || 0,
            techniciansSynced: result.leavesProcessed || 0,
          });
          logger.info(`Scheduled VT sync completed for workspace "${wsName}": ${result.leaveDaysCreated} leave-days`);
        } catch (error) {
          logger.error(`Scheduled VT sync failed for workspace "${wsName}":`, error);
          await syncLogRepository.failLog(logEntry.id, error.message);
        }
      },
      {
        scheduled: true,
        timezone: workspace.defaultTimezone || 'America/Los_Angeles',
      },
    );

    this.vtCronJobs.set(wsId, { job, workspaceName: wsName });
  }

  stopVTSyncForWorkspace(wsId) {
    const entry = this.vtCronJobs.get(wsId);
    if (entry) {
      logger.info(`Stopping VT sync for workspace "${entry.workspaceName}"`);
      entry.job.stop();
      this.vtCronJobs.delete(wsId);
    }
  }

  stopForWorkspace(wsId) {
    const entry = this.cronJobs.get(wsId);
    if (entry) {
      logger.info(`Stopping scheduled sync for workspace "${entry.workspaceName}"`);
      entry.job.stop();
      this.cronJobs.delete(wsId);
    }
    this.stopVTSyncForWorkspace(wsId);
  }

  stopAll() {
    if (this.cronJobs.size > 0) {
      logger.info(`Stopping all ${this.cronJobs.size} scheduled sync(s)`);
      for (const [wsId] of this.cronJobs) {
        this.stopForWorkspace(wsId);
      }
    }
  }

  /**
   * Legacy stop() — stops all workspaces (backward compatible).
   */
  stop() {
    this.stopAll();
  }

  async restart(workspaceId = null) {
    if (workspaceId) {
      const ws = await workspaceRepository.getById(workspaceId);
      this.stopForWorkspace(workspaceId);
      await this.startForWorkspace(ws);
      await this.startVTSyncForWorkspace(ws);
    } else {
      return await this.start();
    }
  }

  getStatus() {
    const workspaces = [];
    for (const [wsId, entry] of this.cronJobs) {
      workspaces.push({
        workspaceId: wsId,
        workspaceName: entry.workspaceName,
        isScheduled: true,
      });
    }

    return {
      isScheduled: this.cronJobs.size > 0,
      workspaceCount: this.cronJobs.size,
      workspaces,
    };
  }

  async triggerManualSync(fullSync = false, daysToSync = 30, workspaceId = null) {
    const wsId = workspaceId || 1;
    logger.info(`Manual sync triggered for workspace ${wsId} (fullSync=${fullSync}, daysToSync=${daysToSync})`);
    try {
      const options = { workspaceId: wsId };
      if (fullSync) {
        options.fullSync = true;
        options.daysToSync = daysToSync;
      }
      return await syncService.performFullSync(options);
    } catch (error) {
      logger.error(`Manual sync failed for workspace ${wsId}:`, error);
      throw error;
    }
  }
}

export default new ScheduledSyncService();
