import cron from 'node-cron';
import syncService from './syncService.js';
import syncLogRepository from './syncLogRepository.js';
import workspaceRepository from './workspaceRepository.js';
import settingsRepository from './settingsRepository.js';
import logger from '../utils/logger.js';

/**
 * Multi-workspace scheduled sync service.
 * Manages one cron job per active workspace, each with its own interval.
 */
class ScheduledSyncService {
  constructor() {
    this.cronJobs = new Map();
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
      }

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

    const job = cron.schedule(
      cronExpression,
      async () => {
        try {
          logger.info(`Scheduled sync triggered for workspace "${wsName}"`);
          await syncService.performFullSync({ workspaceId: wsId });
        } catch (error) {
          logger.error(`Scheduled sync failed for workspace "${wsName}":`, error);
        }
      },
      {
        scheduled: true,
        timezone: workspace.defaultTimezone || 'America/Los_Angeles',
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
      } catch (error) {
        logger.error(`[${wsName}] Initial sync failed:`, error);
      }
    });
  }

  stopForWorkspace(wsId) {
    const entry = this.cronJobs.get(wsId);
    if (entry) {
      logger.info(`Stopping scheduled sync for workspace "${entry.workspaceName}"`);
      entry.job.stop();
      this.cronJobs.delete(wsId);
    }
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
