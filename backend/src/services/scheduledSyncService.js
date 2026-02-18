import cron from 'node-cron';
import syncService from './syncService.js';
import settingsRepository from './settingsRepository.js';
import logger from '../utils/logger.js';

/**
 * Service for scheduling automatic syncs
 */
class ScheduledSyncService {
  constructor() {
    this.cronJob = null;
    this.isScheduled = false;
  }

  /**
   * Start scheduled sync
   * @param {number} intervalMinutes - Interval in minutes (optional, uses settings if not provided)
   * @returns {Promise<boolean>} True if started successfully
   */
  async start(intervalMinutes = null) {
    try {
      // Stop existing schedule if any
      this.stop();

      // Get interval from settings if not provided
      if (!intervalMinutes) {
        const syncConfig = await settingsRepository.getSyncConfig();
        intervalMinutes = syncConfig.intervalMinutes;
      }

      // Validate interval
      if (intervalMinutes < 1 || intervalMinutes > 60) {
        logger.warn(`Invalid sync interval ${intervalMinutes}m, defaulting to 5m`);
        intervalMinutes = 5;
      }

      // Create cron expression
      // For intervals under 60 minutes, use */N * * * * pattern
      const cronExpression = `*/${intervalMinutes} * * * *`;

      logger.info(`Starting scheduled sync with ${intervalMinutes} minute interval`);

      // Create and start cron job
      this.cronJob = cron.schedule(
        cronExpression,
        async () => {
          try {
            logger.info('Scheduled sync triggered');
            await syncService.performFullSync();
          } catch (error) {
            logger.error('Scheduled sync failed:', error);
          }
        },
        {
          scheduled: true,
          timezone: 'America/Los_Angeles', // Use consistent timezone
        },
      );

      this.isScheduled = true;
      logger.info('Scheduled sync started successfully');

      // Perform initial sync immediately
      logger.info('Performing initial sync');
      setImmediate(async () => {
        try {
          await syncService.performFullSync();
        } catch (error) {
          logger.error('Initial sync failed:', error);
        }
      });

      return true;
    } catch (error) {
      logger.error('Failed to start scheduled sync:', error);
      return false;
    }
  }

  /**
   * Stop scheduled sync
   */
  stop() {
    if (this.cronJob) {
      logger.info('Stopping scheduled sync');
      this.cronJob.stop();
      this.cronJob = null;
      this.isScheduled = false;
    }
  }

  /**
   * Restart scheduled sync with new interval
   * @param {number} intervalMinutes - New interval in minutes
   * @returns {Promise<boolean>} True if restarted successfully
   */
  async restart(intervalMinutes = null) {
    logger.info('Restarting scheduled sync');
    this.stop();
    return await this.start(intervalMinutes);
  }

  /**
   * Get schedule status
   * @returns {Object} Schedule status
   */
  getStatus() {
    return {
      isScheduled: this.isScheduled,
      hasActiveCronJob: this.cronJob !== null,
    };
  }

  /**
   * Trigger manual sync
   * @param {boolean} fullSync - Whether to perform a full sync
   * @param {number} daysToSync - Number of days to sync (default: 30)
   * @returns {Promise<Object>} Sync result
   */
  async triggerManualSync(fullSync = false, daysToSync = 30) {
    logger.info(`Manual sync triggered (fullSync=${fullSync}, daysToSync=${daysToSync})`);
    try {
      if (fullSync) {
        // Force full sync by passing options with daysToSync
        return await syncService.performFullSync({ fullSync: true, daysToSync });
      } else {
        // Normal incremental sync
        return await syncService.performFullSync();
      }
    } catch (error) {
      logger.error('Manual sync failed:', error);
      throw error;
    }
  }
}

export default new ScheduledSyncService();
