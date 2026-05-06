import { createFreshServiceClient, FORBIDDEN_TICKET } from '../integrations/freshservice.js';
import {
  transformTickets,
  transformAgents,
  mapTechnicianIds,
  analyzeTicketActivities,
  transformTicketThreadEntries,
  transformTicketConversationEntries,
} from '../integrations/freshserviceTransformer.js';
import { formatInTimeZone } from 'date-fns-tz';
import { runJobsInPool } from '../utils/parallelPool.js';
import technicianRepository from './technicianRepository.js';
import ticketRepository from './ticketRepository.js';
import ticketActivityRepository from './ticketActivityRepository.js';
import requesterRepository from './requesterRepository.js';
import ticketThreadRepository from './ticketThreadRepository.js';
import settingsRepository from './settingsRepository.js';
import syncLogRepository from './syncLogRepository.js';
import csatService from './csatService.js';
import noiseRuleService from './noiseRuleService.js';
import assignmentRepository from './assignmentRepository.js';
import assignmentPipelineService from './assignmentPipelineService.js';
import freshServiceActionService from './freshServiceActionService.js';
import { shouldTriggerAssignmentForLatestRun } from './assignmentFlowGuards.js';
import { getActivityRefreshReason } from './activitySyncFreshness.js';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { clearReadCache } from './dashboardReadCache.js';
import { ExternalAPIError } from '../utils/errors.js';

// Cap how much thread-preheat work runs per scheduled sync cycle so we keep
// budget headroom on the shared FS rate limiter (110/min). At ~24% already
// used by CSAT (see csat sync below), this leaves ~80 req/min available.
// 60 tickets x ~2 endpoints = ~120 requests = well inside the headroom and
// drains a typical day's backlog over 1-2 cycles.
const MAX_PREHEAT_TICKETS_PER_CYCLE = 60;
// Match the cap the daily review applies — keeps preheated and on-demand
// hydration consistent in shape, and bounds the conversation pagination
// for very long-running tickets.
const PREHEAT_MAX_CONVERSATIONS_PER_TICKET = 30;
// Worker-pool size for parallel FS calls during preheat. The shared rate
// limiter (maxConcurrent: 3) is the real cap; oversizing the pool just lets
// workers refill the limiter's queue without idle gaps.
const PREHEAT_POOL_SIZE = 8;
const NOISE_RULE_TRIGGER_SOURCE = 'noise_rule';
const ACTIONABLE_TICKET_STATUSES = new Set(['Open', 'Pending']);

