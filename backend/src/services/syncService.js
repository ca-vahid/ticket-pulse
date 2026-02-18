import { createFreshServiceClient } from '../integrations/freshservice.js';
import {
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
import csatService from './csatService.js';
import logger from '../utils/logger.js';
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
        error,
      );
    }
  }

  // ========================================
  // CORE SYNC METHODS (Private - Single Source of Truth)
  // ========================================

  /**
   * Transform FreshService tickets and map to internal technician IDs
   * CRITICAL: This is the SINGLE SOURCE OF TRUTH for technician ID mapping
   *
   * @param {Array} fsTickets - Raw FreshService tickets
   * @returns {Promise<Array>} Tickets with assignedTechId populated
   * @private
   */
  async _prepareTicketsForDatabase(fsTickets) {
    if (!Array.isArray(fsTickets) || fsTickets.length === 0) {
      return [];
    }

    // Step 1: Transform tickets to our format
    const transformedTickets = transformTickets(fsTickets);
    logger.debug(`Transformed ${transformedTickets.length} tickets`);

    // Step 2: Get all active technicians to build ID mapping
    const technicians = await technicianRepository.getAllActive();
    const fsIdToInternalId = new Map(
      technicians.map(tech => [Number(tech.freshserviceId), tech.id]),
    );
    logger.debug(`Built technician ID map for ${technicians.length} technicians`);

    // Step 3: Map FreshService responder IDs to internal technician IDs
    const ticketsWithTechIds = mapTechnicianIds(transformedTickets, fsIdToInternalId);

    logger.info(`Prepared ${ticketsWithTechIds.length} tickets for database (mapped to ${technicians.length} technicians)`);
    return ticketsWithTechIds;
  }

  /**
   * Fetch and analyze ticket activities with configurable rate limiting
   *
   * @param {Object} client - FreshService API client
   * @param {Array} tickets - Raw FreshService tickets or ticket objects with id/freshserviceTicketId
   * @param {Object} options - Configuration options
   * @param {number} options.concurrency - Number of parallel requests (default: 1 for sequential)
   * @param {number} options.batchDelay - Delay in ms between batches (default: 1100)
   * @param {Function} options.ticketFilter - Filter function (ticket) => boolean
   * @param {Map} options.existingTicketsMap - Map of existing tickets to skip if they have analysis
   * @returns {Promise<Map>} Map of ticketId → { isSelfPicked, assignedBy, firstAssignedAt }
   * @private
   */
  async _analyzeTicketActivities(client, tickets, options = {}) {
    const {
      concurrency = 1,
      batchDelay = 1100,
      ticketFilter = null,
      onProgress = null,
    } = options;

    if (!Array.isArray(tickets) || tickets.length === 0) {
      return new Map();
    }

    // Filter tickets if needed
    let ticketsToAnalyze = tickets;
    if (ticketFilter) {
      ticketsToAnalyze = tickets.filter(ticketFilter);
    }

    logger.info(`Analyzing ${ticketsToAnalyze.length} tickets (concurrency: ${concurrency}, delay: ${batchDelay}ms)`);

    const analysisMap = new Map();
    let processedCount = 0;
    let errorCount = 0;
    const totalCount = ticketsToAnalyze.length;

    // Process function for a single ticket
    const processTicket = async (ticket, index) => {
      // Calculate delay based on batch (for rate limiting)
      const delayMs = Math.floor(index / concurrency) * batchDelay;
      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }

      try {
        // Extract ticket ID (handle both raw FS tickets and transformed tickets)
        const ticketId = ticket.id || ticket.freshserviceTicketId;

        // Fetch activities from FreshService
        const activities = await client.fetchTicketActivities(Number(ticketId));

        if (activities && activities.length > 0) {
          // Analyze activities to determine assignment details
          const analysis = analyzeTicketActivities(activities);
          analysisMap.set(ticketId.toString(), analysis);
          processedCount++;

          // Report progress if callback provided
          if (onProgress && processedCount % 5 === 0) {
            onProgress(processedCount, totalCount);
          }

          logger.debug(`Ticket ${ticketId}: isSelfPicked=${analysis.isSelfPicked}, assignedBy=${analysis.assignedBy}`);
        }

        return { success: true, ticketId };
      } catch (error) {
        errorCount++;
        const ticketId = ticket.id || ticket.freshserviceTicketId;

        // Report progress even on error
        if (onProgress && (processedCount + errorCount) % 5 === 0) {
          onProgress(processedCount + errorCount, totalCount);
        }

        // Only log non-500 errors (500s are expected for some tickets)
        if (!String(error).includes('500')) {
          logger.warn(`Failed to analyze ticket ${ticketId}: ${error.message || error}`);
        }

        return { success: false, ticketId, error };
      }
    };

    // Process all tickets (Promise.all handles both sequential and parallel)
    await Promise.all(
      ticketsToAnalyze.map((ticket, index) => processTicket(ticket, index)),
    );

    // Final progress report
    if (onProgress) {
      onProgress(totalCount, totalCount);
    }

    logger.info(`Activity analysis complete: ${processedCount} analyzed, ${errorCount} errors`);
    return analysisMap;
  }

  /**
   * Update tickets with activity analysis results
   *
   * @param {Map} analysisMap - Map of ticketId → { isSelfPicked, assignedBy, firstAssignedAt, firstPublicAgentReplyAt }
   * @returns {Promise<number>} Count of updated tickets
   * @private
   */
  async _updateTicketsWithAnalysis(analysisMap) {
    if (!analysisMap || analysisMap.size === 0) {
      return 0;
    }

    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    let updatedCount = 0;

    try {
      // Batch update tickets
      for (const [ticketId, analysis] of analysisMap.entries()) {
        try {
          await prisma.ticket.update({
            where: { freshserviceTicketId: BigInt(ticketId) },
            data: {
              firstAssignedAt: analysis.firstAssignedAt,
              isSelfPicked: analysis.isSelfPicked,
              assignedBy: analysis.assignedBy,
              firstPublicAgentReplyAt: analysis.firstPublicAgentReplyAt || undefined,
            },
          });
          updatedCount++;
        } catch (error) {
          logger.warn(`Failed to update ticket ${ticketId} with analysis: ${error.message || error}`);
        }
      }

      logger.info(`Updated ${updatedCount} tickets with activity analysis`);
      return updatedCount;
    } finally {
      await prisma.$disconnect();
    }
  }

  /**
   * Batch upsert tickets to database
   *
   * @param {Array} tickets - Prepared tickets (with assignedTechId)
   * @returns {Promise<number>} Count of synced tickets
   * @private
   */
  async _upsertTickets(tickets) {
    if (!Array.isArray(tickets) || tickets.length === 0) {
      return 0;
    }

    let syncedCount = 0;

    for (const ticket of tickets) {
      try {
        await ticketRepository.upsert(ticket);
        syncedCount++;
      } catch (error) {
        const ticketId = ticket.freshserviceTicketId || ticket.id;
        logger.warn(`Failed to upsert ticket ${ticketId}: ${error.message || error}`);
      }
    }

    logger.info(`Upserted ${syncedCount}/${tickets.length} tickets`);
    return syncedCount;
  }

  /**
   * Build FreshService API filters based on sync type and parameters
   *
   * @param {Object} params - Sync parameters
   * @param {string} params.syncType - 'incremental', 'full', or 'week'
   * @param {boolean} params.fullSync - Force full sync (for incremental type)
   * @param {number} params.daysToSync - Days to sync back (default: 30)
   * @param {string} params.weekStart - Week start date (YYYY-MM-DD)
   * @param {string} params.weekEnd - Week end date (YYYY-MM-DD)
   * @returns {Promise<Object>} FreshService API filters { updated_since, include }
   * @private
   */
  async _buildSyncFilters(params) {
    const {
      syncType = 'incremental',
      fullSync = false,
      daysToSync = 30,
      weekStart = null,
    } = params;

    const filters = {
      include: 'requester,stats',
    };

    if (syncType === 'week' && weekStart) {
      // Week sync: use week start date
      filters.updated_since = new Date(weekStart + 'T00:00:00Z').toISOString();
    } else if (syncType === 'full' || fullSync) {
      // Full sync: go back N days
      const historicalDate = new Date();
      historicalDate.setDate(historicalDate.getDate() - daysToSync);
      filters.updated_since = historicalDate.toISOString();
    } else {
      // Incremental sync: use last successful sync time
      const latestSync = await syncLogRepository.getLatestSuccessful();

      if (latestSync && latestSync.completedAt) {
        // Add 5-minute buffer to avoid missing tickets
        filters.updated_since = new Date(latestSync.completedAt.getTime() - 5 * 60 * 1000).toISOString();
      } else {
        // No previous sync, fallback to full sync
        const historicalDate = new Date();
        historicalDate.setDate(historicalDate.getDate() - daysToSync);
        filters.updated_since = historicalDate.toISOString();
      }
    }

    return filters;
  }

  // ========================================
  // END CORE SYNC METHODS
  // ========================================

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
   *
   * REFACTORED: Now uses core private methods for consistency and maintainability
   *
   * @param {Object} options - Sync options
   * @returns {Promise<number>} Number of tickets synced
   */
  async syncTickets(options = {}) {
    try {
      this.progress.currentStep = 'Syncing tickets from FreshService';
      this.progress.currentStepNumber = 2;
      logger.info('Starting ticket sync');
      const client = await this._initializeClient();

      // Step 1: Use _buildSyncFilters() to determine time range
      const filters = await this._buildSyncFilters({
        syncType: options.fullSync ? 'full' : 'incremental',
        fullSync: options.fullSync,
        daysToSync: options.daysToSync || 30,
      });

      if (options.status) {
        filters.status = options.status;
      }

      // Step 2: Fetch tickets from FreshService
      const fsTickets = await client.fetchTickets(filters);
      logger.info(`Fetched ${fsTickets.length} tickets from FreshService`);

      // Step 3: Use _prepareTicketsForDatabase() for transform + mapping
      const ticketsWithTechIds = await this._prepareTicketsForDatabase(fsTickets);

      // Step 4: OPTIMIZATION - Batch fetch existing tickets in one query
      const ticketIds = ticketsWithTechIds.map(t => t.freshserviceTicketId);
      const existingTicketsArray = await ticketRepository.getByFreshserviceIds(ticketIds);
      const existingTicketsMap = new Map(
        existingTicketsArray.map(t => [t.freshserviceTicketId.toString(), t]),
      );
      logger.info(`Found ${existingTicketsMap.size} existing tickets out of ${ticketIds.length}`);

      // Step 5: Use _analyzeTicketActivities() with selective filter
      // Only analyze NEW tickets or tickets missing assignment data
      const ticketFilter = (fsTicket) => {
        const existingTicket = existingTicketsMap.get(fsTicket.id.toString());
        const hasAssignedTech = fsTicket.responder_id !== null && fsTicket.responder_id !== undefined;
        const needsAnalysis = !existingTicket ||
          (hasAssignedTech && (!existingTicket.assignedBy || !existingTicket.firstAssignedAt));
        return needsAnalysis && hasAssignedTech;
      };

      const activityAnalysisMap = await this._analyzeTicketActivities(client, fsTickets, {
        concurrency: 1,
        batchDelay: 1100,
        ticketFilter,
      });

      logger.info(`Analyzed ${activityAnalysisMap.size} tickets for activity data`);

      // Step 6: Upsert tickets with merge logic and activity logging
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
      csatSynced: 0,
      totalSteps: 5,
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

      // Sync CSAT responses for recent closed tickets
      let csatSynced = 0;
      try {
        this.progress.currentStep = 'Syncing CSAT responses';
        this.progress.currentStepNumber = 4;
        const csatResults = await this.syncRecentCSAT(30); // Last 30 days
        csatSynced = csatResults.csatFound;
        this.progress.csatSynced = csatSynced;
      } catch (error) {
        logger.error('CSAT sync failed (non-fatal):', error);
        // Continue even if CSAT sync fails
      }

      // Mark sync as completed
      this.progress.currentStep = 'Finalizing sync';
      this.progress.currentStepNumber = 5;

      await syncLogRepository.completeLog(syncLog.id, {
        techniciansSynced,
        ticketsSynced,
        requestersSynced,
        csatSynced,
      });

      this.lastSyncTime = new Date();
      this.isRunning = false;
      this.progress.currentStep = 'Completed';
      this.progress.currentStepNumber = 5;

      const summary = {
        status: 'completed',
        techniciansSynced,
        ticketsSynced,
        requestersSynced,
        csatSynced,
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
        Number(ticket.freshserviceTicketId),
      );

      // Analyze activities to get firstAssignedAt
      const analysis = analyzeTicketActivities(activities);

      if (analysis.firstAssignedAt || analysis.firstPublicAgentReplyAt) {
        // Update ticket with activity-derived timestamps
        await prisma.ticket.update({
          where: { id: ticket.id },
          data: {
            firstAssignedAt: analysis.firstAssignedAt || undefined,
            isSelfPicked: analysis.isSelfPicked,
            assignedBy: analysis.assignedBy,
            firstPublicAgentReplyAt: analysis.firstPublicAgentReplyAt || undefined,
          },
        });

        logger.debug(`Updated ticket ${ticket.freshserviceTicketId} with activity timestamps`, {
          firstAssignedAt: analysis.firstAssignedAt,
          firstPublicAgentReplyAt: analysis.firstPublicAgentReplyAt,
        });
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
            index * 200, // Stagger by 200ms
          ),
        ),
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
   * REFACTORED: Now uses core private methods for consistency and maintainability
   *
   * @param {Object} options - Sync options
   * @param {string} options.startDate - Monday of the week (YYYY-MM-DD)
   * @param {string} options.endDate - Sunday of the week (YYYY-MM-DD)
   * @param {number} options.concurrency - Number of parallel API calls (default: 10 for 10x speedup with retry logic)
   * @returns {Promise<Object>} Sync result summary
   */
  async syncWeek({ startDate, endDate, concurrency = 10 }) {
    try {
      // Initialize progress tracking
      this.isRunning = true;
      this.progress = {
        currentStep: 'Initializing week sync',
        currentStepNumber: 1,
        totalSteps: 5,
        ticketsToProcess: 0,
        ticketsProcessed: 0,
        percentage: 0,
      };

      logger.info(`Starting week sync: ${startDate} to ${endDate} (concurrency: ${concurrency})`);
      const client = await this._initializeClient();

      // Convert dates to Date objects
      const start = new Date(startDate + 'T00:00:00Z');
      const end = new Date(endDate + 'T23:59:59Z');

      // Step 1: Fetch tickets from FreshService for this week
      this.progress.currentStep = 'Fetching tickets from FreshService';
      this.progress.currentStepNumber = 1;
      this.progress.percentage = 5; // Show some progress immediately
      logger.info(`Fetching tickets updated/created between ${startDate} and ${endDate}`);

      const filters = {
        updated_since: start.toISOString(),
        include: 'requester,stats',
      };

      // Fetch tickets with progress callback to update UI in real-time
      const allTickets = await client.fetchTickets(filters, (page, itemCount) => {
        // Update progress with page and item count (updates every 10 pages)
        this.progress.currentStep = `Fetching tickets from FreshService (${itemCount} items, page ${page})`;
        // Progress from 5% to 20% based on estimated 80 pages max
        this.progress.percentage = Math.min(5 + Math.floor((page / 80) * 15), 20);
      });

      // Filter to only include tickets updated within this specific week
      const tickets = allTickets.filter(ticket => {
        const updatedAt = new Date(ticket.updated_at);
        return updatedAt >= start && updatedAt <= end;
      });

      logger.info(`Found ${tickets.length} tickets in this week (filtered from ${allTickets.length} total)`);

      // Update progress with total count
      this.progress.ticketsToProcess = tickets.length;

      // Step 2: Transform tickets and map technician IDs using core method
      this.progress.currentStep = 'Preparing tickets for database';
      this.progress.currentStepNumber = 2;
      this.progress.percentage = 20;
      const preparedTickets = await this._prepareTicketsForDatabase(tickets);

      // Step 3: Upsert tickets using core method
      this.progress.currentStep = 'Saving tickets to database';
      this.progress.currentStepNumber = 3;
      this.progress.percentage = 30;
      const ticketsSynced = await this._upsertTickets(preparedTickets);
      const ticketsSkipped = tickets.length - ticketsSynced;

      // Step 4: Analyze activities using core method
      this.progress.currentStep = `Analyzing ticket activities (0/${tickets.length})`;
      this.progress.currentStepNumber = 4;
      this.progress.percentage = 40;
      this.progress.ticketsProcessed = 0;

      const analysisMap = await this._analyzeTicketActivities(client, tickets, {
        concurrency,
        batchDelay: 3000, // 3s delay per batch (10 concurrent = 3.3 req/sec avg, safer with retry logic)
        onProgress: (processed, total) => {
          this.progress.ticketsProcessed = processed;
          this.progress.currentStep = `Analyzing ticket activities (${processed}/${total})`;
          // Progress from 40% to 90% during analysis (the longest step)
          this.progress.percentage = 40 + Math.floor((processed / total) * 50);
        },
      });

      // Step 5: Update tickets with analysis results using core method
      this.progress.currentStep = 'Finalizing sync and updating database';
      this.progress.currentStepNumber = 5;
      this.progress.percentage = 90;
      await this._updateTicketsWithAnalysis(analysisMap);

      // Count pickup times backfilled (tickets that had firstAssignedAt set)
      let pickupTimesBackfilled = 0;
      for (const analysis of analysisMap.values()) {
        if (analysis.firstAssignedAt) {
          pickupTimesBackfilled++;
        }
      }

      const summary = {
        ticketsSynced,
        ticketsSkipped,
        activitiesAnalyzed: analysisMap.size,
        pickupTimesBackfilled,
        totalProcessed: tickets.length,
        successRate: tickets.length > 0 ? `${Math.round((ticketsSynced / tickets.length) * 100)}%` : '100%',
        weekRange: `${startDate} to ${endDate}`,
        message: `Synced ${ticketsSynced}/${tickets.length} tickets, analyzed ${analysisMap.size} activities, backfilled ${pickupTimesBackfilled} pickup times`,
      };

      // Mark as complete
      this.progress.currentStep = 'Completed';
      this.progress.percentage = 100;
      this.isRunning = false;

      logger.info('Week sync completed', summary);
      return summary;

    } catch (error) {
      this.isRunning = false;
      logger.error('Week sync failed:', error);
      throw error;
    }
  }

  /**
   * Sync CSAT responses for recently closed tickets
   * @param {number} daysBack - Number of days to look back (default 30)
   * @returns {Promise<Object>} Summary of CSAT sync results
   */
  async syncRecentCSAT(daysBack = 30) {
    try {
      const client = await this._initializeClient();
      return await csatService.syncRecentCSAT(
        client,
        ticketRepository,
        daysBack,
        (current, total, found) => {
          this.progress.currentStep = `Syncing CSAT responses (${current}/${total}, found ${found})`;
        },
      );
    } catch (error) {
      logger.error('Error syncing recent CSAT:', error);
      throw error;
    }
  }
}

export default new SyncService();
