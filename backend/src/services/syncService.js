import { createFreshServiceClient } from '../integrations/freshservice.js';
import {
  transformTicket,
  transformTickets,
  transformAgents,
  mapTechnicianIds,
  analyzeTicketActivities,
} from '../integrations/freshserviceTransformer.js';
import technicianRepository from './technicianRepository.js';
import ticketRepository from './ticketRepository.js';
import ticketActivityRepository from './ticketActivityRepository.js';
import requesterRepository from './requesterRepository.js';
import settingsRepository from './settingsRepository.js';
import syncLogRepository from './syncLogRepository.js';
import logger from '../utils/logger.js';
import { getTodayRange } from '../utils/timezone.js';
import { ExternalAPIError } from '../utils/errors.js';

// Note: SSE manager will be imported lazily to avoid circular dependency
let sseManager = null;
const getSSEManager = async () => {
  if (!sseManager) {
    const module = await import('../routes/sse.routes.js');
    sseManager = module.sseManager;
  }
  return sseManager;
};

/**
 * Service for syncing data from FreshService
 */
class SyncService {
  constructor() {
    this.isRunning = false;
    this.lastSyncTime = null;
    this.currentStep = null;
    this.progress = {
      currentStep: null,
      techniciansSynced: 0,
      ticketsSynced: 0,
      requestersSynced: 0,
      totalSteps: 4,
      currentStepNumber: 0,
    };
  }

  /**
   * Initialize FreshService client from settings
   * @returns {Promise<Object>} FreshService client instance
   */
  async _initializeClient() {
    try {
      const config = await settingsRepository.getFreshServiceConfig();
      return createFreshServiceClient(config.domain, config.apiKey);
    } catch (error) {
      logger.error('Failed to initialize FreshService client:', error);
      throw new ExternalAPIError(
        'FreshService',
        'Failed to initialize API client. Check your FreshService credentials.',
        error
      );
    }
  }

  /**
   * Sync technicians from FreshService
   * @returns {Promise<number>} Number of technicians synced
   */
  async syncTechnicians() {
    try {
      this.progress.currentStep = 'Syncing technicians from FreshService';
      this.progress.currentStepNumber = 1;
      logger.info('Starting technician sync');
      const client = await this._initializeClient();
      const config = await settingsRepository.getFreshServiceConfig();

      // Fetch agents from FreshService with optional workspace filter
      const filters = {};
      if (config.workspaceId) {
        filters.workspace_id = config.workspaceId;
      }

      const fsAgents = await client.fetchAgents(filters);
      logger.info(`Fetched ${fsAgents.length} agents from FreshService`);

      // Transform agents to our format, filtering by workspace
      const transformedAgents = transformAgents(fsAgents, config.workspaceId);

      // Upsert each technician
      let syncedCount = 0;
      for (const agent of transformedAgents) {
        try {
          await technicianRepository.upsert(agent);
          syncedCount++;
        } catch (error) {
          logger.error(`Failed to upsert technician ${agent.name}:`, error);
        }
      }

      // Deactivate technicians not in the IT workspace (if workspace filtering is enabled)
      if (config.workspaceId) {
        try {
          const deactivatedCount = await technicianRepository.deactivateByWorkspace(config.workspaceId);
          if (deactivatedCount > 0) {
            logger.info(`Deactivated ${deactivatedCount} technicians not in workspace ${config.workspaceId}`);
          }
        } catch (error) {
          logger.error('Failed to deactivate non-workspace technicians:', error);
        }
      }

      this.progress.techniciansSynced = syncedCount;
      logger.info(`Synced ${syncedCount} technicians`);
      return syncedCount;
    } catch (error) {
      logger.error('Error syncing technicians:', error);
      throw error;
    }
  }

