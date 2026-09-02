import cron from 'node-cron';
import syncService from './syncService.js';
import vtService from './vacationTrackerService.js';
import vtRepo from './vacationTrackerRepository.js';
import calendarLeaveService from './calendarLeaveService.js';
import syncLogRepository from './syncLogRepository.js';
import workspaceRepository from './workspaceRepository.js';
import assignmentRepository from './assignmentRepository.js';
import assignmentDailyReviewService from './assignmentDailyReviewService.js';
import logger from '../utils/logger.js';

/**
 * Multi-workspace scheduled sync service.
 * Manages one cron job per active workspace, each with its own interval.
 */
class ScheduledSyncService {
  constructor() {
    this.cronJobs = new Map();
    this.vtCronJobs = new Map();
    this.calendarLeaveCronJobs = new Map();
    this.assignmentFastSyncCronJobs = new Map();
    this.assignmentFastSyncInProgress = new Set();
    this.embeddingBackfillCronJobs = new Map();
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
        await this.startAssignmentFastSyncForWorkspace(ws);
        await this.startVTSyncForWorkspace(ws);
        await this.startCalendarLeaveSyncForWorkspace(ws);
        this.startEmbeddingBackfillForWorkspace(ws);
      }

      // The legacy assignment-pipeline mailbox poller (emailPollingService,
      // assignment_configs.monitored_mailbox) is retired (MB-1f): inbound
      // mail is owned by mailboxIngestService (Settings → Ticket Mailboxes),
      // booted from app.js. Nothing to start here.

      this.startHolidayAutoload();
      this.startGraphSubscriptionMaintenance();
      this.startMailboxHoldDigest();

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
        try {
          logger.info(`Scheduled sync triggered for workspace "${wsName}"`);
          await syncService.performFullSync({ workspaceId: wsId });
        } catch (error) {
          logger.error(`Scheduled sync failed for workspace "${wsName}":`, error);
        }

        // NOTE: business-hours-queued assignment runs are drained by the
        // independent assignmentPipelineService queue-drain worker (started in
        // app.js), not here — so draining no longer depends on the FS sync tick.