function formatNoiseCategory(category) {
  if (!category) return null;
  return String(category)
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

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
    this.runningWorkspaces = new Set();
    this.lastSyncTime = null;
    this.currentStep = null;
    this.progressByWorkspace = new Map();
    this._embeddedRequesterNames = new Map();
    this.progress = {
      currentStep: null,
      techniciansSynced: 0,
      ticketsSynced: 0,
      requestersSynced: 0,
      totalSteps: 4,
      currentStepNumber: 0,
    };
  }

  get isRunning() {
    return this.runningWorkspaces.size > 0;
  }

  /**
   * Initialize FreshService client from settings
   * @returns {Promise<Object>} FreshService client instance
   */
  async _initializeClient(options = {}) {
    try {
      const config = await settingsRepository.getFreshServiceConfig();
      return createFreshServiceClient(config.domain, config.apiKey, options);
    } catch (error) {
      logger.error('Failed to initialize FreshService client:', error);
      throw new ExternalAPIError(
        'FreshService',
        'Failed to initialize API client. Check your FreshService credentials.',
        error,
      );
    }
  }

  /**
   * Get current rate limiter stats + FS headers from a single probe call.
   * Used by the /rate-limit-stats diagnostics endpoint.
   */
  async getRateLimitInfo() {
    try {
      const client = await this._initializeClient();
      return await client.getRateLimitInfo();
    } catch (error) {
      logger.error('Failed to fetch rate limit info:', error);
      return null;
    }
  }

  /**
   * Get the FreshService workspace ID for a given internal workspace ID.
   * Falls back to global settings if workspaceId is not provided.
   */
  async _getWorkspaceConfig(workspaceId) {
    if (workspaceId) {
      return settingsRepository.getFreshServiceConfigForWorkspace(workspaceId);
    }
    const config = await settingsRepository.getFreshServiceConfig();
    return { ...config, defaultTimezone: 'America/Los_Angeles', syncIntervalMinutes: 5 };
  }

  // ========================================
  // EPISODE RECONCILIATION
  // ========================================

  /**
   * Reconcile assignment episodes from FS activity analysis into DB.
   * Inserts new episodes and closes stale open ones.
   */
  async _reconcileEpisodes(ticketId, workspaceId, analysis, techNameMap) {
    try {
      const existingEpisodes = await prisma.ticketAssignmentEpisode.findMany({
        where: { ticketId },
        orderBy: { startedAt: 'asc' },
      });
      const existingSet = new Set(existingEpisodes.map((e) => e.startedAt.getTime()));

      for (const ep of analysis.episodes) {
        const techId = techNameMap.get(ep.agentName);
        if (!techId) {
          logger.debug(`Episode skip: tech "${ep.agentName}" not found in map for ticket ${ticketId}`);
          continue;
        }

        const startMs = new Date(ep.startedAt).getTime();
        if (existingSet.has(startMs)) {
          // Update existing episode end state if it changed
          const existing = existingEpisodes.find((e) => e.startedAt.getTime() === startMs);
          if (existing && existing.endMethod !== ep.endMethod) {
            await prisma.ticketAssignmentEpisode.update({
              where: { id: existing.id },
              data: {
                endedAt: ep.endedAt ? new Date(ep.endedAt) : null,
                endMethod: ep.endMethod || null,
                endActorName: ep.endActorName || null,
              },
            });
          }
          continue;
        }

        await prisma.ticketAssignmentEpisode.create({
          data: {
            ticketId,
            technicianId: techId,
            workspaceId,
            startedAt: new Date(ep.startedAt),
            endedAt: ep.endedAt ? new Date(ep.endedAt) : null,
            startMethod: ep.startMethod || 'unknown',
            startAssignedByName: ep.startAssignedByName || null,
            endMethod: ep.endMethod || null,
            endActorName: ep.endActorName || null,
          },
        });
      }
    } catch (error) {
      logger.error(`Failed to reconcile episodes for ticket ${ticketId}:`, error);
    }
  }

  /**
   * Resolve an FS responder ID to our internal technician ID. If the agent
   * isn't in our DB at all (e.g. contractor, agent from a different
   * workspace, or never-synced), fetch them from FS and insert as an
   * inactive tech so future assignments resolve cleanly without manual
   * intervention. Returns { techId, tech } or null if resolution failed.
   */
  async _resolveResponderTech(fsResponderId, workspaceId, client = null) {
    if (!fsResponderId) return null;
    const fsIdBig = BigInt(fsResponderId);

    // First: look in our DB. We deliberately accept inactive techs here —
    // a deactivated agent is still the responder for tickets assigned to
    // them, and we want the assignment tracked. Prefer the matching
    // workspace if present, otherwise fall back to any workspace match.
    let tech = await prisma.technician.findFirst({
      where: { freshserviceId: fsIdBig, workspaceId },
      select: { id: true, name: true, workspaceId: true, isActive: true },
    });
    if (!tech) {
      tech = await prisma.technician.findFirst({
        where: { freshserviceId: fsIdBig },
        select: { id: true, name: true, workspaceId: true, isActive: true },
      });
    }
    if (tech) return { techId: tech.id, tech };

    // Not in DB: fetch from FS and upsert as inactive. This closes the gap
    // where a ticket is assigned to an agent that our system doesn't
    // track (e.g. external contractor, agent in a different group).
    try {
      const fsClient = client || await this._initializeClient();
      const fsAgent = await fsClient.fetchAgent(Number(fsResponderId));
      if (!fsAgent) return null;
      const firstName = fsAgent.first_name || '';
      const lastName = fsAgent.last_name || '';
      const name = `${firstName} ${lastName}`.trim() || fsAgent.email || `FS Agent ${fsResponderId}`;
      const created = await prisma.technician.create({
        data: {
          freshserviceId: fsIdBig,
          name,
          email: fsAgent.email || null,
          isActive: false, // Inactive by default — don't affect load counts / recs
          workspaceId,
        },
        select: { id: true, name: true, workspaceId: true, isActive: true },
      });
      logger.info('Auto-upserted untracked FS agent for assignment resolution', {
        fsAgentId: fsResponderId, name, workspaceId, techId: created.id,
      });
      return { techId: created.id, tech: created };
    } catch (error) {
      // Composite unique constraint collision can happen if a parallel sync
      // inserted them first — re-fetch.
      if (error.code === 'P2002') {
        const retry = await prisma.technician.findFirst({
          where: { freshserviceId: fsIdBig },
          select: { id: true, name: true, workspaceId: true, isActive: true },
        });
        if (retry) return { techId: retry.id, tech: retry };
      }
      logger.warn('Failed to resolve unknown FS responder', {
        fsAgentId: fsResponderId, workspaceId, error: error.message,
      });
      return null;
    }
  }

  /**
   * Bounce-detection: a ticket transitioned from assigned to unassigned and is
   * still active (Open / Pending). Create a fresh pipeline run with rebound
   * context so the coordinator sees it surface again with full history.
   *
   * Guards:
   *  - Skip if there's already an open (queued/running) run for this ticket
   *  - Skip if assignment pipeline isn't enabled for the workspace
   *  - Skip after MAX_AUTO_REBOUNDS_PER_TICKET to avoid infinite loops
   */
  async _handleTicketRebound(upsertedTicket, existingTicket, analysis, workspaceId) {
    const MAX_AUTO_REBOUNDS_PER_TICKET = 3;
    try {
      // Skip if assignment pipeline isn't enabled
      const { default: assignmentRepository } = await import('./assignmentRepository.js');
      const cfg = await assignmentRepository.getConfig(workspaceId);
      if (!cfg?.isEnabled) return;

      // Skip if there's already an in-flight (queued/running) pipeline run.
      // We deliberately do NOT skip on existing pending_review runs — those
      // get superseded below, because the rebound is a NEW state that
      // invalidates the prior recommendation (the prior pick was likely the
      // agent who just rejected the ticket).
      const openRun = await assignmentRepository.getOpenPipelineRun(upsertedTicket.id);
      if (openRun) {
        logger.debug('Bounce detection: in-flight run already exists, skipping', {
          ticketId: upsertedTicket.id, existingRunId: openRun.id, status: openRun.status,
        });
        return;
      }

      // Loop guard: count prior auto-rebound runs for this ticket
      const reboundCount = await prisma.assignmentPipelineRun.count({
        where: { ticketId: upsertedTicket.id, triggerSource: 'rebound' },
      });
      if (reboundCount >= MAX_AUTO_REBOUNDS_PER_TICKET) {
        // Previously this just logged and returned, leaving the ticket in
        // limbo with no UI surface. Now we materialize a pending_review run
        // tagged 'rebound_exhausted' so it appears in Awaiting Decision with
        // a clear "needs manual handling" message and full rebound context.
        logger.warn('Bounce detection: max auto-rebounds reached, materializing pending_review run', {
          ticketId: upsertedTicket.id, reboundCount,
        });

        // Capture the previous-assignee snapshot from the analyzer's view
        // (mirrors the same logic used below for normal rebounds, just
        // inlined here because we exit before reaching that block).
        let prevTechName = null;
        let unassignedAt = null;
        let unassignedByName = null;
        const lastEpisode = analysis?.currentEpisode;
        if (lastEpisode && lastEpisode.endMethod === 'rejected') {
          prevTechName = lastEpisode.agentName || null;
          unassignedAt = lastEpisode.endedAt;
          unassignedByName = lastEpisode.endActorName || null;
        }
        if ((!unassignedAt || !unassignedByName) && analysis?.events?.length) {
          const lastReject = [...analysis.events].reverse().find((e) => e.type === 'rejected');
          if (lastReject) {
            unassignedAt = unassignedAt || lastReject.timestamp;
            unassignedByName = unassignedByName || lastReject.actorName;
          }
        }

        try {
          await prisma.assignmentPipelineRun.create({
            data: {
              ticketId: upsertedTicket.id,
              workspaceId,
              status: 'completed',
              decision: 'pending_review',
              triggerSource: 'rebound_exhausted',
              errorMessage: `Auto-fallback exhausted after ${reboundCount} rebound${reboundCount === 1 ? '' : 's'} — needs manual review`,
              reboundFrom: {
                previousTechId: null,
                previousTechName: prevTechName || 'Unknown',
                unassignedAt: unassignedAt ? new Date(unassignedAt).toISOString() : null,
                unassignedByName: unassignedByName || null,
                reboundCount: reboundCount + 1,
              },
              // Synthesized empty recommendation so the Awaiting Decision UI
              // renders this as a "no candidates left to try" run rather than
              // crashing on null fields.
              recommendation: {
                recommendations: [],
                overallReasoning: `Auto-fallback exhausted: this ticket has been rejected by ${reboundCount} successive auto-assigned technician${reboundCount === 1 ? '' : 's'}. No further automatic re-routing will happen — please assign manually or dismiss.`,
                ticketClassification: 'needs_manual_review',
                confidence: 'low',
              },
            },
          });
        } catch (err) {
          logger.error('Bounce detection: failed to materialize rebound_exhausted run', {
            ticketId: upsertedTicket.id, error: err.message,
          });
        }
        return;
      }

      // Supersede any existing pending_review runs. Their recommendation is
      // now stale (likely names the agent who just rejected) and the user
      // should only see the rebound run going forward — otherwise the ticket
      // shows up multiple times in the Awaiting Decision queue.
      const superseded = await prisma.assignmentPipelineRun.updateMany({
        where: {
          ticketId: upsertedTicket.id,
          status: 'completed',
          decision: 'pending_review',
        },
        data: {
          status: 'superseded',
          errorMessage: 'Superseded by a newer rebound run after ticket was returned to the queue',
          updatedAt: new Date(),
        },
      });
      if (superseded.count > 0) {
        logger.info('Bounce detection: superseded prior pending_review runs', {
          ticketId: upsertedTicket.id, count: superseded.count,
        });
      }

      // Identify the previous assignee. Prefer the analyzer's source-of-truth
      // (latest closed episode) over the DB snapshot, because the snapshot
      // can miss short-lived assignments that happened between sync ticks.
      let prevTechId = null;
      let prevTechName = null;
      let unassignedAt = null;
      let unassignedByName = null;

      const lastEpisode = analysis?.currentEpisode;
      if (lastEpisode && lastEpisode.endMethod === 'rejected') {
        prevTechName = lastEpisode.agentName || null;
        unassignedAt = lastEpisode.endedAt;
        unassignedByName = lastEpisode.endActorName || null;
      }

      // Find the most recent rejection event for fallback timestamp/actor
      if ((!unassignedAt || !unassignedByName) && analysis?.events?.length) {
        const lastReject = [...analysis.events].reverse().find((e) => e.type === 'rejected');
        if (lastReject) {
          unassignedAt = unassignedAt || lastReject.timestamp;
          unassignedByName = unassignedByName || lastReject.actorName;
        }
      }

      // If snapshot diff caught it (existingTicket.assignedTechId), use that
      // as the canonical previous tech ID since we have it. Otherwise look
      // up by name from the episode.
      if (existingTicket?.assignedTechId) {
        const prevTech = await prisma.technician.findUnique({
          where: { id: existingTicket.assignedTechId },
          select: { id: true, name: true },
        });
        if (prevTech) {
          prevTechId = prevTech.id;
          prevTechName = prevTechName || prevTech.name;
        }
      } else if (prevTechName) {
        const prevTech = await prisma.technician.findFirst({
          where: { name: prevTechName, workspaceId },
          select: { id: true, name: true },
        });
        if (prevTech) {
          prevTechId = prevTech.id;
          prevTechName = prevTech.name;
        }
      }

      const reboundFrom = {
        previousTechId: prevTechId,
        previousTechName: prevTechName || 'Unknown',
        unassignedAt: unassignedAt ? new Date(unassignedAt).toISOString() : null,
        unassignedByName: unassignedByName || null,
        reboundCount: reboundCount + 1,
      };

      logger.info('Bounce detection: queueing rebound pipeline run', {
        ticketId: upsertedTicket.id,
        freshserviceTicketId: upsertedTicket.freshserviceTicketId?.toString(),
        ...reboundFrom,
      });

      // Trigger a fresh pipeline run. runPipeline will queue (outside business
      // hours) or run immediately. We deliberately don't await onEvent updates.
      const { default: assignmentPipelineService } = await import('./assignmentPipelineService.js');
      assignmentPipelineService.runPipeline(
        upsertedTicket.id,
        workspaceId,
        'rebound',
        null,
        null,
        { reboundFrom },
      ).catch((err) => {
        logger.warn('Rebound pipeline trigger failed', {
          ticketId: upsertedTicket.id, error: err.message,
        });
      });
    } catch (error) {
      logger.error(`Bounce detection failed for ticket ${upsertedTicket.id}:`, error);
    }
  }

  /**
   * Write FS-sourced events as TicketActivity rows, deduplicating by timestamp + type.
   */
  async _writeEventActivities(ticketId, events) {
    try {
      const existing = await prisma.ticketActivity.findMany({
        where: { ticketId },
        select: { activityType: true, performedAt: true },
      });
      const existingSet = new Set(
        existing.map((e) => `${e.activityType}:${e.performedAt.getTime()}`),
      );

      for (const evt of events) {
        const key = `${evt.type}:${new Date(evt.timestamp).getTime()}`;
        if (existingSet.has(key)) continue;

        const details = {};
        if (evt.actorFsId) details.actorFsId = evt.actorFsId;
        if (evt.agentName) details.agentName = evt.agentName;
        if (evt.groupName !== undefined) details.groupName = evt.groupName;
        if (evt.source) details.source = evt.source;

        await prisma.ticketActivity.create({
          data: {
            ticketId,
            activityType: evt.type,
            performedBy: evt.actorName || 'Unknown',
            performedAt: new Date(evt.timestamp),
            details: Object.keys(details).length > 0 ? details : undefined,
          },
        });
      }
    } catch (error) {
      logger.error(`Failed to write event activities for ticket ${ticketId}:`, error);
    }
  }

  async _writeThreadEntries(ticketId, workspaceId, activities) {
    try {
      const entries = transformTicketThreadEntries(activities, { ticketId, workspaceId });
      if (entries.length === 0) return;
      await ticketThreadRepository.bulkUpsert(entries);
    } catch (error) {
      logger.error(`Failed to write thread entries for ticket ${ticketId}:`, error);
    }
  }

  /**
   * Preheat ticket thread data (activities + conversations) for today's
   * cohort during regular sync so the daily review has near-zero cold
   * fetches and finishes in seconds instead of minutes.
   *
   * Cohort: any ticket created OR updated OR resolved OR closed since the
   * start of today in the workspace's timezone — this matches the cohort
   * the daily review actually scores.
   *
   * Skip rule: per (ticketId, source) pair, if the most recent cached
   * thread entry's occurredAt is >= ticket.updatedAt, the cache is fresh
   * for that source and we don't re-fetch.
   *
   * Cap: at most MAX_PREHEAT_TICKETS_PER_CYCLE tickets per call, oldest
   * ticket.updatedAt first so a backlog drains over a few cycles and one
   * cycle never blows the FS rate-limit budget.
   *
   * Errors on a single ticket are logged + swallowed; one bad ticket
   * never aborts the cycle.
   */
  async _preheatTicketThreads(workspaceId) {
    try {
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true, name: true, defaultTimezone: true },
      });
      if (!workspace) return { skipped: true, reason: 'workspace_not_found' };

      // Per-workspace opt-in. Workspaces that don't use Daily Review
      // shouldn't pay the FS API budget tax for conversation pulls they
      // will never read, so this is off by default. Admin enables it via
      // Configuration → Daily Review Automation in the UI.
      const assignmentConfig = await prisma.assignmentConfig.findUnique({
        where: { workspaceId },
        select: { dailyReviewPreheatEnabled: true },
      });
      if (!assignmentConfig?.dailyReviewPreheatEnabled) {
        return { skipped: true, reason: 'preheat_disabled_for_workspace' };
      }

      const fsConfig = await settingsRepository.getFreshServiceConfigForWorkspace(workspaceId);
      if (!fsConfig?.domain || !fsConfig?.apiKey) {
        return { skipped: true, reason: 'freshservice_not_configured' };
      }

      const tz = workspace.defaultTimezone || 'America/Los_Angeles';
      const todayLocal = formatInTimeZone(new Date(), tz, 'yyyy-MM-dd');
      // ISO datetime at 00:00 in the workspace TZ → JS Date in UTC
      const startIso = formatInTimeZone(new Date(`${todayLocal}T12:00:00.000Z`), tz, 'yyyy-MM-dd\'T\'00:00:00XXX');
      const startOfDay = new Date(startIso);

      // Cohort: only include tickets whose FS-side state changed today.
      // We deliberately do NOT key off `updatedAt` because Prisma's
      // `@updatedAt` auto-bumps on every local DB write (every sync
      // touches every recent ticket), which would balloon the cohort to
      // thousands of tickets a day and the cap would never drain a
      // useful subset.
      const cohort = await prisma.ticket.findMany({
        where: {
          workspaceId,
          OR: [
            { createdAt: { gte: startOfDay } },
            { assignedAt: { gte: startOfDay } },
            { resolvedAt: { gte: startOfDay } },
            { closedAt: { gte: startOfDay } },
          ],
        },
        select: {
          id: true,
          freshserviceTicketId: true,
          createdAt: true,
          assignedAt: true,
          resolvedAt: true,
          closedAt: true,
        },
        orderBy: { createdAt: 'asc' },
      });

      if (cohort.length === 0) {
        return { skipped: false, ticketsConsidered: 0, ticketsHydrated: 0 };
      }

      // Per-source latest occurredAt across the entire cohort in one query
      // instead of N round-trips; without this, preheat would ironically
      // become its own bottleneck on workspaces with thousands of cached
      // entries per ticket.
      const cohortIds = cohort.map((t) => t.id);
      const latestRows = await prisma.ticketThreadEntry.groupBy({
        by: ['ticketId', 'source'],
        where: { workspaceId, ticketId: { in: cohortIds } },
        _max: { occurredAt: true },
      });
      const latestByPair = new Map(); // key = `${ticketId}::${source}` → Date
      for (const row of latestRows) {
        latestByPair.set(`${row.ticketId}::${row.source}`, row._max.occurredAt);
      }

      // Per-ticket "newest known FS state change" — used to decide whether
      // the cache is fresh. Compare against the latest entry's occurredAt
      // per source: if the cache hasn't seen this state change yet, refetch.
      const newestFsChange = (t) => {
        const candidates = [t.createdAt, t.assignedAt, t.resolvedAt, t.closedAt]
          .filter(Boolean)
          .map((d) => d.getTime());
        return candidates.length > 0 ? new Date(Math.max(...candidates)) : null;
      };

      // Build the actual job list, applying the per-source freshness skip.
      // Activities source key matches what transformTicketThreadEntries writes
      // ("freshservice_activity"); conversations writes "freshservice_conversation".
      const jobs = [];
      const ticketsToHydrate = new Set();
      for (const ticket of cohort) {
        const fsChange = newestFsChange(ticket);
        const latestActivities = latestByPair.get(`${ticket.id}::freshservice_activity`);
        const latestConversations = latestByPair.get(`${ticket.id}::freshservice_conversation`);

        if (!latestActivities || (fsChange && latestActivities < fsChange)) {
          jobs.push({ ticket, kind: 'activities' });
          ticketsToHydrate.add(ticket.id);
        }
        if (!latestConversations || (fsChange && latestConversations < fsChange)) {
          jobs.push({ ticket, kind: 'conversations' });
          ticketsToHydrate.add(ticket.id);
        }

        if (ticketsToHydrate.size >= MAX_PREHEAT_TICKETS_PER_CYCLE) break;
      }

      if (jobs.length === 0) {
        logger.info(`[preheat ws=${workspaceId}] All ${cohort.length} today-cohort ticket(s) already have fresh thread cache.`);
        return { skipped: false, ticketsConsidered: cohort.length, ticketsHydrated: 0 };
      }

      logger.info(`[preheat ws=${workspaceId}] Preheating threads for ${ticketsToHydrate.size}/${cohort.length} today-cohort ticket(s) (${jobs.length} FS endpoint call(s)).`);

      const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey, {
        priority: 'low',
        source: 'thread-preheat',
      });

      let activitiesFetched = 0;
      let conversationsFetched = 0;
      let failures = 0;

      const runJob = async (job) => {
        const { ticket, kind } = job;
        const fsTicketId = Number(ticket.freshserviceTicketId);
        try {
          if (kind === 'activities') {
            const activities = await client.fetchTicketActivities(fsTicketId);
            if (activities?.length) {
              const entries = transformTicketThreadEntries(activities, {
                ticketId: ticket.id, workspaceId,
              });
              if (entries.length) {
                await ticketThreadRepository.bulkUpsert(entries);
                activitiesFetched += entries.length;
              }
            }
          } else {
            const conversations = await client.fetchTicketConversations(fsTicketId, {
              maxEntries: PREHEAT_MAX_CONVERSATIONS_PER_TICKET,
            });
            if (conversations?.length) {
              const entries = transformTicketConversationEntries(conversations, {
                ticketId: ticket.id, workspaceId,
              });
              if (entries.length) {
                await ticketThreadRepository.bulkUpsert(entries);
                conversationsFetched += entries.length;
              }
            }
          }
        } catch (error) {
          failures += 1;
          // Log but never abort the cycle — preheat is opportunistic.
          logger.warn(`[preheat ws=${workspaceId}] ${kind} fetch failed for ticket #${fsTicketId}: ${error.message || error}`);
        }
      };

      await runJobsInPool(jobs, runJob, { poolSize: PREHEAT_POOL_SIZE });

      logger.info(`[preheat ws=${workspaceId}] Done: ${ticketsToHydrate.size} ticket(s), ${activitiesFetched} activity row(s) + ${conversationsFetched} conversation row(s), ${failures} failure(s).`);

      return {
        skipped: false,
        ticketsConsidered: cohort.length,
        ticketsHydrated: ticketsToHydrate.size,
        activitiesFetched,
        conversationsFetched,
        failures,
      };
    } catch (error) {
      logger.error(`[preheat ws=${workspaceId}] Preheat cycle failed:`, error);
      return { skipped: true, reason: 'error', error: error.message };
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
  async _prepareTicketsForDatabase(fsTickets, workspaceId = null) {
    if (!Array.isArray(fsTickets) || fsTickets.length === 0) {
      return [];
    }

    const transformOptions = {};
    if (workspaceId) {
      const wsConfig = await this._getWorkspaceConfig(workspaceId);
      if (wsConfig.categoryCustomField) {
        transformOptions.categoryCustomField = wsConfig.categoryCustomField;
      }
    }

    const transformedTickets = transformTickets(fsTickets, transformOptions);
    logger.debug(`Transformed ${transformedTickets.length} tickets`);

    // Include ALL technicians (active + inactive) so assignments to hidden/disabled agents are tracked
    const technicians = await technicianRepository.getAll(workspaceId, { lite: true });
    const fsIdToInternalId = new Map(
      technicians.map(tech => [Number(tech.freshserviceId), tech.id]),
    );
    logger.debug(`Built technician ID map for ${technicians.length} technicians (including inactive)`);

    const ticketsWithTechIds = mapTechnicianIds(transformedTickets, fsIdToInternalId);

    if (workspaceId) {
      ticketsWithTechIds.forEach(t => { t.workspaceId = workspaceId; });
    }

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
  /**
   * Analyze ticket activities. Rate limiting + concurrency are handled
   * centrally by the FreshServiceClient's shared rate limiter.
   *
   * Caller fires ALL activity fetches as parallel promises; the limiter
   * queues them and launches up to maxConcurrent at a time, spaced by
   * minDelayMs. This lets us saturate the rate budget instead of idling
   * between round-trips.
   */
  async _analyzeTicketActivities(client, tickets, options = {}) {
    const { ticketFilter = null, onProgress = null } = options;

    if (!Array.isArray(tickets) || tickets.length === 0) {
      return new Map();
    }

    let ticketsToAnalyze = tickets;
    if (ticketFilter) {
      ticketsToAnalyze = tickets.filter(ticketFilter);
    }

    const totalCount = ticketsToAnalyze.length;
    logger.info(`Analyzing ${totalCount} tickets (concurrent via shared rate limiter)`);

    const analysisMap = new Map();
    let processedCount = 0;
    let errorCount = 0;

    const processOne = async (ticket) => {
      const ticketId = ticket.id || ticket.freshserviceTicketId;
      const freshserviceUpdatedAt = ticket.updated_at
        ? new Date(ticket.updated_at)
        : (ticket.freshserviceUpdatedAt || null);
      try {
        const activities = await client.fetchTicketActivities(Number(ticketId));
        const analysis = analyzeTicketActivities(Array.isArray(activities) ? activities : []);
        analysisMap.set(ticketId.toString(), {
          analysis,
          activities: Array.isArray(activities) ? activities : [],
          activityFetchSucceeded: true,
          freshserviceUpdatedAt,
        });
        processedCount++;
      } catch (error) {
        errorCount++;
        analysisMap.set(ticketId.toString(), {
          activityFetchSucceeded: false,
          freshserviceUpdatedAt,
          errorMessage: error.message || String(error),
        });
        if (!String(error).includes('500')) {
          logger.warn(`Failed to analyze ticket ${ticketId}: ${error.message || error}`);
        }
      }

      const done = processedCount + errorCount;
      if (onProgress && done % 5 === 0) onProgress(done, totalCount);
      if (done % 50 === 0) {
        logger.info(`Activity analysis: ${done}/${totalCount} (${Math.round(done / totalCount * 100)}%) — ${errorCount} errors`);
      }
    };

    // Fire all requests in parallel; the shared limiter serializes them
    // up to maxConcurrent at a time while respecting the per-minute cap.
    await Promise.all(ticketsToAnalyze.map(processOne));

    if (onProgress) onProgress(totalCount, totalCount);
    logger.info(`Activity analysis complete: ${processedCount} analyzed, ${errorCount} errors`);
    return analysisMap;
  }

  /**
   * Update tickets with activity analysis results.
   * When a workspaceId is supplied, also reconciles episodes and writes
   * per-event TicketActivity rows — keeping the historical-backfill path
   * feature-parity with performFullSync.
   *
   * @param {Map} analysisMap - Map of ticketId → analysis object
   * @param {Object} options
   * @param {number} options.workspaceId - Required for episode reconciliation
   * @returns {Promise<number>} Count of updated tickets
   * @private
   */
  async _updateTicketsWithAnalysis(analysisMap, { workspaceId = null } = {}) {
    if (!analysisMap || analysisMap.size === 0) {
      return 0;
    }

    // Build tech-name→id map once per batch when we need episode reconciliation
    let techNameMap = null;
    if (workspaceId) {
      const allTechs = await technicianRepository.getAll(workspaceId, { lite: true });
      techNameMap = new Map();
      for (const t of allTechs) {
        techNameMap.set(t.name, t.id);
        if (t.email) techNameMap.set(t.email, t.id);
      }
    }

    let updatedCount = 0;

    for (const [ticketId, payload] of analysisMap.entries()) {
      try {
        const analysis = payload?.analysis || payload;
        const activities = payload?.activities || null;
        const activityFetchSucceeded = payload?.activityFetchSucceeded !== false;
        const freshserviceUpdatedAt = payload?.freshserviceUpdatedAt || null;
        const syncFinishedAt = new Date();
        const updated = await prisma.ticket.update({
          where: { freshserviceTicketId: BigInt(ticketId) },
          data: {
            firstAssignedAt: activityFetchSucceeded ? analysis.firstAssignedAt : undefined,
            // Prefer currentIsSelfPicked (new semantic) over legacy isSelfPicked
            isSelfPicked: activityFetchSucceeded
              ? (analysis.currentIsSelfPicked ?? analysis.isSelfPicked ?? false)
              : undefined,
            assignedBy: activityFetchSucceeded ? analysis.assignedBy : undefined,
            firstPublicAgentReplyAt: activityFetchSucceeded ? (analysis.firstPublicAgentReplyAt || undefined) : undefined,
            rejectionCount: activityFetchSucceeded ? (analysis.rejectionCount || 0) : undefined,
            activitiesSyncedAt: activityFetchSucceeded ? syncFinishedAt : undefined,
            activitiesSyncFreshserviceUpdatedAt: activityFetchSucceeded ? freshserviceUpdatedAt : undefined,
            activitiesSyncError: activityFetchSucceeded ? null : (payload?.errorMessage || 'FreshService activity fetch failed'),
            activitiesSyncErrorAt: activityFetchSucceeded ? null : syncFinishedAt,
          },
          select: { id: true, workspaceId: true },
        });
        updatedCount++;

        if (!activityFetchSucceeded) continue;

        // Reconcile episodes + write event activities (if we have tech map)
        if (techNameMap && analysis.episodes?.length) {
          const wsId = updated.workspaceId || workspaceId;
          await this._reconcileEpisodes(updated.id, wsId, analysis, techNameMap);
        }
        if (analysis.events?.length) {
          await this._writeEventActivities(updated.id, analysis.events);
        }
        if (activities?.length) {
          const wsId = updated.workspaceId || workspaceId;
          await this._writeThreadEntries(updated.id, wsId, activities);
        }
      } catch (error) {
        logger.warn(`Failed to update ticket ${ticketId} with analysis: ${error.message || error}`);
      }
    }

    logger.info(`Updated ${updatedCount} tickets with activity analysis (episodes: ${techNameMap ? 'reconciled' : 'skipped'})`);
    return updatedCount;
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
        const noiseWorkspaceId = ticket.workspaceId !== null ? ticket.workspaceId : 1;
        const { isNoise, ruleId } = await noiseRuleService.evaluate(
          ticket.subject,
          ticket.createdAt ? new Date(ticket.createdAt) : null,
          noiseWorkspaceId,
        );
        ticket.isNoise = isNoise;
        ticket.noiseRuleMatched = ruleId;
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
      workspaceId = null,
    } = params;

    const filters = {
      include: 'requester,stats',
    };

    // Add FreshService workspace_id so we only get tickets from this workspace
    if (workspaceId) {
      const wsConfig = await this._getWorkspaceConfig(workspaceId);
      if (wsConfig.workspaceId) {
        filters.workspace_id = wsConfig.workspaceId;
      }
    }

    if (syncType === 'week' && weekStart) {
      filters.updated_since = new Date(weekStart + 'T00:00:00Z').toISOString();
    } else if (syncType === 'full' || fullSync) {
      const historicalDate = new Date();
      historicalDate.setDate(historicalDate.getDate() - daysToSync);
      filters.updated_since = historicalDate.toISOString();
    } else {
      const latestSync = await syncLogRepository.getLatestSuccessful(workspaceId);

      if (latestSync && latestSync.completedAt) {
        filters.updated_since = new Date(latestSync.completedAt.getTime() - 5 * 60 * 1000).toISOString();
      } else {
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
  async syncTechnicians(workspaceId = null) {
    try {
      this.progress.currentStep = 'Syncing technicians from FreshService';
      this.progress.currentStepNumber = 1;
      logger.info(`Starting technician sync${workspaceId ? ` for workspace ${workspaceId}` : ''}`);
      const client = await this._initializeClient();
      const wsConfig = await this._getWorkspaceConfig(workspaceId);

      const filters = {};
      if (wsConfig.workspaceId) {
        filters.workspace_id = wsConfig.workspaceId;
      }

      const fsAgents = await client.fetchAgents(filters);
      logger.info(`Fetched ${fsAgents.length} agents from FreshService`);

      const transformedAgents = transformAgents(fsAgents, wsConfig.workspaceId);

      let syncedCount = 0;
      const syncedFreshserviceIds = [];
      for (const agent of transformedAgents) {
        try {
          if (workspaceId) agent.workspaceId = workspaceId;
          await technicianRepository.upsert(agent);
          syncedCount++;
          syncedFreshserviceIds.push(agent.freshserviceId);
        } catch (error) {
          logger.error(`Failed to upsert technician ${agent.name}:`, error);
        }
      }

      if (workspaceId && syncedFreshserviceIds.length > 0) {
        try {
          const deactivatedCount = await technicianRepository.deactivateNotInList(
            workspaceId,
            syncedFreshserviceIds,
          );
          if (deactivatedCount > 0) {
            logger.info(`Deactivated ${deactivatedCount} technicians no longer in workspace ${workspaceId}`);
          }
        } catch (error) {
          logger.error('Failed to deactivate removed technicians:', error);
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
        workspaceId: options.workspaceId || null,
      });

      if (options.status) {
        filters.status = options.status;
      }

      // Step 2: Fetch tickets from FreshService
      const fsTickets = await client.fetchTickets(filters);
      logger.info(`Fetched ${fsTickets.length} tickets from FreshService`);

      // Collect embedded requester display names from ticket payloads.
      // The ticket list API returns a pre-formatted requester.name that is often
      // more complete than the first_name/last_name from the requester API.
      for (const fsTicket of fsTickets) {
        if (fsTicket.requester_id && fsTicket.requester?.name) {
          this._embeddedRequesterNames.set(
            BigInt(fsTicket.requester_id).toString(),
            fsTicket.requester.name,
          );
        }
      }

      // Step 3: Use _prepareTicketsForDatabase() for transform + mapping
      const ticketsWithTechIds = await this._prepareTicketsForDatabase(fsTickets, options.workspaceId);

      // Step 4: OPTIMIZATION - Batch fetch existing tickets in one query
      const ticketIds = ticketsWithTechIds.map(t => t.freshserviceTicketId);
      const existingTicketsArray = await ticketRepository.getByFreshserviceIds(ticketIds);
      const existingTicketsMap = new Map(
        existingTicketsArray.map(t => [t.freshserviceTicketId.toString(), t]),
      );
      logger.info(`Found ${existingTicketsMap.size} existing tickets out of ${ticketIds.length}`);

      const preparedTicketMap = new Map(
        ticketsWithTechIds.map(t => [t.freshserviceTicketId.toString(), t]),
      );
      const activeEpisodeMap = new Map();
      if (existingTicketsArray.length > 0) {
        const activeEpisodes = await prisma.ticketAssignmentEpisode.findMany({
          where: {
            ticketId: { in: existingTicketsArray.map(t => t.id) },
            endedAt: null,
            OR: [
              { endMethod: 'still_active' },
              { endMethod: null },
            ],
          },
          select: {
            ticketId: true,
            technicianId: true,
            startedAt: true,
          },
          orderBy: { startedAt: 'desc' },
        });
        for (const episode of activeEpisodes) {
          if (!activeEpisodeMap.has(episode.ticketId)) {
            activeEpisodeMap.set(episode.ticketId, episode);
          }
        }
      }

      // Step 5: Use _analyzeTicketActivities() with broadened filter
      // Fetch activities when: new ticket, assignment data incomplete,
      // FS updated_at newer than our record, or ticket has an active pipeline run.
      const ticketsWithActiveRuns = new Set();
      try {
        const activeRuns = await prisma.assignmentPipelineRun.findMany({
          where: { status: { in: ['running', 'completed'] }, decision: 'pending_review' },
          select: { ticket: { select: { freshserviceTicketId: true } } },
        });
        for (const r of activeRuns) {
          if (r.ticket?.freshserviceTicketId) ticketsWithActiveRuns.add(r.ticket.freshserviceTicketId.toString());
        }
      } catch { /* non-fatal */ }

      const activityRefreshReasons = new Map();
      const ticketFilter = (fsTicket) => {
        const existingTicket = existingTicketsMap.get(fsTicket.id.toString());
        const preparedTicket = preparedTicketMap.get(fsTicket.id.toString()) || null;
        const reason = getActivityRefreshReason({
          fsTicket,
          preparedTicket,
          existingTicket,
          activeEpisode: existingTicket ? activeEpisodeMap.get(existingTicket.id) : null,
          hasActiveRun: ticketsWithActiveRuns.has(fsTicket.id.toString()),
        });
        if (reason) {
          activityRefreshReasons.set(fsTicket.id.toString(), reason);
          return true;
        }
        return false;
      };

      const activityAnalysisMap = await this._analyzeTicketActivities(client, fsTickets, {
        ticketFilter,
      });

      logger.info(`Analyzed ${activityAnalysisMap.size} tickets for activity data`, {
        refreshReasons: [...activityRefreshReasons.entries()].slice(0, 50),
        refreshReasonCount: activityRefreshReasons.size,
      });

      // Build tech name→id map for episode reconciliation
      const allTechs = await technicianRepository.getAll(options.workspaceId, { lite: true });
      const techNameMap = new Map();
      for (const t of allTechs) {
        techNameMap.set(t.name, t.id);
        if (t.email) techNameMap.set(t.email, t.id);
      }

      // Step 6: Upsert tickets with merge logic, activity logging, and episode reconciliation
      let syncedCount = 0;
      const touchedWorkspaceIds = new Set();
      for (const ticket of ticketsWithTechIds) {
        try {
          const existingTicket = existingTicketsMap.get(ticket.freshserviceTicketId.toString());
          const ticketWorkspaceId = ticket.workspaceId ?? options.workspaceId ?? 1;
          touchedWorkspaceIds.add(ticketWorkspaceId);

          // Resolve unknown-to-us responders. FS may assign tickets to agents
          // we don't track (external contractors, agents deactivated from
          // our map, agents that joined without a full tech sync, etc.). In
          // those cases mapTechnicianIds leaves assignedTechId null, which
          // leaves a stale pending_review run sitting in the queue forever.
          // Resolve on-demand and persist the agent as inactive.
          if (ticket.assignedFreshserviceId && !ticket.assignedTechId) {
            const resolved = await this._resolveResponderTech(
              ticket.assignedFreshserviceId,
              ticketWorkspaceId,
              client,
            );
            if (resolved) {
              ticket.assignedTechId = resolved.techId;
            }
          }

          const { isNoise, ruleId, category: noiseCategory } = await noiseRuleService.evaluate(
            ticket.subject,
            ticket.createdAt ? new Date(ticket.createdAt) : null,
            ticketWorkspaceId,
          );
          const normalizedNoiseCategory = formatNoiseCategory(noiseCategory);

          let isSelfPicked = false;
          let assignedBy = null;
          let firstAssignedAt = null;
          let rejectionCount = existingTicket?.rejectionCount || 0;

          const analyzedPayload = activityAnalysisMap.get(ticket.freshserviceTicketId.toString());
          const analysis = analyzedPayload?.analysis || null;
          const activities = analyzedPayload?.activities || null;
          const activityFetchSucceeded = analyzedPayload?.activityFetchSucceeded === true;
          const activityFetchFailed = analyzedPayload?.activityFetchSucceeded === false;
          if (analysis) {
            isSelfPicked = analysis.currentIsSelfPicked;
            assignedBy = analysis.assignedBy;
            firstAssignedAt = analysis.firstAssignedAt;
            rejectionCount = analysis.rejectionCount || 0;
          } else if (existingTicket) {
            isSelfPicked = existingTicket.isSelfPicked;
            assignedBy = existingTicket.assignedBy;
            firstAssignedAt = existingTicket.firstAssignedAt;
          }

          const upsertedTicket = await ticketRepository.upsert({
            ...ticket,
            workspaceId: ticketWorkspaceId,
            isNoise,
            noiseRuleMatched: ruleId,
            ticketCategory: ticket.ticketCategory || normalizedNoiseCategory,
            freshserviceUpdatedAt: ticket.freshserviceUpdatedAt || null,
            isSelfPicked,
            assignedBy,
            firstAssignedAt,
            rejectionCount,
          });

          await this._ensureNoiseTicketDismissed(upsertedTicket, ticketWorkspaceId, {
            noiseRuleCategory: normalizedNoiseCategory,
            waitForSync: false,
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

          // --- Reconcile assignment episodes from FS activity analysis ---
          if (analysis && analysis.episodes && analysis.episodes.length > 0) {
            await this._reconcileEpisodes(upsertedTicket.id, ticketWorkspaceId, analysis, techNameMap);
          }

          // --- Write FS-sourced event activities (richer than snapshot diffs) ---
          if (analysis && analysis.events && analysis.events.length > 0) {
            await this._writeEventActivities(upsertedTicket.id, analysis.events);
          }
          if (activities && activities.length > 0) {
            await this._writeThreadEntries(upsertedTicket.id, ticketWorkspaceId, activities);
          }

          if (activityFetchSucceeded || activityFetchFailed) {
            const activitySyncFinishedAt = new Date();
            const activitySyncData = activityFetchSucceeded
              ? {
                activitiesSyncedAt: activitySyncFinishedAt,
                activitiesSyncFreshserviceUpdatedAt: analyzedPayload.freshserviceUpdatedAt || ticket.freshserviceUpdatedAt || null,
                activitiesSyncError: null,
                activitiesSyncErrorAt: null,
              }
              : {
                activitiesSyncError: analyzedPayload.errorMessage || 'FreshService activity fetch failed',
                activitiesSyncErrorAt: activitySyncFinishedAt,
              };
            await prisma.ticket.update({
              where: { id: upsertedTicket.id },
              data: activitySyncData,
            });
          }

          // --- Bounce detection: ticket was assigned then unassigned ---
          // We trigger a fresh pipeline run if either signal fires:
          //
          //  (a) DB snapshot diff: existing.assignedTechId → null. This
          //      catches the simple case where the sync saw the assigned
          //      state at least once and now sees it cleared.
          //
          //  (b) Activity analyzer: the latest episode ended with
          //      end_method='rejected'. This catches the case where
          //      FS assignment + rejection both happened between two of
          //      our sync ticks (the snapshot never saw the assignment),
          //      so (a) would silently miss it. The analyzer reads FS
          //      events directly, so it's the source of truth.
          //
          // The rebound handler itself dedupes against open runs and a
          // max-rebounds-per-ticket loop guard, so firing both signals
          // is safe.
          const snapshotBounce = !!(
            existingTicket
            && existingTicket.assignedTechId
            && upsertedTicket.assignedTechId === null
          );
          const analyzerBounce = !!(
            analysis
            && analysis.currentEpisode
            && analysis.currentEpisode.endMethod === 'rejected'
            && upsertedTicket.assignedTechId === null
          );

          if (
            (snapshotBounce || analyzerBounce)
            && ['Open', 'Pending'].includes(upsertedTicket.status)
            && !upsertedTicket.isNoise
          ) {
            this._handleTicketRebound(
              upsertedTicket,
              existingTicket,
              analysis,
              ticketWorkspaceId,
            ).catch((err) => {
              logger.warn('Bounce-detection follow-up failed (non-fatal)', {
                ticketId: upsertedTicket.id, error: err.message,
              });
            });
          }

          syncedCount++;
        } catch (error) {
          logger.error(`Failed to upsert ticket ${ticket.freshserviceTicketId}:`, error);
        }
      }

      const recoveryWorkspaceIds = touchedWorkspaceIds.size > 0
        ? [...touchedWorkspaceIds]
        : (options.workspaceId ? [options.workspaceId] : []);
      for (const workspaceId of recoveryWorkspaceIds) {
        this._recoverOpenNoiseTickets(workspaceId, { waitForSync: false }).catch((err) => {
          logger.warn('Open noise-ticket recovery failed (non-fatal)', {
            workspaceId,
            error: err.message,
          });
        });
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
   * Fast path for the Assignment Review "sync now" button.
   *
   * This intentionally does NOT run the broad dashboard sync tail work
   * (requesters, CSAT, stale-ticket reconciliation, thread preheat). It only
   * pulls recently changed FS tickets for the active workspace, upserts their
   * snapshot fields, then starts assignment polling for those exact rows.
   */
  async syncAssignmentCandidatesNow(workspaceId, options = {}) {
    const lookbackMinutes = Math.max(5, Math.min(parseInt(options.lookbackMinutes, 10) || 90, 24 * 60));
    const maxTickets = Math.max(1, Math.min(parseInt(options.maxTickets, 10) || 50, 200));
    const maxPipelineRuns = Math.max(1, Math.min(parseInt(options.maxPipelineRuns, 10) || 10, 50));
    const cutoff = new Date(Date.now() - lookbackMinutes * 60 * 1000);

    logger.info('Assignment fast sync started', {
      workspaceId,
      lookbackMinutes,
      maxTickets,
      maxPipelineRuns,
    });

    const wsConfig = await this._getWorkspaceConfig(workspaceId);
    const client = createFreshServiceClient(wsConfig.domain, wsConfig.apiKey, {
      priority: 'high',
      source: 'assignment-fast-sync',
    });
    const filters = {
      include: 'requester,stats',
      updated_since: cutoff.toISOString(),
    };
    if (wsConfig.workspaceId) {
      filters.workspace_id = wsConfig.workspaceId;
    }

    const fsTickets = await client.fetchTickets(filters);
    const recentTickets = [...fsTickets]
      .sort((a, b) => {
        const aTime = new Date(a.updated_at || a.created_at || 0).getTime();
        const bTime = new Date(b.updated_at || b.created_at || 0).getTime();
        return bTime - aTime;
      })
      .slice(0, maxTickets);

    for (const fsTicket of recentTickets) {
      if (fsTicket.requester_id && fsTicket.requester?.name) {
        this._embeddedRequesterNames.set(
          BigInt(fsTicket.requester_id).toString(),
          fsTicket.requester.name,
        );
      }
    }

    const ticketsWithTechIds = await this._prepareTicketsForDatabase(recentTickets, workspaceId);
    const ticketIds = ticketsWithTechIds.map(t => t.freshserviceTicketId);
    const existingTicketsArray = await ticketRepository.getByFreshserviceIds(ticketIds);
    const existingTicketsMap = new Map(
      existingTicketsArray.map(t => [t.freshserviceTicketId.toString(), t]),
    );

    const upsertedIds = [];
    let syncedCount = 0;

    for (const ticket of ticketsWithTechIds) {
      try {
        const existingTicket = existingTicketsMap.get(ticket.freshserviceTicketId.toString());
        const ticketWorkspaceId = ticket.workspaceId ?? workspaceId;

        if (ticket.assignedFreshserviceId && !ticket.assignedTechId) {
          const resolved = await this._resolveResponderTech(
            ticket.assignedFreshserviceId,
            ticketWorkspaceId,
            client,
          );
          if (resolved) {
            ticket.assignedTechId = resolved.techId;
          }
        }

        const { isNoise, ruleId, category: noiseCategory } = await noiseRuleService.evaluate(
          ticket.subject,
          ticket.createdAt ? new Date(ticket.createdAt) : null,
          ticketWorkspaceId,
        );
        const normalizedNoiseCategory = formatNoiseCategory(noiseCategory);

        const upsertedTicket = await ticketRepository.upsert({
          ...ticket,
          workspaceId: ticketWorkspaceId,
          isNoise,
          noiseRuleMatched: ruleId,
          ticketCategory: ticket.ticketCategory || normalizedNoiseCategory,
          freshserviceUpdatedAt: ticket.freshserviceUpdatedAt || null,
          isSelfPicked: existingTicket?.isSelfPicked || false,
          assignedBy: existingTicket?.assignedBy || null,
          firstAssignedAt: existingTicket?.firstAssignedAt || null,
          rejectionCount: existingTicket?.rejectionCount || 0,
        });

        upsertedIds.push(upsertedTicket.id);
        await this._ensureNoiseTicketDismissed(upsertedTicket, ticketWorkspaceId, {
          noiseRuleCategory: normalizedNoiseCategory,
          waitForSync: true,
        });
        syncedCount++;
      } catch (error) {
        logger.warn('Assignment fast sync: failed to upsert ticket', {
          workspaceId,
          freshserviceTicketId: ticket.freshserviceTicketId?.toString?.() || ticket.freshserviceTicketId,
          error: error.message,
        });
      }
    }

    const polling = await this._pollForUnassignedTickets(workspaceId, {
      ticketIdsOverride: upsertedIds,
      cutoffOverride: cutoff,
      maxPerCycleOverride: maxPipelineRuns,
      waitForCompletion: false,
      settleAfterMs: 1000,
    });
    const noiseRecovery = await this._recoverOpenNoiseTickets(workspaceId, {
      waitForSync: true,
      limit: Math.max(10, maxTickets),
    }).catch((err) => {
      logger.warn('Assignment fast sync: open noise-ticket recovery failed', {
        workspaceId,
        error: err.message,
      });
      return { skipped: true, reason: 'recovery_failed', error: err.message };
    });

    clearReadCache();

    const result = {
      status: 'completed',
      mode: 'assignment-fast-sync',
      lookbackMinutes,
      ticketsFetched: fsTickets.length,
      ticketsConsidered: recentTickets.length,
      ticketsSynced: syncedCount,
      candidateTicketIds: upsertedIds,
      polling,
      noiseRecovery,
      timestamp: new Date(),
    };

    logger.info('Assignment fast sync completed', result);
    return result;
  }

  async _recoverOpenNoiseTickets(workspaceId, options = {}) {
    const config = await assignmentRepository.getConfig(workspaceId);
    if (!config?.isEnabled || !config?.autoCloseNoise) {
      return { skipped: true, reason: 'noise_auto_close_disabled', checked: 0, created: 0 };
    }

    const limit = Math.max(1, Math.min(parseInt(options.limit, 10) || 25, 100));
    const lookbackDays = Math.max(1, Math.min(parseInt(options.lookbackDays, 10) || 7, 30));
    const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

    const tickets = await prisma.ticket.findMany({
      where: {
        workspaceId,
        assignedTechId: null,
        isNoise: true,
        status: { in: [...ACTIONABLE_TICKET_STATUSES] },
        createdAt: { gte: cutoff },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    let created = 0;
    let skipped = 0;
    let syncTriggered = 0;
    const runIds = [];

    for (const ticket of tickets) {
      const result = await this._ensureNoiseTicketDismissed(ticket, workspaceId, {
        config,
        waitForSync: !!options.waitForSync,
      });
      if (result.created) {
        created++;
        runIds.push(result.runId);
      } else {
        skipped++;
      }
      if (result.syncTriggered) syncTriggered++;
    }

    if (created > 0 || syncTriggered > 0) {
      logger.info('Recovered open noise tickets', {
        workspaceId,
        checked: tickets.length,
        created,
        syncTriggered,
        runIds,
      });
    }

    return { skipped: false, checked: tickets.length, created, alreadyHandled: skipped, syncTriggered, runIds };
  }

  async _ensureNoiseTicketDismissed(ticket, workspaceId, options = {}) {
    if (!ticket?.isNoise) {
      return { skipped: true, reason: 'not_noise' };
    }
    if (ticket.assignedTechId || !ACTIONABLE_TICKET_STATUSES.has(ticket.status)) {
      return { skipped: true, reason: 'not_open_unassigned' };
    }

    const config = options.config || await assignmentRepository.getConfig(workspaceId);
    if (!config?.isEnabled || !config?.autoCloseNoise) {
      return { skipped: true, reason: 'noise_auto_close_disabled' };
    }

    let matchedNoiseCategory = options.noiseRuleCategory || null;
    if (!matchedNoiseCategory && ticket.noiseRuleMatched) {
      const matchedRule = await prisma.noiseRule.findFirst({
        where: { workspaceId, name: ticket.noiseRuleMatched },
        select: { category: true },
      });
      matchedNoiseCategory = formatNoiseCategory(matchedRule?.category);
    }
    const noiseRuleCategory = matchedNoiseCategory || ticket.ticketCategory || ticket.category || 'Noise';
    if (!ticket.ticketCategory && noiseRuleCategory) {
      await prisma.ticket.update({
        where: { id: ticket.id },
        data: { ticketCategory: noiseRuleCategory },
      });
    }
    const closureNoticeHtml = 'This ticket matched an automated non-actionable notification rule and does not require helpdesk follow-up.';
    const now = new Date();
    const runResult = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ticket.id})`;
      const existing = await tx.assignmentPipelineRun.findFirst({
        where: {
          ticketId: ticket.id,
          decision: 'noise_dismissed',
          status: 'completed',
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, syncStatus: true },
      });
      if (existing) return { existing };

      const run = await tx.assignmentPipelineRun.create({
        data: {
          ticketId: ticket.id,
          workspaceId,
          status: 'completed',
          triggerSource: NOISE_RULE_TRIGGER_SOURCE,
          llmModel: 'noise-rule',
          totalDurationMs: 0,
          totalTokensUsed: 0,
          decision: 'noise_dismissed',
          decidedAt: now,
          recommendation: {
            recommendations: [],
            overallReasoning: `Matched noise rule: ${ticket.noiseRuleMatched || 'unknown'}.`,
            closureNoticeHtml,
            ticketClassification: noiseRuleCategory,
            noiseRuleMatched: ticket.noiseRuleMatched || null,
            noiseRuleCategory,
            source: 'noise_rule',
          },
          errorMessage: ticket.noiseRuleMatched
            ? `Auto-dismissed by noise rule: ${ticket.noiseRuleMatched}`
            : 'Auto-dismissed by noise rule',
          syncStatus: 'pending',
        },
        select: { id: true },
      });
      return { run };
    });

    if (runResult.existing) {
      return {
        skipped: true,
        reason: 'existing_noise_dismissal',
        runId: runResult.existing.id,
        syncStatus: runResult.existing.syncStatus,
      };
    }

    const run = runResult.run;

    logger.info('Created noise dismissal run for rule-filtered ticket', {
      workspaceId,
      ticketId: ticket.id,
      freshserviceTicketId: ticket.freshserviceTicketId?.toString?.() || ticket.freshserviceTicketId,
      runId: run.id,
      noiseRuleMatched: ticket.noiseRuleMatched,
      noiseRuleCategory,
    });

    const executeSync = () => freshServiceActionService.execute(
      run.id,
      workspaceId,
      config?.dryRunMode ?? true,
    ).catch((err) => {
      logger.warn('FreshService noise close failed after rule dismissal run', {
        workspaceId,
        ticketId: ticket.id,
        runId: run.id,
        error: err.message,
      });
      return { success: false, error: err.message };
    });

    if (options.waitForSync) {
      await executeSync();
    } else {
      executeSync();
    }

    return { created: true, runId: run.id, syncTriggered: true };
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
          const syncedRequesters = await requesterRepository.bulkUpsert(
            fsRequesters,
            { embeddedNames: this._embeddedRequesterNames },
          );
          syncedCount = syncedRequesters.length;
          logger.info(`Synced ${syncedCount} requesters`);
        } else {
          logger.warn('No requesters fetched from FreshService');
        }
      } else {
        logger.info('No new requesters to fetch');
      }

      // Update existing requesters whose stored name is shorter than the
      // embedded display name from ticket payloads (fixes incomplete names).
      if (this._embeddedRequesterNames.size > 0) {
        const namesFixed = await requesterRepository.fixIncompleteNames(this._embeddedRequesterNames);
        if (namesFixed > 0) {
          logger.info(`Fixed ${namesFixed} requester names from embedded ticket data`);
        }
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
    const workspaceId = options.workspaceId || 1;

    if (this.runningWorkspaces.has(workspaceId)) {
      logger.warn(`Sync already in progress for workspace ${workspaceId}, skipping`);
      return { status: 'skipped', reason: `Sync already in progress for workspace ${workspaceId}` };
    }

    this.runningWorkspaces.add(workspaceId);
    this._embeddedRequesterNames = new Map();
    this.progress = {
      currentStep: 'Initializing sync',
      techniciansSynced: 0,
      ticketsSynced: 0,
      requestersSynced: 0,
      csatSynced: 0,
      totalSteps: 5,
      currentStepNumber: 0,
      workspaceId,
    };

    const syncLog = await syncLogRepository.createLog({ status: 'started', workspaceId });

    try {
      logger.info(`Starting full sync for workspace ${workspaceId}`);

      // Capture the previous successful sync time so we can detect outage gaps.
      // We need this before our own sync log gets completed (otherwise it'd return our own current run).
      const prevSync = await syncLogRepository.getLatestSuccessful(workspaceId);
      const prevSyncCompletedAt = prevSync?.completedAt || null;

      // Sync technicians first (needed for ticket assignment mapping)
      const techniciansSynced = await this.syncTechnicians(workspaceId);

      // Sync tickets with options (including fullSync flag and workspaceId)
      const ticketsSynced = await this.syncTickets({ ...options, workspaceId });

      this._pollForUnassignedTickets(workspaceId, { prevSyncCompletedAt }).catch((err) => {
        logger.warn('Assignment polling failed after ticket sync (non-fatal)', { workspaceId, error: err.message });
      });

      // Sync requesters (fetch requester details for tickets)
      const requestersSynced = await this.syncRequesters();

      // Sync CSAT responses for recent closed tickets
      let csatSynced = 0;
      try {
        this.progress.currentStep = 'Syncing CSAT responses';
        this.progress.currentStepNumber = 4;

        // Skip scheduled CSAT sync entirely if an admin backfill is running
        // for any workspace — the backfill will handle CSAT more thoroughly
        // and we don't want to compete for the shared FS rate limiter budget.
        const backfillActive = [...this.runningWorkspaces].some((k) => String(k).startsWith('backfill:'));
        if (backfillActive) {
          logger.info('Skipping scheduled CSAT sync: admin backfill is active');
        } else {
          const csatDaysBack = parseInt(await settingsRepository.get('csat_sync_days'), 10) || 90;
          // Tight cap per scheduled cycle: 4 workspaces × 30 = 120 CSAT calls
          // per 5-min window = ~24 calls/min = 22% of the 110/min limiter budget.
          // Leaves room for the actual sync work + any admin operations.
          const csatResults = await this.syncRecentCSAT(csatDaysBack, workspaceId, { limit: 30 });
          csatSynced = csatResults.csatFound;
          this.progress.csatSynced = csatSynced;
        }
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
      this.runningWorkspaces.delete(workspaceId);
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
      clearReadCache();

      // Broadcast sync completion to SSE clients for this workspace
      try {
        const manager = await getSSEManager();
        if (manager) {
          manager.broadcast('sync-completed', summary, workspaceId);
        }
      } catch (error) {
        logger.error('Failed to broadcast SSE update:', error);
      }

      // Assignment pipeline polling fallback: the primary kick-off happens
      // immediately after ticket upsert so auto-assign does not wait behind
      // requester, CSAT, and other sync tail work. This second pass is safe
      // because _pollForUnassignedTickets skips tickets with active/completed
      // runs, and it can catch tickets that changed during the tail phase.
      this._pollForUnassignedTickets(workspaceId, { prevSyncCompletedAt }).catch((err) => {
        logger.warn('Assignment polling failed (non-fatal)', { workspaceId, error: err.message });
      });

      // Recover orphaned syncs (decision saved but FS write never completed —
      // typically caused by a process restart between the decidedAt update and
      // the fire-and-forget freshServiceActionService.execute call). Without
      // this, runs would show "auto-assigned to X" in our DB while the ticket
      // sat unassigned in FS forever. Fire-and-forget; per-run errors are logged
      // inside the recovery routine.
      this._recoverOrphanedSyncs(workspaceId).catch((err) => {
        logger.warn('Orphan sync recovery failed (non-fatal)', { workspaceId, error: err.message });
      });

      // Reconcile ticket statuses: detect deleted/spam tickets not returned by list API (fire-and-forget)
      this._reconcileTicketStatuses(workspaceId).catch((err) => {
        logger.warn('Ticket status reconciliation failed (non-fatal)', { workspaceId, error: err.message });
      });

      // Preheat thread data (activities + conversation BODIES) for today's
      // cohort so the daily review hits an already-warm cache and doesn't
      // need to do dozens of cold FS calls right when the user clicks
      // "Run Daily Review". Fire-and-forget; cap + skip-if-fresh logic
      // bound the FS rate-limit budget per cycle.
      this._preheatTicketThreads(workspaceId).catch((err) => {
        logger.warn('Thread preheat failed (non-fatal)', { workspaceId, error: err.message });
      });

      return summary;
    } catch (error) {
      logger.error('Full sync failed:', error);

      // Mark sync as failed
      await syncLogRepository.failLog(syncLog.id, error.message);

      this.runningWorkspaces.delete(workspaceId);

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
    this.runningWorkspaces.clear();
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
      await this._writeThreadEntries(ticket.id, ticket.workspaceId || 1, activities);

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
      const client = await this._initializeClient({
        priority: 'low',
        source: 'pickup-time-backfill',
      });

      // Calculate date range
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToSync);

      const prismaModule = await import('./prisma.js');
      const db = prismaModule.default;
      const wsId = options.workspaceId || 1;

      let totalSuccessCount = 0;
      let totalFailureCount = 0;
      let totalProcessed = 0;
      let batchNumber = 1;
      let hasMore = true;

      while (hasMore) {
        const tickets = await db.ticket.findMany({
          where: {
            assignedTechId: { not: null },
            firstAssignedAt: null,
            createdAt: { gte: cutoffDate },
            workspaceId: wsId,
          },
          select: {
            id: true,
            freshserviceTicketId: true,
            workspaceId: true,
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
        const results = await this._processTicketsInParallel(client, db, tickets, concurrency);

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

  async backfillThreadEntries(options = {}) {
    const limit = options.limit || 100;
    const daysToSync = options.daysToSync || 14;
    const processAll = options.processAll || false;
    const workspaceId = options.workspaceId || 1;

    try {
      logger.info(`Starting thread-entry backfill (workspace=${workspaceId}, limit=${limit}, days=${daysToSync})`);
      const client = await this._initializeClient({
        priority: 'low',
        source: 'thread-entry-backfill',
      });
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToSync);

      let totalProcessed = 0;
      let totalHydrated = 0;
      let totalErrors = 0;
      let batchNumber = 1;
      let hasMore = true;

      while (hasMore) {
        const tickets = await prisma.ticket.findMany({
          where: {
            workspaceId,
            createdAt: { gte: cutoffDate },
          },
          select: {
            id: true,
            freshserviceTicketId: true,
            _count: { select: { threadEntries: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: (batchNumber - 1) * limit,
        });

        if (tickets.length === 0) {
          hasMore = false;
          break;
        }

        for (const ticket of tickets) {
          totalProcessed++;
          if (ticket._count?.threadEntries > 0 && !options.refreshExisting) {
            continue;
          }

          try {
            const activities = await client.fetchTicketActivities(Number(ticket.freshserviceTicketId));
            if (!activities?.length) continue;
            await this._writeThreadEntries(ticket.id, workspaceId, activities);
            totalHydrated++;
          } catch (error) {
            totalErrors++;
            logger.warn(`Thread-entry backfill failed for ticket ${ticket.freshserviceTicketId}: ${error.message}`);
          }
        }

        if (!processAll || tickets.length < limit) {
          hasMore = false;
        }
        batchNumber++;
      }

      return {
        ticketsProcessed: totalProcessed,
        ticketsHydrated: totalHydrated,
        errors: totalErrors,
        batches: batchNumber - 1,
        daysToSync,
      };
    } catch (error) {
      logger.error('Thread-entry backfill failed:', error);
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
  async syncWeek({ startDate, endDate, concurrency = 10, workspaceId = 1 }) {
    try {
      this.runningWorkspaces.add(workspaceId);
      this.progress = {
        currentStep: 'Initializing week sync',
        currentStepNumber: 1,
        totalSteps: 5,
        ticketsToProcess: 0,
        ticketsProcessed: 0,
        percentage: 0,
      };

      logger.info(`Starting week sync: ${startDate} to ${endDate} (concurrency: ${concurrency})`);
      const client = await this._initializeClient({
        priority: 'low',
        source: 'week-sync',
      });
      const wsConfig = await this._getWorkspaceConfig(workspaceId);

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
      if (wsConfig.workspaceId) {
        filters.workspace_id = wsConfig.workspaceId;
      }

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
      const preparedTickets = await this._prepareTicketsForDatabase(tickets, workspaceId);

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
      await this._updateTicketsWithAnalysis(analysisMap, { workspaceId });

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
      this.runningWorkspaces.delete(workspaceId);

      logger.info('Week sync completed', summary);
      return summary;

    } catch (error) {
      this.runningWorkspaces.delete(workspaceId);
      logger.error('Week sync failed:', error);
      throw error;
    }
  }

  /**
   * Historical backfill: fetch and sync tickets for a date range with progress tracking.
   *
   * Designed as the primary workspace onboarding tool. Processes tickets in
   * date-based batches with live SSE feedback, supports resuming after failure,
   * and can optionally skip tickets that already exist in the database.
   *
   * @param {Object} options
   * @param {string} options.startDate - YYYY-MM-DD
   * @param {string} options.endDate   - YYYY-MM-DD
   * @param {number} options.workspaceId
   * @param {boolean} options.skipExisting - Skip tickets already in DB
   * @param {number} options.activityConcurrency - Parallel activity fetches (default 3)
   * @param {Function} options.onProgress - Callback({phase, step, total, processed, pct, detail, batchRange})
   * @returns {Promise<Object>} Summary
   */
  async backfillDateRange(options = {}) {
    const {
      startDate,
      endDate,
      workspaceId = 1,
      skipExisting = true,
      activityConcurrency = 3,
      onProgress = null,
      triggeredByEmail = null,
    } = options;

    const backfillKey = `backfill:${workspaceId}`;
    if (this.runningWorkspaces.has(backfillKey)) {
      // Find the existing run row so the caller can attach to it
      const existing = await prisma.backfillRun.findFirst({
        where: { workspaceId, status: 'running' },
        orderBy: { startedAt: 'desc' },
      });
      return { status: 'skipped', reason: 'Backfill already running for this workspace', backfillRunId: existing?.id };
    }

    this.runningWorkspaces.add(backfillKey);

    // Create a DB row tracking this run — so the UI can rejoin after navigation
    // and we have a permanent history of all backfills.
    const runRow = await prisma.backfillRun.create({
      data: {
        workspaceId,
        status: 'running',
        startDate,
        endDate,
        skipExisting,
        activityConcurrency,
        triggeredByEmail,
      },
    });
    const runId = runRow.id;

    // Throttled DB progress writer — coalesce updates to at most 1/sec
    let lastDbWrite = 0;
    let lastEmittedProgress = null;
    const persistProgress = async (data, force = false) => {
      lastEmittedProgress = data;
      const now = Date.now();
      if (!force && now - lastDbWrite < 1000) return;
      lastDbWrite = now;
      try {
        await prisma.backfillRun.update({
          where: { id: runId },
          data: {
            progressPct: Math.max(0, Math.min(100, data.pct ?? 0)),
            progressStep: data.step?.slice(0, 255) || null,
            progressPhase: data.phase || null,
            ticketsTotal: data.total ?? undefined,
            ticketsProcessed: data.processed ?? undefined,
          },
        });
      } catch (e) {
        logger.warn(`Backfill run ${runId} progress persist failed: ${e.message}`);
      }
    };

    // Cancellation check — read from DB, throttled to avoid spamming queries
    let lastCancelCheck = 0;
    let cachedCancelRequested = false;
    const isCancelRequested = async () => {
      const now = Date.now();
      if (now - lastCancelCheck < 1000) return cachedCancelRequested;
      lastCancelCheck = now;
      try {
        const r = await prisma.backfillRun.findUnique({
          where: { id: runId },
          select: { cancelRequested: true },
        });
        cachedCancelRequested = !!r?.cancelRequested;
        return cachedCancelRequested;
      } catch {
        return false;
      }
    };

    const emit = (data) => {
      // Persist + forward to caller's SSE stream
      persistProgress(data).catch(() => {});
      if (onProgress) onProgress(data);
    };
    const startTime = Date.now();

    try {
      const client = await this._initializeClient({
        priority: 'low',
        source: 'historical-backfill',
      });
      const wsConfig = await this._getWorkspaceConfig(workspaceId);

      emit({ phase: 'init', step: 'Initializing backfill', pct: 0, detail: `${startDate} → ${endDate}` });

      // Phase 1: Sync technicians for this workspace
      emit({ phase: 'technicians', step: 'Syncing technicians', pct: 2 });
      const techsSynced = await this.syncTechnicians(workspaceId);
      emit({ phase: 'technicians', step: `Synced ${techsSynced} technicians`, pct: 5 });

      // Phase 2: Fetch all tickets in the date range from FreshService
      emit({ phase: 'fetch', step: 'Fetching tickets from FreshService', pct: 6, detail: `Since ${startDate}` });

      const fetchStart = new Date(startDate + 'T00:00:00Z');
      const fetchEnd = new Date(endDate + 'T23:59:59Z');

      const filters = {
        updated_since: fetchStart.toISOString(),
        include: 'requester,stats',
      };
      if (wsConfig.workspaceId) {
        filters.workspace_id = wsConfig.workspaceId;
      }

      const allTickets = await client.fetchTickets(filters, (page, itemCount) => {
        emit({ phase: 'fetch', step: `Fetching tickets (page ${page}, ${itemCount} so far)`, pct: Math.min(6 + Math.floor(page * 0.5), 20) });
      });

      // Filter to tickets updated within the target range
      const rangeTickets = allTickets.filter(t => {
        const updated = new Date(t.updated_at);
        return updated >= fetchStart && updated <= fetchEnd;
      });

      const totalTickets = rangeTickets.length;
      emit({ phase: 'fetch', step: `Found ${totalTickets} tickets in range`, pct: 20, total: totalTickets });

      // Collect embedded requester display names from ticket payloads
      for (const fsTicket of rangeTickets) {
        if (fsTicket.requester_id && fsTicket.requester?.name) {
          this._embeddedRequesterNames.set(
            BigInt(fsTicket.requester_id).toString(),
            fsTicket.requester.name,
          );
        }
      }

      if (totalTickets === 0) {
        this.runningWorkspaces.delete(backfillKey);
        return { status: 'completed', ticketsFetched: 0, ticketsSynced: 0, activitiesAnalyzed: 0, skipped: 0, elapsed: `${((Date.now() - startTime) / 1000).toFixed(0)}s` };
      }

      // Phase 3: Transform + map technician IDs
      emit({ phase: 'prepare', step: 'Mapping tickets to technicians', pct: 22 });
      const preparedTickets = await this._prepareTicketsForDatabase(rangeTickets, workspaceId);

      // Phase 4: Skip existing (optional)
      let ticketsToSync = preparedTickets;
      let skippedCount = 0;

      if (skipExisting) {
        emit({ phase: 'dedup', step: 'Checking for existing tickets', pct: 24 });
        const ticketIds = preparedTickets.map(t => t.freshserviceTicketId);
        const existingArr = await ticketRepository.getByFreshserviceIds(ticketIds);
        const existingSet = new Set(existingArr.map(t => t.freshserviceTicketId.toString()));

        ticketsToSync = preparedTickets.filter(t => !existingSet.has(t.freshserviceTicketId.toString()));
        skippedCount = preparedTickets.length - ticketsToSync.length;
        emit({ phase: 'dedup', step: `Skipping ${skippedCount} existing tickets, ${ticketsToSync.length} to sync`, pct: 26 });
      }

      // Phase 5: Upsert tickets in batches
      const batchSize = 50;
      let syncedCount = 0;
      const totalToSync = ticketsToSync.length;

      for (let i = 0; i < totalToSync; i += batchSize) {
        if (await isCancelRequested()) throw new Error('CANCELLED');

        const batch = ticketsToSync.slice(i, i + batchSize);
        const batchNum = Math.floor(i / batchSize) + 1;
        const totalBatches = Math.ceil(totalToSync / batchSize);
        const batchPct = 26 + Math.floor(((i + batch.length) / totalToSync) * 30);

        emit({
          phase: 'upsert',
          step: `Saving batch ${batchNum}/${totalBatches}`,
          pct: batchPct,
          processed: syncedCount,
          total: totalToSync,
          batchRange: `${i + 1}-${Math.min(i + batchSize, totalToSync)}`,
        });

        const batchSynced = await this._upsertTickets(batch);
        syncedCount += batchSynced;
      }

      emit({ phase: 'upsert', step: `Saved ${syncedCount} tickets`, pct: 56, processed: syncedCount, total: totalToSync });

      if (await isCancelRequested()) throw new Error('CANCELLED');

      // Phase 6: Analyze activities for assignment tracking
      emit({ phase: 'activities', step: 'Analyzing ticket activities', pct: 58, processed: 0, total: totalTickets });

      const analysisMap = await this._analyzeTicketActivities(client, rangeTickets, {
        concurrency: activityConcurrency,
        batchDelay: 2000,
        onProgress: async (processed, total) => {
          const actPct = 58 + Math.floor((processed / total) * 34);
          emit({
            phase: 'activities',
            step: `Analyzing activities (${processed}/${total})`,
            pct: actPct,
            processed,
            total,
          });
          // Periodic cancel check during the long activity-analysis phase
          if (processed % 50 === 0 && await isCancelRequested()) {
            throw new Error('CANCELLED');
          }
        },
      });

      if (await isCancelRequested()) throw new Error('CANCELLED');

      // Phase 7: Update tickets with analysis (includes episode reconciliation)
      emit({ phase: 'finalize', step: 'Updating tickets with analysis data', pct: 90 });
      await this._updateTicketsWithAnalysis(analysisMap, { workspaceId });

      if (await isCancelRequested()) throw new Error('CANCELLED');

      // Phase 8: Sync CSAT responses for every closed/resolved ticket in the
      // backfill's date range. We iterate through `rangeTickets` directly so
      // every ticket the user asked about gets checked — rather than using
      // the priority-ordered candidate query, which (correctly for the
      // scheduled sweep) may return a different subset.
      //
      // FS status codes: 4=Resolved, 5=Closed. Only those two states can have
      // CSAT responses. Anything else is skipped.
      let csatSynced = 0;
      let csatChecked = 0;
      try {
        const closedTicketIds = rangeTickets
          .filter((t) => t.status === 4 || t.status === 5)
          .map((t) => Number(t.id));

        emit({
          phase: 'csat',
          step: `Checking CSAT for ${closedTicketIds.length} closed/resolved tickets in range`,
          pct: 92,
          total: closedTicketIds.length,
          processed: 0,
        });

        if (closedTicketIds.length > 0) {
          const csatResult = await csatService.syncMultipleTicketsCSAT(
            client,
            ticketRepository,
            closedTicketIds,
            (cur, total, found) => {
              const pct = 92 + Math.floor((cur / total) * 4); // 92 → 96
              emit({
                phase: 'csat',
                step: `CSAT sync: ${cur}/${total} checked, ${found} responses found`,
                pct,
                processed: cur,
                total,
              });
            },
            isCancelRequested,
          );
          csatSynced = csatResult.csatFound || 0;
          csatChecked = csatResult.total || 0;
        }

        emit({
          phase: 'csat',
          step: `CSAT sync complete — ${csatSynced} found in ${csatChecked} checked`,
          pct: 96,
        });
      } catch (e) {
        logger.warn(`Backfill CSAT phase failed (non-fatal): ${e.message}`);
        emit({ phase: 'csat', step: `CSAT sync failed: ${e.message}`, pct: 96 });
      }

      if (await isCancelRequested()) throw new Error('CANCELLED');

      // Phase 9: Sync requesters
      emit({ phase: 'requesters', step: 'Syncing requester details', pct: 97 });
      await this.syncRequesters();

      const elapsedMs = Date.now() - startTime;
      const elapsed = `${(elapsedMs / 1000).toFixed(0)}s`;
      const summary = {
        status: 'completed',
        backfillRunId: runId,
        ticketsFetched: totalTickets,
        ticketsSynced: syncedCount,
        activitiesAnalyzed: analysisMap.size,
        csatSynced,
        csatChecked,
        skipped: skippedCount,
        dateRange: `${startDate} → ${endDate}`,
        elapsed,
      };

      // Persist final state to DB row
      await prisma.backfillRun.update({
        where: { id: runId },
        data: {
          status: 'completed',
          progressPct: 100,
          progressStep: 'Backfill complete',
          progressPhase: 'done',
          ticketsFetched: totalTickets,
          ticketsSynced: syncedCount,
          activitiesAnalyzed: analysisMap.size,
          skippedCount: skippedCount,
          elapsedMs,
          completedAt: new Date(),
        },
      }).catch((e) => logger.warn(`Failed to persist completed state for run ${runId}: ${e.message}`));

      emit({ phase: 'done', step: 'Backfill complete', pct: 100, detail: summary.elapsed, ...summary });

      this.runningWorkspaces.delete(backfillKey);
      clearReadCache();
      logger.info('Historical backfill completed', summary);

      // Trigger the assignment pipeline for any unassigned tickets in the backfilled range
      this._pollForUnassignedTickets(workspaceId, {
        cutoffOverride: fetchStart,
        maxPerCycleOverride: 50,
      }).catch((err) => {
        logger.warn('Post-backfill pipeline polling failed (non-fatal)', { workspaceId, error: err.message });
      });

      return summary;
    } catch (error) {
      this.runningWorkspaces.delete(backfillKey);
      const elapsedMs = Date.now() - startTime;
      const isCancellation = error.message === 'CANCELLED';

      // Persist final state to DB row
      await prisma.backfillRun.update({
        where: { id: runId },
        data: {
          status: isCancellation ? 'cancelled' : 'failed',
          progressPhase: isCancellation ? 'cancelled' : 'error',
          progressStep: isCancellation ? 'Cancelled by user' : `Failed: ${error.message?.slice(0, 240)}`,
          errorMessage: isCancellation ? null : error.message,
          elapsedMs,
          completedAt: new Date(),
        },
      }).catch((e) => logger.warn(`Failed to persist failure state for run ${runId}: ${e.message}`));

      if (isCancellation) {
        emit({ phase: 'cancelled', step: 'Backfill cancelled by user', pct: lastEmittedProgress?.pct ?? -1, backfillRunId: runId });
        logger.info(`Backfill run ${runId} cancelled by user`);
        return { status: 'cancelled', backfillRunId: runId };
      }

      emit({ phase: 'error', step: `Backfill failed: ${error.message}`, pct: -1, backfillRunId: runId });
      logger.error('Historical backfill failed:', error);
      throw error;
    }
  }

  /**
   * Sync CSAT responses for recently closed tickets
   * @param {number} daysBack - Number of days to look back (default 30)
   * @returns {Promise<Object>} Summary of CSAT sync results
   */
  /**
   * Sync CSAT for recently closed tickets.
   * @param {number} daysBack
   * @param {number|null} workspaceId
   * @param {Object} [options]
   * @param {number} [options.limit=200] - Max tickets to check per call
   * @param {Function} [options.onProgress] - Extra progress callback
   * @param {Function} [options.shouldCancel] - Abort hook
   */
  async syncRecentCSAT(daysBack = 30, workspaceId = null, options = {}) {
    try {
      const { limit = 200, onProgress = null, shouldCancel = null, minRecheckHours = 24 } = options;
      const client = await this._initializeClient({
        priority: 'low',
        source: 'csat-sync',
      });
      return await csatService.syncRecentCSAT(
        client,
        ticketRepository,
        daysBack,
        (current, total, found) => {
          this.progress.currentStep = `Syncing CSAT responses (${current}/${total}, found ${found})`;
          onProgress?.(current, total, found);
        },
        workspaceId,
        { limit, shouldCancel, minRecheckHours },
      );
    } catch (error) {
      logger.error('Error syncing recent CSAT:', error);
      throw error;
    }
  }

  /**
   * Post-sync polling: find unassigned tickets that haven't been processed
   * by the assignment pipeline and trigger it for them.
   *
   * Outage recovery: if the gap since the last successful sync exceeds the
   * normal cycle (i.e. the API was down or sync was paused), automatically
   * widen the lookback window to cover the gap and increase the per-cycle
   * limit so we catch up quickly. Without this, tickets that arrive during
   * downtime never get pipeline runs because they're already older than 24h
   * by the time sync resumes.
   *
   * @param {number} workspaceId
   * @param {Object} [opts]
   * @param {Date|null} [opts.prevSyncCompletedAt] - When the previous successful sync finished
   * @param {Date|null} [opts.cutoffOverride] - Force a specific lookback cutoff (used by weekly sync)
   * @param {number|null} [opts.maxPerCycleOverride] - Force a specific per-cycle limit
   */
  async _pollForUnassignedTickets(workspaceId, opts = {}) {
    const config = await assignmentRepository.getConfig(workspaceId);
    if (!config?.isEnabled || !config?.pollForUnassigned) {
      return { skipped: true, reason: 'assignment_polling_disabled', candidates: 0, triggered: 0 };
    }

    const NORMAL_LOOKBACK_HOURS = 24;
    const OUTAGE_THRESHOLD_MS = 30 * 60 * 1000; // 30 min between syncs counts as an outage
    const MAX_RECOVERY_LOOKBACK_DAYS = 7;       // never look further back than this
    const RECOVERY_MAX_PER_CYCLE = 50;          // boost catch-up rate during recovery

    let cutoff;
    let maxPerCycle = opts.maxPerCycleOverride ?? (config.pollMaxPerCycle || 5);
    let mode = 'normal';

    if (opts.cutoffOverride instanceof Date) {
      cutoff = opts.cutoffOverride;
      mode = 'forced';
    } else if (opts.prevSyncCompletedAt) {
      const gapMs = Date.now() - new Date(opts.prevSyncCompletedAt).getTime();
      if (gapMs > OUTAGE_THRESHOLD_MS) {
        // Recovery mode: cover the gap (plus a small buffer) but cap the lookback.
        const lookbackMs = Math.min(
          gapMs + 60 * 60 * 1000,
          MAX_RECOVERY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
        );
        cutoff = new Date(Date.now() - lookbackMs);
        maxPerCycle = Math.max(maxPerCycle, RECOVERY_MAX_PER_CYCLE);
        mode = 'recovery';
        logger.warn('Sync gap detected — entering pipeline recovery mode', {
          workspaceId,
          gapMinutes: Math.round(gapMs / 60000),
          lookbackHours: Math.round(lookbackMs / 3600000),
          maxPerCycle,
        });
      }
    }

    if (!cutoff) {
      cutoff = new Date(Date.now() - NORMAL_LOOKBACK_HOURS * 60 * 60 * 1000);
    }

    const { default: prisma } = await import('./prisma.js');
    const where = {
      workspaceId,
      assignedTechId: null,
      isNoise: false,
    };
    if (Array.isArray(opts.ticketIdsOverride) && opts.ticketIdsOverride.length > 0) {
      where.id = { in: opts.ticketIdsOverride };
    } else {
      where.createdAt = { gte: cutoff };
    }

    const candidateTickets = await prisma.ticket.findMany({
      where,
      select: {
        id: true,
        freshserviceTicketId: true,
        subject: true,
        pipelineRuns: {
          select: { id: true, status: true, decision: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.max(maxPerCycle * 3, maxPerCycle),
    });

    const unassignedTickets = candidateTickets
      .filter((ticket) => shouldTriggerAssignmentForLatestRun(ticket.pipelineRuns?.[0] || null))
      .slice(0, maxPerCycle)
      .map(({ pipelineRuns: _pipelineRuns, ...ticket }) => ticket);

    if (unassignedTickets.length === 0) {
      return { skipped: false, mode, candidates: candidateTickets.length, triggered: 0 };
    }

    logger.info('Assignment polling found unassigned tickets', {
      workspaceId,
      count: unassignedTickets.length,
      mode,
      cutoff: cutoff.toISOString(),
    });

    const waitForCompletion = opts.waitForCompletion !== false;
    const pipelinePromises = [];
    let triggered = 0;

    for (const ticket of unassignedTickets) {
      const run = assignmentPipelineService.runPipeline(ticket.id, workspaceId, 'poll')
        .catch((err) => {
          logger.warn('Assignment polling: pipeline failed for ticket', {
            ticketId: ticket.id,
            error: err.message,
          });
          return { skipped: true, reason: 'pipeline_failed', error: err.message };
        });
      triggered++;
      if (waitForCompletion) {
        await run;
      } else {
        pipelinePromises.push(run);
      }
    }

    if (!waitForCompletion && opts.settleAfterMs) {
      await Promise.race([
        Promise.allSettled(pipelinePromises),
        new Promise((resolve) => setTimeout(resolve, opts.settleAfterMs)),
      ]);
    }

    return {
      skipped: false,
      mode,
      async: !waitForCompletion,
      candidates: candidateTickets.length,
      triggered,
      ticketIds: unassignedTickets.map(t => t.id),
    };
  }

  /**
   * Recover orphaned syncs — runs whose decision was finalized
   * (auto_assigned / noise_dismissed) but whose FreshService write never
   * completed (syncStatus is null or 'pending'). This happens when the
   * Node.js process restarts between the decisionAt-set DB update and the
   * fire-and-forget freshServiceActionService.execute() call dispatched
   * from _executeRun.
   *
   * Without recovery, our DB shows the run as "completed / auto_assigned"
   * but the ticket stays unassigned in FS forever — confusing for admins
   * and breaks auto-assign reliability.
   *
   * Runs as part of every sync cycle. Conservative threshold (5 min)
   * avoids racing in-flight syncs that are just slow.
   */
  async _recoverOrphanedSyncs(workspaceId) {
    const orphans = await assignmentRepository.findOrphanedSyncRuns({
      workspaceId,
      olderThanMinutes: 5,
    });
    if (orphans.length === 0) return;

    logger.info('Orphan sync recovery: found stuck runs to retry', {
      workspaceId,
      count: orphans.length,
      runIds: orphans.map((r) => r.id),
    });

    const cfg = await assignmentRepository.getConfig(workspaceId);
    const dryRun = cfg?.dryRunMode ?? true;

    for (const orphan of orphans) {
      try {
        await freshServiceActionService.execute(orphan.id, workspaceId, dryRun);
        logger.info('Orphan sync recovery: re-executed FS sync', { runId: orphan.id, decision: orphan.decision });
      } catch (err) {
        logger.warn('Orphan sync recovery: retry failed', { runId: orphan.id, error: err.message });
      }
    }
  }

  /**
   * Post-sync reconciliation: verify non-terminal tickets still exist and are
   * active in FreshService. The list API silently excludes deleted and spam
   * tickets, so tickets trashed/spammed after initial sync become stale.
   *
   * Checks a batch of 200 tickets per cycle (sorted by updatedAt ASC so the
   * stalest tickets are verified first) with a 250ms inter-call delay to stay
   * under the 160 req/min API rate limit. fetchTicketSafe retries on 429.
   * Tickets confirmed OK get their updatedAt touched so they rotate to the
   * back of the queue.
   */
  async _reconcileTicketStatuses(workspaceId) {
    const { default: prisma } = await import('./prisma.js');
    const TERMINAL_STATUSES = ['Closed', 'Resolved', 'closed', 'resolved', 'Deleted', 'Spam', '4', '5'];
    const BATCH_SIZE = 200;

    const ticketsToCheck = await prisma.ticket.findMany({
      where: {
        workspaceId,
        status: { notIn: TERMINAL_STATUSES },
      },
      select: { id: true, freshserviceTicketId: true, subject: true, status: true },
      orderBy: { updatedAt: 'asc' },
      take: BATCH_SIZE,
    });

    if (ticketsToCheck.length === 0) return;

    let client;
    try {
      client = await this._initializeClient({
        priority: 'low',
        source: 'ticket-status-reconciliation',
      });
    } catch {
      return;
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let deletedCount = 0;
    let spamCount = 0;
    let verifiedCount = 0;
    let forbiddenCount = 0;
    for (const ticket of ticketsToCheck) {
      try {
        const fsTicket = await client.fetchTicketSafe(Number(ticket.freshserviceTicketId));
        await sleep(250);

        // 403 from FS — ticket exists but this API key can't see it (e.g.
        // moved to a workspace we're not authorized for). Don't mark as
        // Deleted; just bump updatedAt so it rotates to the back of the
        // reconciliation queue and we don't burn the FS budget on it
        // every 5 minutes.
        if (fsTicket === FORBIDDEN_TICKET) {
          await prisma.ticket.update({
            where: { id: ticket.id },
            data: { updatedAt: new Date() },
          });
          forbiddenCount++;
          continue;
        }

        const isGone = fsTicket === null;
        const isSoftDeleted = fsTicket?.deleted === true;
        const isSpam = fsTicket?.spam === true;

        if (isGone || isSoftDeleted || isSpam) {
          let newStatus;
          let reason;
          if (isGone) {
            newStatus = 'Deleted';
            reason = 'Ticket no longer exists in FreshService (hard deleted / 404)';
          } else if (isSoftDeleted) {
            newStatus = 'Deleted';
            reason = 'Ticket was trashed/soft-deleted in FreshService (deleted=true)';
          } else {
            newStatus = 'Spam';
            reason = 'Ticket was marked as spam in FreshService (spam=true)';
          }

          await prisma.ticket.update({
            where: { id: ticket.id },
            data: { status: newStatus, updatedAt: new Date() },
          });
          await ticketActivityRepository.create({
            ticketId: ticket.id,
            activityType: 'status_changed',
            performedBy: 'System',
            performedAt: new Date(),
            details: {
              oldStatus: ticket.status,
              newStatus,
              note: reason,
            },
          });

          // Clear queued assignment work for tickets that FreshService has
          // already removed/terminalized. Without this, a hard-deleted ticket
          // can sit in the business-hours queue until a user manually prunes.
          await prisma.assignmentPipelineRun.updateMany({
            where: {
              ticketId: ticket.id,
              status: 'queued',
            },
            data: {
              status: 'skipped_stale',
              errorMessage: reason,
            },
          });

          // Supersede any completed pending-review runs for this ticket.
          await prisma.assignmentPipelineRun.updateMany({
            where: {
              ticketId: ticket.id,
              status: 'completed',
              decision: 'pending_review',
            },
            data: {
              status: 'superseded',
              errorMessage: reason,
            },
          });

          if (isSpam) spamCount++;
          else deletedCount++;

          logger.info('Reconciliation: marked ticket as ' + newStatus, {
            ticketId: ticket.id,
            fsId: Number(ticket.freshserviceTicketId),
            subject: ticket.subject,
            reason: isGone ? 'hard_delete_404' : isSoftDeleted ? 'soft_delete_flag' : 'spam_flag',
          });
        } else {
          // Ticket still active — also sync responder drift. The 5-min
          // incremental sync filters by FS updated_since, so a ticket
          // assigned externally days ago (that hasn't received any other
          // update) never gets re-processed. Reconciliation is the only
          // path that touches these stale tickets, so it has to do more
          // than bump updatedAt — it has to repair assignedTechId drift
          // and auto-resolve any stuck pending pipeline runs.
          const fsResponderId = fsTicket.responder_id || null;
          let newAssignedTechId = null;
          if (fsResponderId) {
            const resolved = await this._resolveResponderTech(fsResponderId, workspaceId, client);
            if (resolved) {
              newAssignedTechId = resolved.techId;
            }
          }

          await prisma.ticket.update({
            where: { id: ticket.id },
            data: {
              updatedAt: new Date(),
              assignedTechId: newAssignedTechId,
            },
          });

          // Note: any pending_review pipeline run remains pending — the
          // existing "Decided > Manually in FreshService" sub-tab is built
          // exactly for this case (ticket has both a pending run AND an
          // external assignee). It surfaces the AI's recommendation
          // alongside who actually got the ticket, so the coordinator can
          // see the divergence.

          verifiedCount++;
        }
      } catch (err) {
        logger.warn('Reconciliation: error checking ticket in FreshService', {
          ticketId: ticket.id,
          fsId: Number(ticket.freshserviceTicketId),
          error: err.message,
        });
      }
    }

    if (deletedCount > 0 || spamCount > 0 || verifiedCount > 0 || forbiddenCount > 0) {
      logger.info('Ticket reconciliation complete', {
        workspaceId,
        checked: ticketsToCheck.length,
        deleted: deletedCount,
        spam: spamCount,
        verified: verifiedCount,
        forbidden: forbiddenCount,
      });
    }
  }
  /**
   * Backfill assignment episodes for historical tickets.
   * Fetches activities from FreshService and populates ticket_assignment_episodes.
   * @param {Object} options
   * @param {number} options.daysToSync - How many days of history to backfill (default 180)
   * @param {number} options.limit - Max tickets per batch (default 100)
   * @param {boolean} options.processAll - Process all batches until complete
   * @param {number} options.concurrency - Parallel FS API calls (default 3)
   * @param {number} options.workspaceId
   * @param {Function} options.onProgress - SSE progress callback
   */
  async backfillEpisodes(options = {}) {
    const daysToSync = options.daysToSync || 180;
    const limit = options.limit || 100;
    const processAll = options.processAll !== false;
    const concurrency = options.concurrency || 3;
    const wsId = options.workspaceId || 1;
    const onProgress = options.onProgress || null;

    try {
      logger.info(`Starting episode backfill (days=${daysToSync}, limit=${limit}, concurrency=${concurrency})`);
      const client = await this._initializeClient({
        priority: 'low',
        source: 'episode-backfill',
      });

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToSync);

      // Build tech name→id map
      const allTechs = await technicianRepository.getAll(wsId, { lite: true });
      const techNameMap = new Map();
      for (const t of allTechs) {
        techNameMap.set(t.name, t.id);
        if (t.email) techNameMap.set(t.email, t.id);
      }

      let totalProcessed = 0;
      let totalEpisodesCreated = 0;
      let totalErrors = 0;
      let batchNumber = 0;
      let hasMore = true;

      while (hasMore) {
        batchNumber++;

        // Fetch tickets that need episode backfill:
        // 1. Have been updated since cutoff
        // 2. Have at least one assignment in their history (assignedTechId not null OR firstAssignedAt exists)
        // 3. Don't yet have episodes (or have fewer episodes than expected)
        const tickets = await prisma.ticket.findMany({
          where: {
            workspaceId: wsId,
            createdAt: { gte: cutoffDate },
            OR: [
              { assignedTechId: { not: null } },
              { firstAssignedAt: { not: null } },
            ],
          },
          select: {
            id: true,
            freshserviceTicketId: true,
            _count: { select: { assignmentEpisodes: true } },
          },
          take: limit,
          skip: (batchNumber - 1) * limit,
          orderBy: { createdAt: 'desc' },
        });

        if (tickets.length === 0) {
          hasMore = false;
          break;
        }

        logger.info(`Episode backfill batch ${batchNumber}: ${tickets.length} tickets`);
        if (onProgress) onProgress({ batch: batchNumber, ticketCount: tickets.length, totalProcessed });

        for (const ticket of tickets) {
          try {
            const fsTicketId = Number(ticket.freshserviceTicketId);
            const activities = await client.fetchTicketActivities(fsTicketId);
            if (!activities || activities.length === 0) {
              totalProcessed++;
              continue;
            }

            const analysis = analyzeTicketActivities(activities);
            await this._writeThreadEntries(ticket.id, wsId, activities);

            if (analysis.episodes && analysis.episodes.length > 0) {
              await this._reconcileEpisodes(ticket.id, wsId, analysis, techNameMap);
              totalEpisodesCreated += analysis.episodes.length;
            }

            if (analysis.events && analysis.events.length > 0) {
              await this._writeEventActivities(ticket.id, analysis.events);
            }

            // Update ticket-level fields
            await prisma.ticket.update({
              where: { id: ticket.id },
              data: {
                isSelfPicked: analysis.currentIsSelfPicked,
                rejectionCount: analysis.rejectionCount || 0,
                assignedBy: analysis.assignedBy || null,
                firstAssignedAt: analysis.firstAssignedAt || undefined,
              },
            });

            totalProcessed++;
            // Rate limiting is handled centrally by FreshServiceClient.limiter
          } catch (error) {
            totalErrors++;
            logger.error(`Episode backfill failed for ticket ${ticket.freshserviceTicketId}:`, error);
          }
        }

        if (!processAll || tickets.length < limit) {
          hasMore = false;
        }
      }

      const summary = {
        ticketsProcessed: totalProcessed,
        episodesCreated: totalEpisodesCreated,
        errors: totalErrors,
        batches: batchNumber,
        daysToSync,
      };

      logger.info('Episode backfill complete', summary);
      return summary;
    } catch (error) {
      logger.error('Episode backfill failed:', error);
      throw error;
    }
  }
}

export default new SyncService();