  /**
   * Sync tickets from FreshService
   * @param {Object} options - Sync options
   * @returns {Promise<number>} Number of tickets synced
   */
  async syncTickets(options = {}) {
    try {
      this.progress.currentStep = 'Syncing tickets from FreshService';
      this.progress.currentStepNumber = 2;
      logger.info('Starting ticket sync');
      const client = await this._initializeClient();
      const syncConfig = await settingsRepository.getSyncConfig();

      // Determine time range for sync
      let updatedSince;
      const daysToSync = options.daysToSync || 30; // Default to 30 days if not specified

      if (options.fullSync) {
        // Full sync: fetch historical data based on daysToSync parameter
        const historicalDate = new Date();
        historicalDate.setDate(historicalDate.getDate() - daysToSync);
        updatedSince = historicalDate;
        logger.info(`Performing full sync (last ${daysToSync} days)`);
      } else {
        // Incremental sync: fetch only tickets updated since last successful sync
        const latestSync = await syncLogRepository.getLatestSuccessful();

        if (latestSync && latestSync.completedAt) {
          // Add a 5-minute buffer to avoid missing tickets due to clock skew
          updatedSince = new Date(latestSync.completedAt.getTime() - 5 * 60 * 1000);
          logger.info(`Performing incremental sync (since ${updatedSince.toISOString()})`);
        } else {
          // No previous sync, do full sync with default date range
          const historicalDate = new Date();
          historicalDate.setDate(historicalDate.getDate() - daysToSync);
          updatedSince = historicalDate;
          logger.info(`No previous sync found, performing full sync (last ${daysToSync} days)`);
        }
      }

      // Fetch tickets updated since the determined time
      const filters = {
        updated_since: updatedSince.toISOString(),
        include: 'requester,stats', // Include requester details and time stats in the response
      };

      if (options.status) {
        filters.status = options.status;
      }

      const fsTickets = await client.fetchTickets(filters);
      logger.info(`Fetched ${fsTickets.length} tickets from FreshService`);

      // Transform tickets to our format
      const transformedTickets = transformTickets(fsTickets);

      // Get all technicians to build ID mapping
      const technicians = await technicianRepository.getAllActive();
      const fsIdToInternalId = new Map(
        technicians.map(tech => [Number(tech.freshserviceId), tech.id])
      );

      // Map FreshService responder IDs to internal technician IDs
      const ticketsWithTechIds = mapTechnicianIds(transformedTickets, fsIdToInternalId);

      // OPTIMIZATION: Batch fetch all existing tickets in one query
      const ticketIds = ticketsWithTechIds.map(t => t.freshserviceTicketId);
      const existingTicketsArray = await ticketRepository.getByFreshserviceIds(ticketIds);
      const existingTicketsMap = new Map(
        existingTicketsArray.map(t => [t.freshserviceTicketId.toString(), t])
      );
      logger.info(`Found ${existingTicketsMap.size} existing tickets out of ${ticketIds.length}`);

      // OPTIMIZATION: Skip activity analysis during full sync (too slow)
      // Analyze NEW tickets or tickets missing assignment data
      // IMPORTANT: Do this even during full sync to ensure assignedBy is populated
      const activityAnalysisMap = new Map();

      const ticketsNeedingAnalysis = ticketsWithTechIds.filter(ticket => {
        const existingTicket = existingTicketsMap.get(ticket.freshserviceTicketId.toString());
        const needsAnalysis = !existingTicket ||
          (existingTicket.assignedTechId && (!existingTicket.assignedBy || !existingTicket.firstAssignedAt));
        return needsAnalysis && ticket.assignedTechId;
      });

      logger.info(`${ticketsNeedingAnalysis.length} tickets need activity analysis`);

      // Fetch activities for tickets that need analysis (with rate limiting)
      for (const ticket of ticketsNeedingAnalysis) {
        try {
          // Add delay to avoid hitting FreshService rate limits (~1 request per second)
          await new Promise(resolve => setTimeout(resolve, 1100));

          const activities = await client.fetchTicketActivities(
            ticket.freshserviceTicketId
          );
          const analysis = analyzeTicketActivities(activities);
          activityAnalysisMap.set(ticket.freshserviceTicketId.toString(), analysis);
          logger.debug(`Ticket ${ticket.freshserviceTicketId}: isSelfPicked=${analysis.isSelfPicked}, assignedBy=${analysis.assignedBy}`);
        } catch (activityError) {
          logger.warn(
            `Failed to fetch activities for ticket ${ticket.freshserviceTicketId}:`,
            activityError
          );
        }
      }

      // OPTIMIZATION: Batch upsert tickets
      let syncedCount = 0;
      for (const ticket of ticketsWithTechIds) {
        try {
          const existingTicket = existingTicketsMap.get(ticket.freshserviceTicketId.toString());

          // Get analysis from map or use existing/default values
          let isSelfPicked = false;
          let assignedBy = null;
          let firstAssignedAt = null;

          const analysis = activityAnalysisMap.get(ticket.freshserviceTicketId.toString());
          if (analysis) {
            isSelfPicked = analysis.isSelfPicked;
            assignedBy = analysis.assignedBy;
            firstAssignedAt = analysis.firstAssignedAt;
          } else if (existingTicket) {
            isSelfPicked = existingTicket.isSelfPicked;
            assignedBy = existingTicket.assignedBy;
            firstAssignedAt = existingTicket.firstAssignedAt;
          }

          // Upsert ticket
          const upsertedTicket = await ticketRepository.upsert({
            ...ticket,
            isSelfPicked,
            assignedBy,
            firstAssignedAt,
          });

          // Create activity log if assignment changed
          if (existingTicket && existingTicket.assignedTechId !== upsertedTicket.assignedTechId) {
            await ticketActivityRepository.create({
              ticketId: upsertedTicket.id,
              activityType: 'assigned',
              performedBy: 'System',
              performedAt: new Date(),
              details: {
                fromTechId: existingTicket.assignedTechId,
                toTechId: upsertedTicket.assignedTechId,
                note: 'Ticket reassigned',
              },
            });
          }

          // Create activity log if status changed
          if (existingTicket && existingTicket.status !== upsertedTicket.status) {
            await ticketActivityRepository.create({
              ticketId: upsertedTicket.id,
              activityType: 'status_changed',
              performedBy: 'System',
              performedAt: new Date(),
              details: {
                oldStatus: existingTicket.status,
                newStatus: upsertedTicket.status,
                note: `Status changed from ${existingTicket.status} to ${upsertedTicket.status}`,
              },
            });
          }

          syncedCount++;
        } catch (error) {
          logger.error(`Failed to upsert ticket ${ticket.freshserviceTicketId}:`, error);
        }
      }

      this.progress.ticketsSynced = syncedCount;
      logger.info(`Synced ${syncedCount} tickets`);
      return syncedCount;
    } catch (error) {
      logger.error('Error syncing tickets:', error);
      throw error;
    }
  }