        try {
          const reviewResult = await assignmentDailyReviewService.maybeRunScheduledReview(workspace);
          if (reviewResult.triggered) {
            logger.info(`[${wsName}] Scheduled daily review triggered`);
          }
        } catch (error) {
          logger.error(`[${wsName}] Scheduled daily review check failed:`, error);
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

        try {
          const reviewResult = await assignmentDailyReviewService.maybeRunScheduledReview(workspace);
          if (reviewResult.triggered) {
            logger.info(`[${wsName}] Scheduled daily review triggered after initial sync`);
          }
        } catch (error) {
          logger.error(`[${wsName}] Initial daily review check failed:`, error);
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

  async startAssignmentFastSyncForWorkspace(workspace) {
    const wsId = workspace.id;
    const wsName = workspace.name;
    const tz = workspace.defaultTimezone || 'America/Los_Angeles';
    const secondOffset = (wsId * 13) % 60;

    this.stopAssignmentFastSyncForWorkspace(wsId);

    logger.info(`Starting assignment fast sync for workspace "${wsName}" (id=${wsId}) every 1m at :${secondOffset.toString().padStart(2, '0')}`);

    const job = cron.schedule(
      `${secondOffset} * * * * *`,
      async () => {
        if (this.assignmentFastSyncInProgress.has(wsId)) {
          logger.debug(`[${wsName}] Assignment fast sync already in progress, skipping`);
          return;
        }

        this.assignmentFastSyncInProgress.add(wsId);
        try {
          // FR 08-07 #13: the 60s lane no longer requires assignment polling.
          // Status refresh runs for every active workspace so FS-side
          // status/assignee changes land within ~1 min everywhere; assignment
          // polling and classification stay gated by their own config checks
          // inside _pollForUnassignedTickets/_classifyAssignedTickets…
          // (isEnabled + pollForUnassigned), exactly as before.
          // Env kill-switch: FAST_STATUS_REFRESH=false restores the old gate.
          const cfg = await assignmentRepository.getConfig(wsId);
          const assignmentPollingEnabled = Boolean(cfg?.isEnabled && cfg?.pollForUnassigned);
          if (!assignmentPollingEnabled && process.env.FAST_STATUS_REFRESH === 'false') {
            return;
          }

          const result = await syncService.syncAssignmentCandidatesNow(wsId, {
            lookbackMinutes: 30,
            maxTickets: 50,
            maxPipelineRuns: cfg?.pollMaxPerCycle || 5,
          });

          if (result.polling?.triggered || result.ticketsSynced > 0) {
            logger.info(`[${wsName}] Assignment fast sync completed`, {
              ticketsFetched: result.ticketsFetched,
              ticketsSynced: result.ticketsSynced,
              candidates: result.polling?.candidates || 0,
              triggered: result.polling?.triggered || 0,
            });
          }
        } catch (error) {
          logger.error(`[${wsName}] Assignment fast sync failed:`, error);
        } finally {
          this.assignmentFastSyncInProgress.delete(wsId);
        }
      },
      {
        scheduled: true,
        timezone: tz,
      },
    );

    this.assignmentFastSyncCronJobs.set(wsId, { job, workspaceName: wsName });
  }

  async startCalendarLeaveSyncForWorkspace(workspace) {
    const wsId = workspace.id;
    const wsName = workspace.name;

    this.stopCalendarLeaveSyncForWorkspace(wsId);

    const config = await calendarLeaveService.getConfig(wsId);
    if (!config?.syncEnabled || !config?.graphGroupId) {
      return;
    }

    logger.info(`Starting shared calendar leave sync for workspace "${wsName}" (id=${wsId}) every 60m`);

    const job = cron.schedule(
      '15 * * * *',
      async () => {
        const logEntry = await syncLogRepository.createLog({
          syncType: 'calendar-leave',
          status: 'started',
          workspaceId: wsId,
        });
        try {
          logger.info(`Scheduled shared calendar leave sync triggered for workspace "${wsName}"`);
          const result = await calendarLeaveService.sync(wsId, { useLlm: true });
          await syncLogRepository.completeLog(logEntry.id, {
            ticketsSynced: result.leaveDaysCreated || 0,
            techniciansSynced: result.eventsProcessed || 0,
          });
          logger.info(`Scheduled shared calendar leave sync completed for workspace "${wsName}": ${result.leaveDaysCreated} leave-days`);
        } catch (error) {
          logger.error(`Scheduled shared calendar leave sync failed for workspace "${wsName}":`, error);
          await syncLogRepository.failLog(logEntry.id, error.message);
        }
      },
      {
        scheduled: true,
        timezone: workspace.defaultTimezone || config.timezone || 'America/Los_Angeles',
      },
    );

    this.calendarLeaveCronJobs.set(wsId, { job, workspaceName: wsName });
  }

  stopVTSyncForWorkspace(wsId) {
    const entry = this.vtCronJobs.get(wsId);
    if (entry) {
      logger.info(`Stopping VT sync for workspace "${entry.workspaceName}"`);
      entry.job.stop();
      this.vtCronJobs.delete(wsId);
    }
  }

  stopCalendarLeaveSyncForWorkspace(wsId) {
    const entry = this.calendarLeaveCronJobs.get(wsId);
    if (entry) {
      logger.info(`Stopping shared calendar leave sync for workspace "${entry.workspaceName}"`);
      entry.job.stop();
      this.calendarLeaveCronJobs.delete(wsId);
    }
  }

  /**
   * Nightly similar-tickets embedding backfill (gap plan 2 P5.2): sweeps
   * recent tickets that never got an embedding (created before the feature,
   * or whose fire-and-forget upsert was lost). Quiet no-op without an
   * OpenAI key.
   */
  startEmbeddingBackfillForWorkspace(workspace) {
    const wsId = workspace.id;
    this.stopEmbeddingBackfillForWorkspace(wsId);
    const tz = workspace.defaultTimezone || 'America/Los_Angeles';
    const job = cron.schedule('30 3 * * *', async () => {
      try {
        const { default: ticketEmbeddingService } = await import('./ticketEmbeddingService.js');
        const result = await ticketEmbeddingService.backfillWorkspace(wsId);
        if (result.embedded > 0) {
          logger.info(`[${workspace.name}] Nightly embedding backfill: ${result.embedded}/${result.scanned}`);
        }
      } catch (error) {
        logger.error(`[${workspace.name}] Embedding backfill failed:`, error);
      }
    }, { scheduled: true, timezone: tz });
    this.embeddingBackfillCronJobs.set(wsId, { job, workspaceName: workspace.name });
  }

  stopEmbeddingBackfillForWorkspace(wsId) {
    const entry = this.embeddingBackfillCronJobs.get(wsId);
    if (entry) {
      entry.job.stop();
      this.embeddingBackfillCronJobs.delete(wsId);
    }
  }

  /**
   * Yearly holiday auto-load (Phase HD4): Jan 1, 04:00 Pacific — ensures the
   * new current year AND the next one have their Canadian floating holidays
   * for every workspace with business hours, so SLA math never silently
   * treats Labour Day as a working day. One global job (not per workspace);
   * the boot-time backfill in app.js covers a server that was down on Jan 1.
   * Kill switch: HOLIDAY_AUTOLOAD=false (honored inside the service).
   */
  startHolidayAutoload() {
    this.stopHolidayAutoload();
    this.holidayAutoloadJob = cron.schedule('0 4 1 1 *', async () => {
      try {
        const { default: holidayAutoloadService } = await import('./holidayAutoloadService.js');
        await holidayAutoloadService.ensureHolidaysLoaded({ reason: 'yearly-cron' });
      } catch (error) {
        logger.error('Yearly holiday auto-load failed:', error);
      }
    }, { scheduled: true, timezone: 'America/Vancouver' });
  }

  stopHolidayAutoload() {
    if (this.holidayAutoloadJob) {
      this.holidayAutoloadJob.stop();
      this.holidayAutoloadJob = null;
    }
  }

  stopForWorkspace(wsId) {
    const entry = this.cronJobs.get(wsId);
    if (entry) {
      logger.info(`Stopping scheduled sync for workspace "${entry.workspaceName}"`);
      entry.job.stop();
      this.cronJobs.delete(wsId);
    }
    this.stopAssignmentFastSyncForWorkspace(wsId);
    this.stopVTSyncForWorkspace(wsId);
    this.stopCalendarLeaveSyncForWorkspace(wsId);
    this.stopEmbeddingBackfillForWorkspace(wsId);
  }

  stopAssignmentFastSyncForWorkspace(wsId) {
    const entry = this.assignmentFastSyncCronJobs.get(wsId);
    if (entry) {
      logger.info(`Stopping assignment fast sync for workspace "${entry.workspaceName}"`);
      entry.job.stop();
      this.assignmentFastSyncCronJobs.delete(wsId);
    }
    this.assignmentFastSyncInProgress.delete(wsId);
  }

  /**
   * Graph mail-subscription maintenance (Mega 08-31 MB-2c): every 30 min
   * renew (< 48 h left), recreate (expired/removed) or bootstrap the delta
   * cursor for each ingest mailbox. The service itself is feature-flagged
   * (GRAPH_NOTIFICATIONS_ENABLED) and no-ops when off; loaded lazily so this
   * module stays light for tests and dev boxes.
   */
  startGraphSubscriptionMaintenance() {
    this.stopGraphSubscriptionMaintenance();
    this.graphSubscriptionJob = cron.schedule('*/30 * * * *', async () => {
      try {
        const { default: graphSubscriptionService } = await import('./graphSubscriptionService.js');
        await graphSubscriptionService.ensureSubscriptions();
      } catch (error) {
        logger.warn(`Graph subscription maintenance tick failed (non-fatal): ${error.message}`);
      }
    }, { scheduled: true });
  }

  stopGraphSubscriptionMaintenance() {
    if (this.graphSubscriptionJob) {
      this.graphSubscriptionJob.stop();
      this.graphSubscriptionJob = null;
    }
  }

  /**
   * Mailbox hold-queue digest (Phase RL, RL-4): every weekday-and-weekend
   * morning at 08:00 Pacific, one email per workspace whose "Unmatched
   * replies" queue is non-empty, to that workspace's admins. Quiet no-op
   * when every queue is empty. Kill switch: MAILBOX_HOLD_DIGEST=false.
   */
  startMailboxHoldDigest() {
    this.stopMailboxHoldDigest();
    if (process.env.MAILBOX_HOLD_DIGEST === 'false') return;
    this.mailboxHoldDigestJob = cron.schedule('0 8 * * *', async () => {
      try {
        const { default: mailboxHoldService } = await import('./mailboxHoldService.js');
        const result = await mailboxHoldService.sendDailyDigests();
        if (result.sent.length) {
          logger.info(`Mailbox hold digest: ${result.sent.length} workspace digest(s) sent`);
        }
      } catch (error) {
        logger.warn(`Mailbox hold digest tick failed (non-fatal): ${error.message}`);
      }
    }, { scheduled: true, timezone: 'America/Los_Angeles' });
  }

  stopMailboxHoldDigest() {
    if (this.mailboxHoldDigestJob) {
      this.mailboxHoldDigestJob.stop();
      this.mailboxHoldDigestJob = null;
    }
  }

  stopAll() {
    this.stopHolidayAutoload();
    this.stopGraphSubscriptionMaintenance();
    this.stopMailboxHoldDigest();
    if (this.cronJobs.size > 0) {
      logger.info(`Stopping all ${this.cronJobs.size} scheduled sync(s)`);
      for (const [wsId] of this.cronJobs) {
        this.stopForWorkspace(wsId);
      }
    }
    for (const [wsId] of this.assignmentFastSyncCronJobs) {
      this.stopAssignmentFastSyncForWorkspace(wsId);
    }
    for (const [wsId] of this.vtCronJobs) {
      this.stopVTSyncForWorkspace(wsId);
    }
    for (const [wsId] of this.calendarLeaveCronJobs) {
      this.stopCalendarLeaveSyncForWorkspace(wsId);
    }
    for (const [wsId] of this.embeddingBackfillCronJobs) {
      this.stopEmbeddingBackfillForWorkspace(wsId);
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
      await this.startAssignmentFastSyncForWorkspace(ws);
      await this.startVTSyncForWorkspace(ws);
      await this.startCalendarLeaveSyncForWorkspace(ws);
      this.startEmbeddingBackfillForWorkspace(ws);
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