  /**
   * Sync requesters from FreshService
   * Fetches requester details for all tickets that don't have cached requester data
   * @returns {Promise<number>} Number of requesters synced
   */
  async syncRequesters() {
    try {
      this.progress.currentStep = 'Syncing requester details from FreshService';
      this.progress.currentStepNumber = 3;
      logger.info('Starting requester sync');
      const client = await this._initializeClient();

      // Get all requester IDs that need to be fetched
      const uncachedRequesterIds = await requesterRepository.getUncachedRequesterIds();

      let syncedCount = 0;

      // Only fetch requesters if there are uncached ones
      if (uncachedRequesterIds.length > 0) {
        logger.info(`Found ${uncachedRequesterIds.length} requesters to fetch`);

        // Convert BigInt to Number for API calls
        const requesterIdsToFetch = uncachedRequesterIds.map(id => Number(id));

        // Fetch all requesters from FreshService with rate limiting
        const fsRequesters = await client.fetchAllRequesters(requesterIdsToFetch);

        if (fsRequesters.length > 0) {
          // Upsert requesters into database
          const syncedRequesters = await requesterRepository.bulkUpsert(fsRequesters);
          syncedCount = syncedRequesters.length;
          logger.info(`Synced ${syncedCount} requesters`);
        } else {
          logger.warn('No requesters fetched from FreshService');
        }
      } else {
        logger.info('No new requesters to fetch');
      }

      // ALWAYS link tickets to requesters (even if no new ones were fetched)
      // This handles cases where requesters already exist but tickets weren't linked
      const linkedCount = await requesterRepository.linkTicketsToRequesters();
      logger.info(`Linked ${linkedCount} tickets to requesters`);

      this.progress.requestersSynced = syncedCount;
      return syncedCount;
    } catch (error) {
      logger.error('Error syncing requesters:', error);
      throw error;
    }
  }

  /**
   * Perform a full sync of both technicians and tickets
   * @returns {Promise<Object>} Sync summary
   */
  async performFullSync(options = {}) {
    // Prevent concurrent syncs
    if (this.isRunning) {
      logger.warn('Sync already in progress, skipping');
      return { status: 'skipped', reason: 'Sync already in progress' };
    }

    this.isRunning = true;
    this.progress = {
      currentStep: 'Initializing sync',
      techniciansSynced: 0,
      ticketsSynced: 0,
      requestersSynced: 0,
      totalSteps: 4,
      currentStepNumber: 0,
    };

    const syncLog = await syncLogRepository.createLog({ status: 'started' });

    try {
      logger.info('Starting full sync');

      // Sync technicians first (needed for ticket assignment mapping)
      const techniciansSynced = await this.syncTechnicians();

      // Sync tickets with options (including fullSync flag)
      const ticketsSynced = await this.syncTickets(options);

      // Sync requesters (fetch requester details for tickets)
      const requestersSynced = await this.syncRequesters();

      // Mark sync as completed
      this.progress.currentStep = 'Finalizing sync';
      this.progress.currentStepNumber = 4;

      await syncLogRepository.completeLog(syncLog.id, {
        techniciansSynced,
        ticketsSynced,
        requestersSynced,
      });

      this.lastSyncTime = new Date();
      this.isRunning = false;
      this.progress.currentStep = 'Completed';
      this.progress.currentStepNumber = 4;

      const summary = {
        status: 'completed',
        techniciansSynced,
        ticketsSynced,
        requestersSynced,
        timestamp: this.lastSyncTime,
      };

      logger.info('Full sync completed', summary);

      // Broadcast sync completion to all SSE clients
      try {
        const manager = await getSSEManager();
        if (manager) {
          manager.broadcast('sync-completed', summary);
        }
      } catch (error) {
        logger.error('Failed to broadcast SSE update:', error);
      }

      return summary;
    } catch (error) {
      logger.error('Full sync failed:', error);

      // Mark sync as failed
      await syncLogRepository.failLog(syncLog.id, error.message);

      this.isRunning = false;

      throw error;
    }
  }

  /**
   * Test FreshService connection
   * @returns {Promise<boolean>} True if connection successful
   */
  async testConnection() {
    try {
      const client = await this._initializeClient();
      return await client.testConnection();
    } catch (error) {
      logger.error('Connection test failed:', error);
      return false;
    }
  }

  /**
   * Get sync status
   * @returns {Object} Sync status
   */
  getSyncStatus() {
    return {
      isRunning: this.isRunning,
      lastSyncTime: this.lastSyncTime,
      progress: this.isRunning ? this.progress : null,
    };
  }

  /**
   * Force stop sync (emergency use only)
   */
  forceStop() {
    logger.warn('Force stopping sync');
    this.isRunning = false;
  }

  /**
   * Process a single ticket for backfill (helper function)
   * @private
   */
  async _backfillSingleTicket(client, prisma, ticket) {
    try {
      // Fetch activities for this ticket
      const activities = await client.fetchTicketActivities(
        Number(ticket.freshserviceTicketId)
      );

      // Analyze activities to get firstAssignedAt
      const analysis = analyzeTicketActivities(activities);

      if (analysis.firstAssignedAt) {
        // Update ticket with firstAssignedAt
        await prisma.ticket.update({
          where: { id: ticket.id },
          data: {
            firstAssignedAt: analysis.firstAssignedAt,
            isSelfPicked: analysis.isSelfPicked,
            assignedBy: analysis.assignedBy,
          },
        });

        logger.debug(`Updated ticket ${ticket.freshserviceTicketId} with firstAssignedAt: ${analysis.firstAssignedAt}`);
        return { success: true, ticketId: ticket.freshserviceTicketId };
      } else {
        logger.debug(`No assignment found in activities for ticket ${ticket.freshserviceTicketId}`);
        return { success: false, ticketId: ticket.freshserviceTicketId, reason: 'no_assignment' };
      }
    } catch (error) {
      const errorMsg = String(error.message || error);
      logger.warn(`Failed to backfill ticket ${ticket.freshserviceTicketId}: ${errorMsg}`);
      return { success: false, ticketId: ticket.freshserviceTicketId, error: errorMsg };
    }
  }

  /**
   * Process tickets in parallel with concurrency limit
   * @private
   */
  async _processTicketsInParallel(client, prisma, tickets, concurrency = 5) {
    const results = [];

    // Process tickets in chunks based on concurrency limit
    for (let i = 0; i < tickets.length; i += concurrency) {
      const chunk = tickets.slice(i, i + concurrency);

      // Add staggered delays to respect rate limits (200ms between starts)
      const promises = chunk.map((ticket, index) =>
        new Promise(resolve =>
          setTimeout(
            () => this._backfillSingleTicket(client, prisma, ticket).then(resolve),
            index * 200 // Stagger by 200ms
          )
        )
      );

      // Wait for this chunk to complete
      const chunkResults = await Promise.all(promises);
      results.push(...chunkResults);

      // Brief pause between chunks to avoid overwhelming the API
      if (i + concurrency < tickets.length) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }

    return results;
  }

  /**
   * Backfill pickup times for tickets missing firstAssignedAt
   * Fetches activities for assigned tickets without firstAssignedAt and updates them
   * @param {Object} options - Backfill options
   * @param {number} options.limit - Maximum number of tickets to process per batch (default: 100)
   * @param {number} options.daysToSync - Only backfill tickets created in last N days (default: 30)
   * @param {boolean} options.processAll - Process all batches until complete (default: false)
   * @param {number} options.concurrency - Number of parallel API calls (default: 5)
   * @returns {Promise<Object>} Backfill summary
   */
  async backfillPickupTimes(options = {}) {
    const limit = options.limit || 100;
    const daysToSync = options.daysToSync || 30;
    const processAll = options.processAll || false;
    const concurrency = options.concurrency || 5;

    try {
      logger.info(`Starting pickup time backfill (limit=${limit}, daysToSync=${daysToSync}, processAll=${processAll}, concurrency=${concurrency})`);
      const client = await this._initializeClient();

      // Calculate date range
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToSync);

      // Get tickets missing firstAssignedAt using raw Prisma query
      const { PrismaClient } = await import('@prisma/client');
      const prisma = new PrismaClient();

      let totalSuccessCount = 0;
      let totalFailureCount = 0;
      let totalProcessed = 0;
      let batchNumber = 1;
      let hasMore = true;

      while (hasMore) {
        const tickets = await prisma.ticket.findMany({
          where: {
            assignedTechId: { not: null },
            firstAssignedAt: null,
            createdAt: { gte: cutoffDate },
          },
          select: {
            id: true,
            freshserviceTicketId: true,
          },
          take: limit,
        });

        if (tickets.length === 0) {
          logger.info('No more tickets to backfill');
          hasMore = false;
          break;
        }

        logger.info(`Processing batch ${batchNumber}: ${tickets.length} tickets (${concurrency} parallel requests)`);

        const batchStartTime = Date.now();

        // Process tickets in parallel with concurrency limit
        const results = await this._processTicketsInParallel(client, prisma, tickets, concurrency);

        // Count successes and failures
        const batchSuccessCount = results.filter(r => r.success).length;
        const batchFailureCount = results.filter(r => !r.success).length;

        totalSuccessCount += batchSuccessCount;
        totalFailureCount += batchFailureCount;
        totalProcessed += tickets.length;

        const batchDuration = ((Date.now() - batchStartTime) / 1000).toFixed(1);
        logger.info(`Batch ${batchNumber} completed in ${batchDuration}s: ${batchSuccessCount} success, ${batchFailureCount} failures`);

        batchNumber++;

        // If not processing all, stop after first batch
        if (!processAll) {
          hasMore = false;
        }

        // If batch was smaller than limit, we've reached the end
        if (tickets.length < limit) {
          hasMore = false;
        }
      }

      await prisma.$disconnect();

      const summary = {
        ticketsProcessed: totalProcessed,
        successCount: totalSuccessCount,
        failureCount: totalFailureCount,
        batchesProcessed: batchNumber - 1,
        message: `Backfilled ${totalSuccessCount} tickets across ${batchNumber - 1} batches, ${totalFailureCount} failures`,
      };

      logger.info('Pickup time backfill completed', summary);
      return summary;
    } catch (error) {
      logger.error('Pickup time backfill failed:', error);
      throw error;
    }
  }

  /**
   * Sync a specific week with full details
   * This is a comprehensive sync that includes:
   * 1. Fetch all tickets updated/created in the week
   * 2. Fetch activities for all tickets in the week (with parallel processing)
   * 3. Analyze activities for assignment tracking
   * 4. Backfill pickup times for assigned tickets
   *
   * @param {Object} options - Sync options
   * @param {string} options.startDate - Monday of the week (YYYY-MM-DD)
   * @param {string} options.endDate - Sunday of the week (YYYY-MM-DD)
   * @param {number} options.concurrency - Number of parallel API calls (default: 5)
   * @returns {Promise<Object>} Sync result summary
   */
  async syncWeek({ startDate, endDate, concurrency = 3 }) {
    try {
      logger.info(`Starting week sync: ${startDate} to ${endDate} (concurrency: ${concurrency})`);
      const client = await this._initializeClient();
      const { PrismaClient } = await import('@prisma/client');
      const prisma = new PrismaClient();

      // Convert dates to Date objects
      const start = new Date(startDate + 'T00:00:00Z');
      const end = new Date(endDate + 'T23:59:59Z');

      let ticketsSynced = 0;
      let activitiesAnalyzed = 0;
      let pickupTimesBackfilled = 0;
      let failureCount = 0;
      const apiErrors = { rate_limit: 0, server_error: 0, other: 0 };

      // Step 1: Fetch tickets from FreshService for this week
      logger.info(`Fetching tickets updated/created between ${startDate} and ${endDate}`);

      const filters = {
        updated_since: start.toISOString(),
        include: 'requester,stats',
      };

      const allTickets = await client.fetchTickets(filters);

      // Filter to only include tickets updated within this specific week
      const tickets = allTickets.filter(ticket => {
        const updatedAt = new Date(ticket.updated_at);
        return updatedAt >= start && updatedAt <= end;
      });

      logger.info(`Found ${tickets.length} tickets in this week (filtered from ${allTickets.length} total)`);

      // Step 2: Sync tickets to database
      const syncedTicketIds = new Set();
      for (const fsTicket of tickets) {
        try {
          const transformedTicket = transformTicket(fsTicket);
          await ticketRepository.upsert(transformedTicket);
          syncedTicketIds.add(fsTicket.id); // Track successfully synced tickets
          ticketsSynced++;
        } catch (error) {
          const errorMsg = String(error.message || error);
          logger.warn(`Failed to sync ticket ${fsTicket.id}: ${errorMsg}`);
          failureCount++;
        }
      }

      // Step 3: Fetch and analyze activities for successfully synced tickets only
      const ticketsToProcess = tickets.filter(t => syncedTicketIds.has(t.id));
      logger.info(`Fetching activities for ${ticketsToProcess.length} tickets (${concurrency} parallel requests)...`);

      // Process tickets in parallel batches
      const processTicket = async (ticket, index) => {
        const delayMs = Math.floor(index / concurrency) * 1500; // 1.5s delay per batch (slower to avoid rate limits)
        await new Promise(resolve => setTimeout(resolve, delayMs));

        try {
          const activities = await client.fetchTicketActivities(Number(ticket.id));

          if (activities && activities.length > 0) {
            const analysis = analyzeTicketActivities(activities);

            // Update ticket with activity analysis results
            await prisma.ticket.update({
              where: { freshserviceTicketId: ticket.id },
              data: {
                firstAssignedAt: analysis.firstAssignedAt,
                isSelfPicked: analysis.isSelfPicked,
                assignedBy: analysis.assignedBy,
              },
            });

            if (analysis.firstAssignedAt) {
              pickupTimesBackfilled++;
            }

            return { success: true, ticketId: ticket.id };
          }

          return { success: true, ticketId: ticket.id, noActivities: true };
        } catch (error) {
          // Categorize error type
          const errorMessage = String(error.message || error);
          let errorType = 'other';

          if (errorMessage.includes('429')) {
            errorType = 'rate_limit';
            apiErrors.rate_limit++;
          } else if (errorMessage.includes('500')) {
            errorType = 'server_error';
            apiErrors.server_error++;
          } else {
            apiErrors.other++;
          }

          // Only log non-500 errors (500 errors are expected for some tickets)
          if (errorType !== 'server_error') {
            logger.warn(`Failed to fetch activities for ticket ${ticket.id}: ${errorMessage}`);
          }

          return { success: false, ticketId: ticket.id, error: errorMessage, errorType };
        }
      };

      // Process all successfully synced tickets with concurrency limit
      const results = await Promise.all(
        ticketsToProcess.map((ticket, index) => processTicket(ticket, index))
      );

      // Count successes and failures
      activitiesAnalyzed = results.filter(r => r.success && !r.noActivities).length;
      const activityFailures = results.filter(r => !r.success).length;
      failureCount += activityFailures;

      await prisma.$disconnect();

      const successCount = results.filter(r => r.success).length;
      const summary = {
        ticketsSynced,
        ticketsSkipped: tickets.length - ticketsSynced,
        activitiesAnalyzed,
        pickupTimesBackfilled,
        failureCount,
        apiErrors,
        totalProcessed: tickets.length,
        successRate: ticketsToProcess.length > 0 ? `${Math.round((successCount / ticketsToProcess.length) * 100)}%` : '100%',
        weekRange: `${startDate} to ${endDate}`,
        message: `Synced ${ticketsSynced}/${tickets.length} tickets, analyzed ${activitiesAnalyzed} activities, backfilled ${pickupTimesBackfilled} pickup times. Errors: ${apiErrors.server_error} API errors (500), ${apiErrors.rate_limit} rate limits (429), ${apiErrors.other} other`,
      };

      logger.info('Week sync completed', summary);
      return summary;

    } catch (error) {
      logger.error('Week sync failed:', error);
      throw error;
    }
  }
}

export default new SyncService();
