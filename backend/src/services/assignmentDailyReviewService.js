import Anthropic from '@anthropic-ai/sdk';
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import appConfig from '../config/index.js';
import availabilityService from './availabilityService.js';
import promptRepository from './promptRepository.js';
import ticketThreadRepository from './ticketThreadRepository.js';
import settingsRepository from './settingsRepository.js';
import {
  DAILY_REVIEW_OUTCOMES,
  DAILY_REVIEW_PRIMARY_TAGS,
  classifyDailyReviewCase,
  isClosedLikeStatus,
} from './dailyReviewDefinitions.js';
import { createFreshServiceClient } from '../integrations/freshservice.js';
import {
  transformTicketThreadEntries,
  transformTicketConversationEntries,
} from '../integrations/freshserviceTransformer.js';

const ACTIVE_STATUSES = ['running', 'collecting', 'analyzing'];
const STALE_RUNNING_MS = 30 * 60 * 1000;
const MAX_CASES_FOR_ANALYSIS = 15;
// Bumped from 6 → 12 so we can include both the conversation bodies and the
// most-recent state-change events for a single ticket. The summarizer below
// prioritizes notes/replies (real text) over activity-stream events.
const MAX_THREAD_EXCERPTS = 12;
// Cap conversation excerpt length; long replies eat tokens and rarely add
// signal beyond the first paragraph or two.
const THREAD_EXCERPT_CHARS = 600;
// Conversations endpoint can return hundreds of entries on long-running
// tickets; we only need recent context for daily review.
const MAX_CONVERSATIONS_PER_TICKET = 30;
const RECOMMENDATION_KIND_CONFIG = [
  { kind: 'prompt', field: 'promptRecommendations' },
  { kind: 'process', field: 'processRecommendations' },
  { kind: 'skill', field: 'skillRecommendations' },
];
const RECOMMENDATION_STATUSES = ['pending', 'approved', 'rejected', 'applied'];

class DailyReviewCancelledError extends Error {
  constructor(message = 'Daily review cancelled by user') {
    super(message);
    this.name = 'DailyReviewCancelledError';
  }
}

function reviewDateKey(dateStr) {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

function truncate(text, max = 280) {
  if (!text) return null;
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}...` : normalized;
}

// Strip HTML tags + collapse whitespace. FreshService conversation bodies
// are HTML; bodyText is a best-effort plaintext rendering but is sometimes
// missing on older entries, so we fall back to stripping bodyHtml ourselves.
function stripHtml(text) {
  if (!text) return null;
  return String(text)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>(\r?\n)?/gi, ' ')
    .replace(/<\/?(p|div|li|tr|td|th|h[1-6])[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function toPct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

function bucketCounts(items, getKey, limit = 5) {
  const counts = new Map();
  for (const item of items) {
    const key = getKey(item);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function addDaysUtc(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

class AssignmentDailyReviewService {
  constructor() {
    this.activeRunControllers = new Map();
  }

  _throwIfCancelled(signal) {
    if (signal?.aborted) {
      throw new DailyReviewCancelledError();
    }
  }

  _isCancellationError(error) {
    return error instanceof DailyReviewCancelledError
      || error?.name === 'DailyReviewCancelledError'
      || error?.name === 'APIUserAbortError';
  }

  _validateRecommendationStatus(status) {
    if (!RECOMMENDATION_STATUSES.includes(status)) {
      throw new Error(`Invalid recommendation status: ${status}`);
    }
  }

  _validateRecommendationKind(kind) {
    if (!['prompt', 'process', 'skill', 'all'].includes(kind)) {
      throw new Error(`Invalid recommendation kind: ${kind}`);
    }
  }

  _toRecommendationDto(row) {
    return {
      id: row.id,
      runId: row.runId,
      workspaceId: row.workspaceId,
      reviewDate: row.reviewDate,
      kind: row.kind,
      ordinal: row.ordinal,
      title: row.title,
      severity: row.severity,
      rationale: row.rationale,
      suggestedAction: row.suggestedAction,
      skillsAffected: toArray(row.skillsAffected),
      supportingTicketIds: toArray(row.supportingTicketIds),
      supportingFreshserviceTicketIds: toArray(row.supportingFreshserviceTicketIds),
      status: row.status,
      reviewNotes: row.reviewNotes,
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedAt,
      appliedBy: row.appliedBy,
      appliedAt: row.appliedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      run: row.run ? {
        id: row.run.id,
        reviewDate: row.run.reviewDate,
        triggeredBy: row.run.triggeredBy,
        status: row.run.status,
      } : undefined,
    };
  }

  _buildRecommendationCreateData(run, recommendationGroups = {}) {
    const reviewDate = run.reviewDate instanceof Date
      ? run.reviewDate
      : reviewDateKey(String(run.reviewDate).slice(0, 10));
    const rows = [];

    for (const { kind, field } of RECOMMENDATION_KIND_CONFIG) {
      const items = toArray(recommendationGroups[field] ?? run[field]);
      items.forEach((item, index) => {
        rows.push({
          workspaceId: run.workspaceId,
          runId: run.id,
          reviewDate,
          kind,
          ordinal: index,
          title: String(item.title || `${kind} recommendation ${index + 1}`),
          severity: String(item.severity || 'low'),
          rationale: String(item.rationale || ''),
          suggestedAction: String(item.suggestedAction || ''),
          skillsAffected: toArray(item.skillsAffected),
          supportingTicketIds: toArray(item.supportingTicketIds),
          supportingFreshserviceTicketIds: toArray(item.supportingFreshserviceTicketIds),
        });
      });
    }

    return rows;
  }

  async _replaceRecommendationsForRun(tx, run, recommendationGroups = {}) {
    const rows = this._buildRecommendationCreateData(run, recommendationGroups);
    await tx.assignmentDailyReviewRecommendation.deleteMany({ where: { runId: run.id } });
    if (rows.length > 0) {
      await tx.assignmentDailyReviewRecommendation.createMany({ data: rows });
    }
  }

  _groupRecommendations(rows = []) {
    const grouped = {
      promptRecommendations: [],
      processRecommendations: [],
      skillRecommendations: [],
      recommendationStatusCounts: {
        pending: 0,
        approved: 0,
        rejected: 0,
        applied: 0,
      },
    };

    for (const row of rows) {
      const dto = this._toRecommendationDto(row);
      if (dto.kind === 'prompt') grouped.promptRecommendations.push(dto);
      if (dto.kind === 'process') grouped.processRecommendations.push(dto);
      if (dto.kind === 'skill') grouped.skillRecommendations.push(dto);
      if (grouped.recommendationStatusCounts[dto.status] !== undefined) {
        grouped.recommendationStatusCounts[dto.status] += 1;
      }
    }

    return grouped;
  }

  async _ensureRecommendationRowsForRuns(workspaceId, runs = []) {
    for (const run of runs) {
      if (!run || run.workspaceId !== workspaceId) continue;
      const existingCount = await prisma.assignmentDailyReviewRecommendation.count({
        where: { runId: run.id },
      });
      if (existingCount > 0) continue;

      const rows = this._buildRecommendationCreateData(run);
      if (rows.length === 0) continue;

      await prisma.assignmentDailyReviewRecommendation.createMany({ data: rows });
    }
  }

  async _ensureRecommendationRowsForWorkspace(workspaceId, { startDate, endDate } = {}) {
    const where = {
      workspaceId,
      status: 'completed',
    };

    if (startDate || endDate) {
      where.reviewDate = {};
      if (startDate) where.reviewDate.gte = reviewDateKey(startDate);
      if (endDate) where.reviewDate.lte = reviewDateKey(endDate);
    }

    const runs = await prisma.assignmentDailyReviewRun.findMany({
      where,
      select: {
        id: true,
        workspaceId: true,
        reviewDate: true,
        promptRecommendations: true,
        processRecommendations: true,
        skillRecommendations: true,
      },
      orderBy: { reviewDate: 'desc' },
      take: 500,
    });

    await this._ensureRecommendationRowsForRuns(workspaceId, runs);
  }

  async _markStaleRunsFailed() {
    const staleBefore = new Date(Date.now() - STALE_RUNNING_MS);
    await prisma.assignmentDailyReviewRun.updateMany({
      where: {
        status: { in: ACTIVE_STATUSES },
        updatedAt: { lt: staleBefore },
      },
      data: {
        status: 'failed',
        errorMessage: 'Marked stale after 30 minutes without progress',
        completedAt: new Date(),
      },
    });
  }

  async _getWorkspaceContext(workspaceId) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        id: true,
        name: true,
        defaultTimezone: true,
      },
    });

    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    const config = await prisma.assignmentConfig.findUnique({
      where: { workspaceId },
      select: {
        llmModel: true,
        dailyReviewEnabled: true,
        dailyReviewRunHour: true,
        dailyReviewRunMinute: true,
        dailyReviewLookbackDays: true,
      },
    });

    return {
      workspace,
      config,
      timezone: workspace.defaultTimezone || 'America/Los_Angeles',
    };
  }

  async _getBusinessDayRange(workspaceId, dateStr, timezone) {
    const reference = new Date(`${dateStr}T12:00:00.000Z`);
    const zoned = toZonedTime(reference, timezone);
    const dayOfWeek = zoned.getDay();
    const hours = await availabilityService.getBusinessHours(workspaceId);
    const dayConfig = hours.find((entry) => entry.dayOfWeek === dayOfWeek && entry.isEnabled);

    const startTime = dayConfig?.startTime || '00:00';
    const endTime = dayConfig?.endTime || '23:59';
    const startIso = formatInTimeZone(reference, timezone, `yyyy-MM-dd'T'${startTime}:00XXX`);
    const endSuffix = endTime === '23:59' ? ':59.999' : ':00.000';
    const endIso = formatInTimeZone(reference, timezone, `yyyy-MM-dd'T'${endTime}${endSuffix}XXX`);

    return {
      start: new Date(startIso),
      end: new Date(endIso),
      startTime,
      endTime,
      isBusinessDay: !!dayConfig,
      localDate: dateStr,
    };
  }

  async _hydrateMissingThreads(workspaceId, tickets = [], options = {}) {
    this._throwIfCancelled(options.signal);
    const forceRefresh = options.forceRefresh === true;

    // We now hydrate two FreshService endpoints per ticket:
    //   - /tickets/:id/activities  → state-change events (assignments, status, workflow runs)
    //   - /tickets/:id/conversations → reply + note BODIES (the actual text)
    // A ticket needs hydration if either source is missing locally. The
    // forceRefresh flag bypasses the cache check so an admin can pull fresh
    // data from FS even when something is already in our DB.
    const ticketsForActivities = forceRefresh
      ? tickets.slice()
      : tickets.filter((t) => (t?.threadCounts?.activities ?? t?._count?.threadEntries ?? 0) === 0);
    const ticketsForConversations = forceRefresh
      ? tickets.slice()
      : tickets.filter((t) => (t?.threadCounts?.conversations ?? 0) === 0);

    const emitProgress = (payload) => {
      try { options.onProgress?.(payload); } catch { /* ignore progress errors */ }
    };

    if (ticketsForActivities.length === 0 && ticketsForConversations.length === 0) {
      emitProgress({
        processed: 0,
        total: 0,
        hydratedActivities: 0,
        hydratedConversations: 0,
        failed: 0,
        message: 'Thread history (activities + conversations) already cached locally for every ticket in this review.',
      });
      return {
        hydratedActivities: 0,
        hydratedConversations: 0,
        activitiesFetched: 0,
        conversationsFetched: 0,
        failed: 0,
        warnings: [],
        perTicket: [],
      };
    }

    const fsConfig = await settingsRepository.getFreshServiceConfigForWorkspace(workspaceId);
    if (!fsConfig?.domain || !fsConfig?.apiKey) {
      return {
        hydratedActivities: 0,
        hydratedConversations: 0,
        activitiesFetched: 0,
        conversationsFetched: 0,
        failed: 0,
        warnings: ['FreshService is not configured, so missing ticket threads could not be hydrated.'],
        perTicket: [],
      };
    }

    const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey);
    const ticketIdsToProcess = Array.from(new Set([
      ...ticketsForActivities.map((t) => t.id),
      ...ticketsForConversations.map((t) => t.id),
    ]));
    const ticketById = new Map(tickets.map((t) => [t.id, t]));

    let hydratedActivities = 0;
    let hydratedConversations = 0;
    let activitiesFetched = 0;
    let conversationsFetched = 0;
    let failed = 0;
    const warnings = [];
    const perTicket = [];

    emitProgress({
      processed: 0,
      total: ticketIdsToProcess.length,
      hydratedActivities,
      hydratedConversations,
      failed,
      message: `Hydrating FreshService threads for ${ticketIdsToProcess.length} ticket(s) (activities + conversations${forceRefresh ? ', forced refresh' : ''}).`,
    });

    for (let index = 0; index < ticketIdsToProcess.length; index += 1) {
      this._throwIfCancelled(options.signal);
      const ticketInternalId = ticketIdsToProcess[index];
      const ticket = ticketById.get(ticketInternalId);
      if (!ticket) continue;
      const fsTicketId = Number(ticket.freshserviceTicketId);
      const diag = {
        ticketId: ticket.id,
        freshserviceTicketId: fsTicketId,
        activitiesFetched: 0,
        conversationsFetched: 0,
        activitiesError: null,
        conversationsError: null,
      };
      let anyFailure = false;

      const wantActivities = forceRefresh || ticketsForActivities.some((t) => t.id === ticket.id);
      const wantConversations = forceRefresh || ticketsForConversations.some((t) => t.id === ticket.id);

      if (wantActivities) {
        try {
          const activities = await client.fetchTicketActivities(fsTicketId);
          this._throwIfCancelled(options.signal);
          if (activities?.length) {
            const entries = transformTicketThreadEntries(activities, { ticketId: ticket.id, workspaceId });
            await ticketThreadRepository.bulkUpsert(entries);
            hydratedActivities += 1;
            activitiesFetched += entries.length;
            diag.activitiesFetched = entries.length;
          }
        } catch (error) {
          if (this._isCancellationError(error)) throw error;
          anyFailure = true;
          diag.activitiesError = error.message;
          warnings.push(`Could not hydrate ACTIVITIES for ticket #${fsTicketId}: ${error.message}`);
        }
      }

      if (wantConversations) {
        try {
          const conversations = await client.fetchTicketConversations(fsTicketId, {
            maxEntries: MAX_CONVERSATIONS_PER_TICKET,
          });
          this._throwIfCancelled(options.signal);
          if (conversations?.length) {
            const entries = transformTicketConversationEntries(conversations, {
              ticketId: ticket.id,
              workspaceId,
            });
            await ticketThreadRepository.bulkUpsert(entries);
            hydratedConversations += 1;
            conversationsFetched += entries.length;
            diag.conversationsFetched = entries.length;
          }
        } catch (error) {
          if (this._isCancellationError(error)) throw error;
          anyFailure = true;
          diag.conversationsError = error.message;
          warnings.push(`Could not hydrate CONVERSATIONS for ticket #${fsTicketId}: ${error.message}`);
        }
      }

      if (anyFailure) failed += 1;
      perTicket.push(diag);

      const processed = index + 1;
      if (processed === 1 || processed === ticketIdsToProcess.length || processed % 5 === 0) {
        emitProgress({
          processed,
          total: ticketIdsToProcess.length,
          hydratedActivities,
          hydratedConversations,
          failed,
          message: `Hydrating FreshService threads (${processed}/${ticketIdsToProcess.length}); pulled ${activitiesFetched} activity row(s) + ${conversationsFetched} conversation row(s) so far.`,
        });
      }
    }

    return {
      hydratedActivities,
      hydratedConversations,
      activitiesFetched,
      conversationsFetched,
      failed,
      warnings,
      perTicket,
      forceRefresh,
    };
  }

  // Build a per-ticket excerpt list for the LLM. Real conversation bodies
  // (notes / replies) carry the most signal, so we return them first and
  // fill the remaining slots with state-change activity-stream entries for
  // chronological context. Each entry's text is normalized (HTML stripped)
  // and truncated to keep token usage bounded.
  _buildThreadExcerptMap(entries = []) {
    const byTicketId = new Map();
    const buckets = new Map();
    for (const entry of entries) {
      const list = buckets.get(entry.ticketId) || { conversations: [], events: [] };
      const cleanedBody = stripHtml(entry.bodyText || entry.bodyHtml || '');
      const excerptText = truncate(cleanedBody || entry.content || entry.title, THREAD_EXCERPT_CHARS);
      if (!excerptText) {
        buckets.set(entry.ticketId, list);
        continue;
      }
      const projected = {
        id: entry.id,
        source: entry.source,
        eventType: entry.eventType,
        visibility: entry.visibility,
        actorName: entry.actorName || null,
        occurredAt: entry.occurredAt,
        excerpt: excerptText,
      };
      if (entry.source === 'freshservice_conversation') {
        list.conversations.push(projected);
      } else {
        list.events.push(projected);
      }
      buckets.set(entry.ticketId, list);
    }

    for (const [ticketId, list] of buckets.entries()) {
      // Sort each bucket newest first within itself so the freshest reply +
      // freshest state-change event are guaranteed to land in the LLM's
      // context window.
      list.conversations.sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
      list.events.sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
      const conversationSlots = Math.min(list.conversations.length, MAX_THREAD_EXCERPTS);
      const eventSlots = Math.max(0, MAX_THREAD_EXCERPTS - conversationSlots);
      const merged = [
        ...list.conversations.slice(0, conversationSlots),
        ...list.events.slice(0, eventSlots),
      ];
      // Re-sort merged result chronologically (oldest → newest) so the
      // model can read the thread in narrative order.
      merged.sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));
      byTicketId.set(ticketId, merged);
    }
    return byTicketId;
  }

  _buildAssignmentActionMap(assignments = []) {
    const byTicketId = new Map();
    for (const item of assignments) {
      if (!byTicketId.has(item.ticketId)) byTicketId.set(item.ticketId, []);
      byTicketId.get(item.ticketId).push(item);
    }
    return byTicketId;
  }

  _buildEpisodeMap(episodes = []) {
    const byTicketId = new Map();
    for (const item of episodes) {
      if (!byTicketId.has(item.ticketId)) byTicketId.set(item.ticketId, []);
      byTicketId.get(item.ticketId).push(item);
    }
    return byTicketId;
  }

  _summarizeCase(caseItem) {
    const parts = [];
    if (caseItem.category) parts.push(`Category: ${caseItem.category}`);
    if (caseItem.topRecommendation?.techName) parts.push(`Top rec: ${caseItem.topRecommendation.techName}`);
    if (caseItem.finalAssignee?.name) parts.push(`Final assignee: ${caseItem.finalAssignee.name}`);
    if (caseItem.overrideReason) parts.push(`Override: ${truncate(caseItem.overrideReason, 180)}`);
    if (caseItem.decisionNote) parts.push(`Decision note: ${truncate(caseItem.decisionNote, 180)}`);
    if (caseItem.threadExcerpts?.length) {
      parts.push(`Thread: ${caseItem.threadExcerpts.map((excerpt) => excerpt.excerpt).join(' | ')}`);
    }
    return parts.join(' | ');
  }

  async collectDailyDataset(workspaceId, reviewDate, options = {}) {
    const emitProgress = (message, extra = {}) => {
      try {
        options.onProgress?.({
          phase: 'collecting',
          message,
          ...extra,
        });
      } catch {
        /* ignore progress errors */
      }
    };
    const throwIfCancelled = () => this._throwIfCancelled(options.signal);

    const { workspace, config, timezone } = await this._getWorkspaceContext(workspaceId);
    const dateStr = reviewDate || formatInTimeZone(new Date(), timezone, 'yyyy-MM-dd');
    const range = await this._getBusinessDayRange(workspaceId, dateStr, timezone);
    throwIfCancelled();

    emitProgress(
      `Reviewing ${workspace.name} for ${dateStr} in ${timezone} (${range.startTime}-${range.endTime}).`,
      {
        percent: 8,
        stats: {
          workspaceName: workspace.name,
          reviewDate: dateStr,
          timezone,
          rangeStart: range.start.toISOString(),
          rangeEnd: range.end.toISOString(),
        },
      },
    );

    const runWhere = {
      workspaceId,
      status: { notIn: ['skipped_stale', 'superseded'] },
      OR: [
        { createdAt: { gte: range.start, lte: range.end } },
        { decidedAt: { gte: range.start, lte: range.end } },
      ],
    };

    emitProgress('Loading pipeline runs from the review window...', {
      percent: 18,
    });

    const runs = await prisma.assignmentPipelineRun.findMany({
      where: runWhere,
      include: {
        assignedTech: { select: { id: true, name: true, email: true } },
        promptVersion: { select: { id: true, version: true } },
        ticket: {
          select: {
            id: true,
            freshserviceTicketId: true,
            subject: true,
            category: true,
            ticketCategory: true,
            status: true,
            priority: true,
            createdAt: true,
            updatedAt: true,
            resolvedAt: true,
            closedAt: true,
            rejectionCount: true,
            assignedTechId: true,
            assignedTech: { select: { id: true, name: true, email: true } },
            requester: { select: { id: true, name: true, email: true } },
            _count: { select: { threadEntries: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    throwIfCancelled();

    emitProgress('Loading direct FreshService assignments that bypassed the pipeline...', {
      percent: 26,
    });

    const bypassTickets = await prisma.ticket.findMany({
      where: {
        workspaceId,
        createdAt: { gte: range.start, lte: range.end },
        assignedTechId: { not: null },
        pipelineRuns: {
          none: {
            OR: [
              { createdAt: { gte: range.start, lte: range.end } },
              { decidedAt: { gte: range.start, lte: range.end } },
            ],
          },
        },
      },
      select: {
        id: true,
        freshserviceTicketId: true,
        subject: true,
        category: true,
        ticketCategory: true,
        status: true,
        priority: true,
        createdAt: true,
        updatedAt: true,
        resolvedAt: true,
        closedAt: true,
        rejectionCount: true,
        assignedTechId: true,
        assignedTech: { select: { id: true, name: true, email: true } },
        requester: { select: { id: true, name: true, email: true } },
        _count: { select: { threadEntries: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    throwIfCancelled();

    emitProgress(
      `Loaded ${runs.length} pipeline run(s) and ${bypassTickets.length} direct FreshService assignment(s).`,
      {
        percent: 34,
        stats: {
          pipelineRuns: runs.length,
          bypassedTickets: bypassTickets.length,
        },
      },
    );

    const ticketsForHydration = [
      ...runs.map((run) => run.ticket).filter(Boolean),
      ...bypassTickets,
    ];

    // Per-source thread counts for every candidate ticket so we can decide
    // exactly what's missing (activities vs conversations) without fetching
    // both endpoints unconditionally. groupBy on source keeps this to a
    // single query regardless of cohort size.
    const ticketIdSet = ticketsForHydration.map((t) => t.id);
    const threadCountsRows = ticketIdSet.length > 0
      ? await prisma.ticketThreadEntry.groupBy({
        by: ['ticketId', 'source'],
        where: { workspaceId, ticketId: { in: ticketIdSet } },
        _count: { _all: true },
      })
      : [];
    const threadCountsByTicket = new Map();
    for (const row of threadCountsRows) {
      const current = threadCountsByTicket.get(row.ticketId) || { activities: 0, conversations: 0 };
      if (row.source === 'freshservice_conversation') {
        current.conversations = row._count._all;
      } else {
        current.activities = row._count._all;
      }
      threadCountsByTicket.set(row.ticketId, current);
    }
    for (const t of ticketsForHydration) {
      t.threadCounts = threadCountsByTicket.get(t.id) || { activities: 0, conversations: 0 };
    }

    const missingActivities = ticketsForHydration.filter((t) => t.threadCounts.activities === 0).length;
    const missingConversations = ticketsForHydration.filter((t) => t.threadCounts.conversations === 0).length;
    const cachedFully = ticketsForHydration.length - Math.max(missingActivities, missingConversations);
    const forceRefresh = options.forceRefreshThreads === true;
    emitProgress(
      forceRefresh
        ? `Force-refreshing thread history for all ${ticketsForHydration.length} ticket(s) from FreshService...`
        : (missingActivities + missingConversations > 0)
          ? `Local cache: ${cachedFully}/${ticketsForHydration.length} ticket(s) fully cached. Pulling ${missingActivities} missing activity stream(s) and ${missingConversations} missing conversation stream(s) from FreshService.`
          : `Local cache: all ${ticketsForHydration.length} ticket(s) already have both activities and conversations cached. No FreshService calls needed.`,
      {
        percent: 42,
        stats: {
          candidateTickets: ticketsForHydration.length,
          ticketsFullyCached: cachedFully,
          ticketsMissingActivities: missingActivities,
          ticketsMissingConversations: missingConversations,
        },
      },
    );

    const hydration = await this._hydrateMissingThreads(workspaceId, ticketsForHydration, {
      signal: options.signal,
      forceRefresh,
      onProgress: ({ processed, total, hydratedActivities, hydratedConversations, failed, message }) => {
        emitProgress(message, {
          percent: total > 0 ? Math.min(68, 42 + Math.floor((processed / total) * 26)) : 68,
          stats: {
            ticketsBeingHydrated: total,
            threadHydrationProcessed: processed,
            ticketsHydratedActivities: hydratedActivities,
            ticketsHydratedConversations: hydratedConversations,
            threadHydrationFailures: failed,
          },
        });
      },
    });
    throwIfCancelled();

    emitProgress(
      `Thread hydration complete: pulled ${hydration.activitiesFetched} activity row(s) + ${hydration.conversationsFetched} conversation row(s) across ${hydration.hydratedActivities + hydration.hydratedConversations} ticket-source pair(s); ${hydration.failed} ticket(s) had errors.`,
      {
        percent: 70,
        stats: {
          activitiesFetched: hydration.activitiesFetched,
          conversationsFetched: hydration.conversationsFetched,
          ticketsHydratedActivities: hydration.hydratedActivities,
          ticketsHydratedConversations: hydration.hydratedConversations,
          threadHydrationWarnings: hydration.warnings.length,
        },
      },
    );

    const ticketIds = Array.from(new Set(ticketsForHydration.map((ticket) => ticket.id)));
    emitProgress('Loading assignment episodes, assignment actions, and thread excerpts...', {
      percent: 78,
      stats: {
        ticketIds: ticketIds.length,
      },
    });
    // Defence-in-depth: every related-data query is scoped by workspaceId
    // even though the ticketId set is already workspace-scoped. This protects
    // the analysis input from any pre-existing cross-workspace data integrity
    // issues (e.g. an assignment episode whose ticket id was reused).
    const [episodes, assignments, threadEntries, competencyCategories] = await Promise.all([
      prisma.ticketAssignmentEpisode.findMany({
        where: { workspaceId, ticketId: { in: ticketIds } },
        include: { technician: { select: { id: true, name: true, workspaceId: true } } },
        orderBy: { startedAt: 'asc' },
      }),
      prisma.ticketAssignment.findMany({
        where: {
          workspaceId,
          ticketId: { in: ticketIds },
          createdAt: { lte: range.end },
        },
        include: { assignedTo: { select: { id: true, name: true, workspaceId: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      ticketThreadRepository.listForTickets(ticketIds, { end: range.end, workspaceId }),
      prisma.competencyCategory.findMany({
        where: { workspaceId, isActive: true },
        select: { id: true, name: true, description: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    throwIfCancelled();

    emitProgress(
      `Loaded ${episodes.length} assignment episode(s), ${assignments.length} assignment action(s), and ${threadEntries.length} thread excerpt record(s).`,
      {
        percent: 88,
        stats: {
          episodes: episodes.length,
          assignmentActions: assignments.length,
          threadEntries: threadEntries.length,
          competencyCategories: competencyCategories.length,
        },
      },
    );

    const episodesByTicket = this._buildEpisodeMap(episodes);
    const assignmentsByTicket = this._buildAssignmentActionMap(assignments);
    const threadByTicket = this._buildThreadExcerptMap(threadEntries);

    const runCases = runs.map((run) => {
      const recs = run.recommendation?.recommendations || [];
      const ticket = run.ticket;
      const ticketEpisodes = episodesByTicket.get(ticket.id) || [];
      const hasRebound = ticketEpisodes.some((episode) => episode.endMethod === 'rejected')
        || ['rebound', 'rebound_exhausted'].includes(run.triggerSource);
      const classification = classifyDailyReviewCase({
        finalTechId: ticket.assignedTechId,
        recommendationPoolIds: recs.map((rec) => rec.techId),
        topRecommendationId: recs[0]?.techId || null,
        hasRebound,
        isPendingReview: run.decision === 'pending_review',
      });

      const tags = [...classification.tags];
      if (!isClosedLikeStatus(ticket.status)) {
        tags.push(DAILY_REVIEW_PRIMARY_TAGS.stillOpen);
      }

      return {
        type: 'pipeline',
        runId: run.id,
        ticketId: ticket.id,
        freshserviceTicketId: ticket.freshserviceTicketId ? Number(ticket.freshserviceTicketId) : null,
        subject: ticket.subject || '(no subject)',
        category: ticket.ticketCategory || ticket.category || null,
        priority: ticket.priority,
        status: ticket.status,
        triggerSource: run.triggerSource,
        decision: run.decision,
        outcome: classification.outcome,
        primaryTag: classification.primaryTag,
        tags: Array.from(new Set(tags)),
        topRecommendation: recs[0]
          ? {
            techId: recs[0].techId,
            techName: recs[0].techName || null,
            score: recs[0].score ?? null,
          }
          : null,
        recommendationPool: recs.slice(0, 5).map((rec) => ({
          techId: rec.techId,
          techName: rec.techName || null,
          score: rec.score ?? null,
        })),
        pipelineAssignedTech: run.assignedTech
          ? { id: run.assignedTech.id, name: run.assignedTech.name }
          : null,
        finalAssignee: ticket.assignedTech
          ? { id: ticket.assignedTech.id, name: ticket.assignedTech.name }
          : null,
        changedFromTopRecommendation: !!(
          recs[0]?.techId
          && ticket.assignedTechId
          && recs[0].techId !== ticket.assignedTechId
        ),
        handledInFreshService: run.decision === 'pending_review' && !!ticket.assignedTechId,
        overrideReason: run.overrideReason || null,
        decisionNote: run.decisionNote || null,
        decidedAt: run.decidedAt,
        decidedByEmail: run.decidedByEmail,
        promptVersion: run.promptVersion
          ? { id: run.promptVersion.id, version: run.promptVersion.version }
          : null,
        rejectionCount: ticket.rejectionCount || 0,
        ticketCreatedAt: ticket.createdAt,
        resolvedAt: ticket.resolvedAt,
        closedAt: ticket.closedAt,
        requester: ticket.requester,
        episodeSummary: ticketEpisodes.map((episode) => ({
          technicianId: episode.technicianId,
          technicianName: episode.technician?.name || null,
          startedAt: episode.startedAt,
          endedAt: episode.endedAt,
          startMethod: episode.startMethod,
          endMethod: episode.endMethod,
          endActorName: episode.endActorName,
        })),
        assignmentActions: (assignmentsByTicket.get(ticket.id) || []).slice(-5).map((item) => ({
          id: item.id,
          source: item.source,
          assignedToId: item.assignedToId,
          assignedToName: item.assignedTo?.name || null,
          assignedByEmail: item.assignedByEmail,
          createdAt: item.createdAt,
          note: item.note,
        })),
        threadExcerpts: threadByTicket.get(ticket.id) || [],
      };
    });

    const bypassCases = bypassTickets.map((ticket) => {
      const tags = [DAILY_REVIEW_PRIMARY_TAGS.pipelineBypassed];
      if (!isClosedLikeStatus(ticket.status)) tags.push(DAILY_REVIEW_PRIMARY_TAGS.stillOpen);
      return {
        type: 'pipeline_bypass',
        runId: null,
        ticketId: ticket.id,
        freshserviceTicketId: ticket.freshserviceTicketId ? Number(ticket.freshserviceTicketId) : null,
        subject: ticket.subject || '(no subject)',
        category: ticket.ticketCategory || ticket.category || null,
        priority: ticket.priority,
        status: ticket.status,
        triggerSource: 'freshservice_only',
        decision: 'pipeline_bypassed',
        outcome: DAILY_REVIEW_OUTCOMES.failure,
        primaryTag: DAILY_REVIEW_PRIMARY_TAGS.pipelineBypassed,
        tags,
        topRecommendation: null,
        recommendationPool: [],
        pipelineAssignedTech: null,
        finalAssignee: ticket.assignedTech
          ? { id: ticket.assignedTech.id, name: ticket.assignedTech.name }
          : null,
        changedFromTopRecommendation: false,
        handledInFreshService: true,
        overrideReason: null,
        decisionNote: null,
        decidedAt: null,
        decidedByEmail: null,
        promptVersion: null,
        rejectionCount: ticket.rejectionCount || 0,
        ticketCreatedAt: ticket.createdAt,
        resolvedAt: ticket.resolvedAt,
        closedAt: ticket.closedAt,
        requester: ticket.requester,
        episodeSummary: (episodesByTicket.get(ticket.id) || []).map((episode) => ({
          technicianId: episode.technicianId,
          technicianName: episode.technician?.name || null,
          startedAt: episode.startedAt,
          endedAt: episode.endedAt,
          startMethod: episode.startMethod,
          endMethod: episode.endMethod,
          endActorName: episode.endActorName,
        })),
        assignmentActions: (assignmentsByTicket.get(ticket.id) || []).slice(-5).map((item) => ({
          id: item.id,
          source: item.source,
          assignedToId: item.assignedToId,
          assignedToName: item.assignedTo?.name || null,
          assignedByEmail: item.assignedByEmail,
          createdAt: item.createdAt,
          note: item.note,
        })),
        threadExcerpts: threadByTicket.get(ticket.id) || [],
      };
    });

    const allCases = [...runCases, ...bypassCases];
    const pipelineCases = runCases.filter((item) => item.type === 'pipeline');
    const consideredCases = pipelineCases.filter((item) => item.primaryTag !== DAILY_REVIEW_PRIMARY_TAGS.awaitingReview);
    const uniqueReviewedTicketIds = Array.from(new Set(allCases.map((item) => item.ticketId)));
    const uniqueReboundedTicketIds = Array.from(new Set(
      allCases
        .filter((item) => item.tags.includes(DAILY_REVIEW_PRIMARY_TAGS.rebounded))
        .map((item) => item.ticketId),
    ));
    throwIfCancelled();

    emitProgress(`Built ${allCases.length} review case(s); summarizing daily metrics...`, {
      percent: 95,
      stats: {
        totalCases: allCases.length,
        pipelineCases: pipelineCases.length,
        consideredCases: consideredCases.length,
      },
    });

    const summaryMetrics = {
      reviewDate: dateStr,
      workspaceName: workspace.name,
      timezone,
      reviewWindow: {
        start: range.start.toISOString(),
        end: range.end.toISOString(),
        localDate: range.localDate,
        startTime: range.startTime,
        endTime: range.endTime,
        isBusinessDay: range.isBusinessDay,
      },
      definitions: {
        cohortAnchor: 'Tickets with assignment pipeline activity during the selected workspace business day, plus tickets created that day that were assigned directly in FreshService without a pipeline run.',
        success: 'Top recommendation stayed the final assignee by review time and the ticket did not rebound.',
        partialSuccess: 'The final assignee was in the recommendation pool, but not the top recommendation.',
        failure: 'The final assignee was outside the recommendation pool, the ticket rebounded, or the pipeline was bypassed.',
        unresolved: 'The ticket is still awaiting review, missing a recommendation, or lacks enough final assignment evidence yet.',
        rebounds: 'Unique tickets that rebounded at least once during the review cohort. Multiple rebounds on the same ticket count once.',
      },
      totals: {
        pipelineRuns: runs.length,
        bypassedTickets: bypassCases.length,
        totalTicketsReviewed: allCases.length,
        distinctTicketsReviewed: uniqueReviewedTicketIds.length,
        autoAssigned: pipelineCases.filter((item) => item.decision === 'auto_assigned').length,
        approved: pipelineCases.filter((item) => item.decision === 'approved').length,
        modified: pipelineCases.filter((item) => item.decision === 'modified').length,
        rejected: pipelineCases.filter((item) => item.decision === 'rejected').length,
        pendingReview: pipelineCases.filter((item) => item.decision === 'pending_review').length,
        handledInFreshService: pipelineCases.filter((item) => item.handledInFreshService).length,
        success: consideredCases.filter((item) => item.outcome === DAILY_REVIEW_OUTCOMES.success).length,
        partialSuccess: consideredCases.filter((item) => item.outcome === DAILY_REVIEW_OUTCOMES.partialSuccess).length,
        failure: allCases.filter((item) => item.outcome === DAILY_REVIEW_OUTCOMES.failure).length,
        unresolved: allCases.filter((item) => item.outcome === DAILY_REVIEW_OUTCOMES.unresolved).length,
        rebounds: uniqueReboundedTicketIds.length,
        stillOpen: allCases.filter((item) => !isClosedLikeStatus(item.status)).length,
        resolvedOrClosed: allCases.filter((item) => isClosedLikeStatus(item.status)).length,
      },
      rates: {},
      topCategories: bucketCounts(
        allCases.filter((item) =>
          item.outcome === DAILY_REVIEW_OUTCOMES.failure
          || item.decision === 'modified'
          || item.decision === 'rejected',
        ),
        (item) => item.category || 'Uncategorized',
      ),
      topTechnicians: bucketCounts(
        allCases.filter((item) => item.changedFromTopRecommendation || item.tags.includes(DAILY_REVIEW_PRIMARY_TAGS.rebounded)),
        (item) => item.finalAssignee?.name || item.pipelineAssignedTech?.name || null,
      ),
      competencyCategories: competencyCategories.map((item) => item.name),
    };

    const denominator = Math.max(consideredCases.length, 1);
    summaryMetrics.rates = {
      successRate: toPct(summaryMetrics.totals.success, denominator),
      partialSuccessRate: toPct(summaryMetrics.totals.partialSuccess, denominator),
      failureRate: toPct(summaryMetrics.totals.failure, allCases.length || 1),
      rejectionRate: toPct(
        pipelineCases.filter((item) => item.decision === 'rejected').length,
        Math.max(pipelineCases.length, 1),
      ),
      reboundRate: toPct(summaryMetrics.totals.rebounds, Math.max(uniqueReviewedTicketIds.length, 1)),
    };

    const warnings = [...hydration.warnings];
    if (hydration.hydratedActivities > 0 || hydration.hydratedConversations > 0) {
      warnings.push(`Hydrated FreshService threads during this run: ${hydration.activitiesFetched} activity row(s) across ${hydration.hydratedActivities} ticket(s), ${hydration.conversationsFetched} conversation row(s) across ${hydration.hydratedConversations} ticket(s).`);
    }

    // Per-source coverage of what the LLM will actually see. These numbers
    // are surfaced in the run detail so the admin can verify the analysis
    // had real conversation context to work with — not just state-change
    // events from the activity log.
    const conversationEntries = threadEntries.filter((e) => e.source === 'freshservice_conversation');
    const activityEntries = threadEntries.filter((e) => e.source !== 'freshservice_conversation');
    const ticketsWithConversations = new Set(conversationEntries.map((e) => e.ticketId)).size;
    const ticketsWithActivities = new Set(activityEntries.map((e) => e.ticketId)).size;

    const collectionDiagnostics = {
      candidateTickets: ticketsForHydration.length,
      ticketsWithLocalActivitiesBeforeRun: ticketsForHydration.length - missingActivities,
      ticketsWithLocalConversationsBeforeRun: ticketsForHydration.length - missingConversations,
      ticketsRequestingActivities: missingActivities,
      ticketsRequestingConversations: missingConversations,
      ticketsHydratedActivities: hydration.hydratedActivities,
      ticketsHydratedConversations: hydration.hydratedConversations,
      activityRowsFetched: hydration.activitiesFetched,
      conversationRowsFetched: hydration.conversationsFetched,
      hydrationFailures: hydration.failed,
      forceRefresh: hydration.forceRefresh === true,
      threadEntriesAvailable: threadEntries.length,
      conversationEntriesAvailable: conversationEntries.length,
      activityEntriesAvailable: activityEntries.length,
      ticketsWithConversations,
      ticketsWithActivities,
      ticketsWithNoThreadContext: Math.max(0, ticketsForHydration.length - new Set(threadEntries.map((e) => e.ticketId)).size),
      perTicket: hydration.perTicket || [],
      episodes: episodes.length,
      assignmentActions: assignments.length,
      pipelineRuns: runs.length,
      bypassTickets: bypassTickets.length,
    };

    emitProgress(`Collection complete: ${summaryMetrics.totals.totalTicketsReviewed} ticket(s) ready. ${ticketsWithConversations}/${ticketsForHydration.length} have conversation bodies for the LLM to read.`, {
      percent: 100,
      stats: {
        totalTicketsReviewed: summaryMetrics.totals.totalTicketsReviewed,
        success: summaryMetrics.totals.success,
        failure: summaryMetrics.totals.failure,
        unresolved: summaryMetrics.totals.unresolved,
        ticketsWithConversations,
        ticketsWithActivities,
        conversationEntriesAvailable: conversationEntries.length,
      },
    });

    return {
      workspaceId,
      workspaceName: workspace.name,
      timezone,
      reviewDate: dateStr,
      range,
      config,
      summaryMetrics,
      cases: allCases,
      warnings,
      analyzedTicketIds: allCases.map((item) => item.ticketId),
      competencyCategories,
      collectionDiagnostics,
    };
  }

  _buildHeuristicRecommendations(dataset) {
    const promptRecommendations = [];
    const processRecommendations = [];
    const skillRecommendations = [];

    const failureCases = dataset.cases.filter((item) => item.outcome === DAILY_REVIEW_OUTCOMES.failure);
    const outsidePoolCases = failureCases.filter((item) => item.primaryTag === DAILY_REVIEW_PRIMARY_TAGS.rejectedReassigned);
    const reboundCases = failureCases.filter((item) => item.primaryTag === DAILY_REVIEW_PRIMARY_TAGS.rebounded);

    if (outsidePoolCases.length >= 2) {
      promptRecommendations.push({
        title: 'Tighten reasoning around override patterns',
        severity: outsidePoolCases.length >= 4 ? 'high' : 'medium',
        rationale: 'Multiple tickets finished with a technician outside the recommendation pool, which suggests the prompt is missing an operational signal the reviewers are using.',
        suggestedAction: 'Review these tickets and add explicit prompt guidance for the missing routing factors, especially around category interpretation and when to trust historical ownership over the immediate recommendation.',
        supportingTicketIds: outsidePoolCases.slice(0, 5).map((item) => item.ticketId),
        supportingFreshserviceTicketIds: outsidePoolCases.slice(0, 5).map((item) => item.freshserviceTicketId),
      });
    }

    if (reboundCases.length > 0) {
      processRecommendations.push({
        title: 'Audit rebound handling and rejection follow-up',
        severity: reboundCases.length >= 3 ? 'high' : 'medium',
        rationale: 'Tickets rebounded after assignment, which indicates the system is still routing some tickets to agents who will not keep ownership.',
        suggestedAction: 'Review rejection notes, group routing, and rebound guardrails. Consider earlier manual review for similar tickets or stronger exclusion logic for recently rejected technician-ticket pairs.',
        supportingTicketIds: reboundCases.slice(0, 5).map((item) => item.ticketId),
        supportingFreshserviceTicketIds: reboundCases.slice(0, 5).map((item) => item.freshserviceTicketId),
      });
    }

    const topCategory = dataset.summaryMetrics.topCategories[0];
    if (topCategory && topCategory.name && topCategory.name !== 'Uncategorized') {
      skillRecommendations.push({
        title: `Review skill coverage for ${topCategory.name}`,
        severity: topCategory.count >= 3 ? 'high' : 'medium',
        rationale: 'The highest-friction category from this review day likely needs cleaner competency coverage or better normalization in the skill matrix.',
        suggestedAction: `Check whether "${topCategory.name}" should be added, split, merged, or mapped more explicitly to one or more technician competencies.`,
        supportingTicketIds: dataset.cases
          .filter((item) => item.category === topCategory.name)
          .slice(0, 5)
          .map((item) => item.ticketId),
        supportingFreshserviceTicketIds: dataset.cases
          .filter((item) => item.category === topCategory.name)
          .slice(0, 5)
          .map((item) => item.freshserviceTicketId),
      });
    }

    if (dataset.summaryMetrics.totals.bypassedTickets > 0) {
      processRecommendations.push({
        title: 'Investigate pipeline bypass tickets',
        severity: dataset.summaryMetrics.totals.bypassedTickets >= 3 ? 'high' : 'medium',
        rationale: 'Some tickets were assigned in FreshService without a pipeline run, which reduces the review loop quality and weakens training data.',
        suggestedAction: 'Check poll timing, webhook coverage, and manual assignment timing to reduce untracked same-day ownership changes.',
        supportingTicketIds: dataset.cases
          .filter((item) => item.primaryTag === DAILY_REVIEW_PRIMARY_TAGS.pipelineBypassed)
          .slice(0, 5)
          .map((item) => item.ticketId),
        supportingFreshserviceTicketIds: dataset.cases
          .filter((item) => item.primaryTag === DAILY_REVIEW_PRIMARY_TAGS.pipelineBypassed)
          .slice(0, 5)
          .map((item) => item.freshserviceTicketId),
      });
    }

    return {
      executiveSummary: `Reviewed ${dataset.summaryMetrics.totals.totalTicketsReviewed} ticket(s) for ${dataset.reviewDate}. Success rate was ${dataset.summaryMetrics.rates.successRate}% with ${dataset.summaryMetrics.totals.failure} failure-classified case(s) and ${dataset.summaryMetrics.totals.rebounds} rebound(s).`,
      promptRecommendations,
      processRecommendations,
      skillRecommendations,
      warnings: ['Used heuristic recommendations because LLM analysis was unavailable.'],
      transcript: '',
      totalTokensUsed: 0,
    };
  }

  // Strip any supporting ticket id the LLM returned that wasn't in the
  // input set. The tool schema accepts arbitrary integers so an unbounded
  // model can (and does, occasionally) invent plausible-looking ticket
  // numbers. Keeping only ids we sent in guarantees every recommendation
  // is grounded in the current workspace's review cohort.
  _sanitizeRecommendationItems(items = [], { allowedInternalIds, allowedFreshserviceIds }) {
    if (!Array.isArray(items)) return { items: [], droppedInternal: 0, droppedExternal: 0 };
    let droppedInternal = 0;
    let droppedExternal = 0;
    const sanitized = items.map((item) => {
      const cleanedInternal = Array.isArray(item.supportingTicketIds)
        ? item.supportingTicketIds.filter((id) => {
          if (allowedInternalIds.has(Number(id))) return true;
          droppedInternal++;
          return false;
        })
        : [];
      const cleanedExternal = Array.isArray(item.supportingFreshserviceTicketIds)
        ? item.supportingFreshserviceTicketIds.filter((id) => {
          if (allowedFreshserviceIds.has(Number(id))) return true;
          droppedExternal++;
          return false;
        })
        : [];
      return {
        ...item,
        supportingTicketIds: cleanedInternal,
        supportingFreshserviceTicketIds: cleanedExternal,
      };
    });
    return { items: sanitized, droppedInternal, droppedExternal };
  }

  // Some prod tickets have an assignedTechId pointing at a technician row
  // belonging to a different workspace (a pre-existing data integrity issue
  // we don't try to fix here). We still want the daily review to be honest
  // about the scope, so we surface those as warnings and blank the tech
  // names so they don't end up quoted in the LLM's output as if they were
  // members of the current workspace.
  async _detectCrossWorkspaceAssignments(workspaceId, cases = []) {
    const techIds = new Set();
    for (const item of cases) {
      if (item.finalAssignee?.id) techIds.add(item.finalAssignee.id);
      if (item.pipelineAssignedTech?.id) techIds.add(item.pipelineAssignedTech.id);
      for (const action of item.assignmentActions || []) {
        if (action.assignedToId) techIds.add(action.assignedToId);
      }
      for (const episode of item.episodeSummary || []) {
        if (episode.technicianId) techIds.add(episode.technicianId);
      }
    }
    if (techIds.size === 0) return { foreignTechIds: new Set(), warnings: [] };

    const techs = await prisma.technician.findMany({
      where: { id: { in: Array.from(techIds) } },
      select: { id: true, workspaceId: true, name: true },
    });
    const foreign = techs.filter((t) => t.workspaceId !== workspaceId);
    const foreignTechIds = new Set(foreign.map((t) => t.id));
    const warnings = foreign.length > 0
      ? [`${foreign.length} technician reference(s) in this review (e.g. ${foreign.slice(0, 3).map((t) => t.name).join(', ')}) belong to other workspaces. Their names were redacted from the LLM input to avoid cross-workspace recommendations.`]
      : [];
    return { foreignTechIds, warnings };
  }

  _redactForeignTechFromCase(item, foreignTechIds) {
    if (foreignTechIds.size === 0) return item;
    const safe = (tech) => (tech && foreignTechIds.has(tech.id)
      ? { id: tech.id, name: '(out-of-workspace technician)' }
      : tech);
    return {
      ...item,
      finalAssignee: safe(item.finalAssignee),
      pipelineAssignedTech: safe(item.pipelineAssignedTech),
      assignmentActions: (item.assignmentActions || []).map((action) => (
        action.assignedToId && foreignTechIds.has(action.assignedToId)
          ? { ...action, assignedToName: '(out-of-workspace technician)' }
          : action
      )),
      episodeSummary: (item.episodeSummary || []).map((episode) => (
        episode.technicianId && foreignTechIds.has(episode.technicianId)
          ? { ...episode, technicianName: '(out-of-workspace technician)' }
          : episode
      )),
    };
  }

  async _analyzeDataset(workspaceId, dataset, llmModel, options = {}) {
    this._throwIfCancelled(options.signal);
    const apiKey = appConfig.anthropic.apiKey;
    if (!apiKey) {
      return this._buildHeuristicRecommendations(dataset);
    }

    try {
      this._throwIfCancelled(options.signal);
      const publishedPrompt = await promptRepository.getPublished(workspaceId);

      const { foreignTechIds, warnings: techWarnings } = await this._detectCrossWorkspaceAssignments(
        workspaceId,
        dataset.cases,
      );
      const safeCases = dataset.cases.map((item) => this._redactForeignTechFromCase(item, foreignTechIds));

      const analyzedCases = safeCases
        .filter((item) => item.outcome === DAILY_REVIEW_OUTCOMES.failure || item.outcome === DAILY_REVIEW_OUTCOMES.partialSuccess)
        .slice(0, MAX_CASES_FOR_ANALYSIS);

      // The id sets the LLM is allowed to cite as supporting evidence — built
      // from the actual cases we hand to the model. Anything the model returns
      // outside these sets is treated as a hallucination and dropped.
      const allowedInternalIds = new Set(analyzedCases.map((item) => Number(item.ticketId)).filter(Boolean));
      const allowedFreshserviceIds = new Set(analyzedCases.map((item) => Number(item.freshserviceTicketId)).filter(Boolean));

      const analysisInput = {
        reviewDate: dataset.reviewDate,
        workspaceId,
        workspaceName: dataset.workspaceName,
        timezone: dataset.timezone,
        summary: dataset.summaryMetrics,
        // Each case ships full structured context: header metadata, the
        // chronological thread (notes + replies + state-change events with
        // visibility tags) and a one-line summary line. The structured
        // threadExcerpts give the model real conversation bodies to read,
        // which is what was missing before — previously only the joined
        // summary string was sent and it was capped to 220 chars per item
        // and only included activity-stream events (no actual note bodies).
        cases: analyzedCases.map((item) => ({
          ticketId: item.ticketId,
          freshserviceTicketId: item.freshserviceTicketId,
          subject: item.subject,
          category: item.category,
          priority: item.priority,
          status: item.status,
          outcome: item.outcome,
          primaryTag: item.primaryTag,
          decision: item.decision,
          triggerSource: item.triggerSource,
          rejectionCount: item.rejectionCount,
          topRecommendation: item.topRecommendation,
          finalAssignee: item.finalAssignee,
          pipelineAssignedTech: item.pipelineAssignedTech,
          changedFromTopRecommendation: item.changedFromTopRecommendation,
          handledInFreshService: item.handledInFreshService,
          overrideReason: item.overrideReason,
          decisionNote: item.decisionNote,
          ticketCreatedAt: item.ticketCreatedAt,
          resolvedAt: item.resolvedAt,
          closedAt: item.closedAt,
          rebounded: Array.isArray(item.tags) && item.tags.includes(DAILY_REVIEW_PRIMARY_TAGS.rebounded),
          episodeSummary: (item.episodeSummary || []).map((ep) => ({
            technicianName: ep.technicianName,
            startMethod: ep.startMethod,
            endMethod: ep.endMethod,
            endActorName: ep.endActorName,
          })),
          assignmentActions: (item.assignmentActions || []).map((a) => ({
            source: a.source,
            assignedToName: a.assignedToName,
            assignedByEmail: a.assignedByEmail,
            note: a.note,
          })),
          threadExcerpts: (item.threadExcerpts || []).map((ex) => ({
            source: ex.source,
            eventType: ex.eventType,
            visibility: ex.visibility,
            actorName: ex.actorName,
            occurredAt: ex.occurredAt,
            excerpt: ex.excerpt,
          })),
          summary: this._summarizeCase(item),
        })),
        competencyCategories: dataset.competencyCategories.map((item) => item.name),
        currentPromptVersion: publishedPrompt?.version || null,
        allowedSupportingTicketIds: Array.from(allowedInternalIds),
        allowedSupportingFreshserviceTicketIds: Array.from(allowedFreshserviceIds),
      };

      const TOOL = {
        name: 'submit_daily_review_findings',
        description: `Submit the final daily review findings for the "${workspaceLabel}" workspace. You must call this tool exactly once. Every supportingTicketIds entry must come from analysisInput.allowedSupportingTicketIds and every supportingFreshserviceTicketIds entry must come from analysisInput.allowedSupportingFreshserviceTicketIds — do not invent ids.`,
        input_schema: {
          type: 'object',
          properties: {
            executiveSummary: { type: 'string' },
            promptRecommendations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  severity: { type: 'string', enum: ['high', 'medium', 'low'] },
                  rationale: { type: 'string' },
                  suggestedAction: { type: 'string' },
                  supportingTicketIds: { type: 'array', items: { type: 'integer' } },
                  supportingFreshserviceTicketIds: { type: 'array', items: { type: 'integer' } },
                },
                required: ['title', 'severity', 'rationale', 'suggestedAction'],
              },
            },
            processRecommendations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  severity: { type: 'string', enum: ['high', 'medium', 'low'] },
                  rationale: { type: 'string' },
                  suggestedAction: { type: 'string' },
                  supportingTicketIds: { type: 'array', items: { type: 'integer' } },
                  supportingFreshserviceTicketIds: { type: 'array', items: { type: 'integer' } },
                },
                required: ['title', 'severity', 'rationale', 'suggestedAction'],
              },
            },
            skillRecommendations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  severity: { type: 'string', enum: ['high', 'medium', 'low'] },
                  rationale: { type: 'string' },
                  suggestedAction: { type: 'string' },
                  skillsAffected: { type: 'array', items: { type: 'string' } },
                  supportingTicketIds: { type: 'array', items: { type: 'integer' } },
                  supportingFreshserviceTicketIds: { type: 'array', items: { type: 'integer' } },
                },
                required: ['title', 'severity', 'rationale', 'suggestedAction'],
              },
            },
            warnings: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: [
            'executiveSummary',
            'promptRecommendations',
            'processRecommendations',
            'skillRecommendations',
            'warnings',
          ],
        },
      };

      const workspaceLabel = dataset.workspaceName || 'this';
      const systemPrompt = `You are reviewing one business day of auto-assignment outcomes for the "${workspaceLabel}" workspace ONLY.

Strict scoping rules:
- Every recommendation must be about the "${workspaceLabel}" workspace. Do not reference tickets, technicians, or processes from any other workspace.
- supportingTicketIds MUST come from the analysisInput.allowedSupportingTicketIds list. Anything else will be discarded as a hallucination.
- supportingFreshserviceTicketIds MUST come from the analysisInput.allowedSupportingFreshserviceTicketIds list. Anything else will be discarded as a hallucination.
- Never invent ticket numbers, technician names, or workflow names that are not present in the supplied cases.

Your job is to recommend improvements in exactly three areas:
1. Prompt changes
2. Process changes
3. Skill matrix changes

Rules:
- Base every recommendation on evidence from the supplied cases and metrics.
- Be conservative. Fewer strong recommendations are better than many weak ones.
- Do not rewrite the prompt or mutate the competency matrix directly.
- Focus on why the system missed and how to improve future assignments.
- Use the tool once with concise, actionable recommendations.`;

      const userMessage = `Daily review dataset:
\n\n${JSON.stringify(analysisInput, null, 2)}\n\nSubmit the structured findings using the tool.`;

      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: llmModel || 'claude-sonnet-4-6-20260217',
        max_tokens: 4096,
        system: systemPrompt,
        tools: [TOOL],
        messages: [{ role: 'user', content: userMessage }],
      }, {
        signal: options.signal,
      });
      this._throwIfCancelled(options.signal);

      const transcript = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      const submission = response.content.find(
        (block) => block.type === 'tool_use' && block.name === 'submit_daily_review_findings',
      )?.input;

      if (!submission) {
        logger.warn('Daily review analysis returned without a tool submission');
        const heuristic = this._buildHeuristicRecommendations(dataset);
        heuristic.warnings.push('LLM response did not contain a structured submission; heuristic recommendations were used instead.');
        heuristic.transcript = transcript;
        heuristic.totalTokensUsed = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
        return heuristic;
      }

      // Strip any supporting ticket id the LLM hallucinated; everything cited
      // must be present in the actual analyzedCases set we sent in.
      const sanitizationCtx = { allowedInternalIds, allowedFreshserviceIds };
      const promptSanitized = this._sanitizeRecommendationItems(submission.promptRecommendations, sanitizationCtx);
      const processSanitized = this._sanitizeRecommendationItems(submission.processRecommendations, sanitizationCtx);
      const skillSanitized = this._sanitizeRecommendationItems(submission.skillRecommendations, sanitizationCtx);
      const totalDroppedInternal = promptSanitized.droppedInternal + processSanitized.droppedInternal + skillSanitized.droppedInternal;
      const totalDroppedExternal = promptSanitized.droppedExternal + processSanitized.droppedExternal + skillSanitized.droppedExternal;
      const sanitizationWarnings = [];
      if (totalDroppedInternal > 0 || totalDroppedExternal > 0) {
        const dropMsg = `Dropped ${totalDroppedInternal + totalDroppedExternal} hallucinated supporting ticket id reference(s) (${totalDroppedInternal} internal, ${totalDroppedExternal} freshservice) returned by the LLM that were not part of this workspace's review cohort.`;
        logger.warn(dropMsg, { workspaceId, runDate: dataset.reviewDate });
        sanitizationWarnings.push(dropMsg);
      }

      return {
        executiveSummary: submission.executiveSummary || '',
        promptRecommendations: promptSanitized.items,
        processRecommendations: processSanitized.items,
        skillRecommendations: skillSanitized.items,
        warnings: [
          ...(submission.warnings || []),
          ...techWarnings,
          ...sanitizationWarnings,
        ],
        transcript,
        totalTokensUsed: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
      };
    } catch (error) {
      if (this._isCancellationError(error)) throw error;
      logger.error('Daily review LLM analysis failed, falling back to heuristics', {
        workspaceId,
        error: error.message,
      });
      const heuristic = this._buildHeuristicRecommendations(dataset);
      heuristic.warnings.push(`LLM analysis failed: ${error.message}`);
      return heuristic;
    }
  }

  async runReview(workspaceId, reviewDate, triggeredBy = 'system', options = {}) {
    const startedAt = Date.now();
    const emit = (event) => {
      try { options.onEvent?.(event); } catch { /* ignore stream errors */ }
    };
    let run;
    let lastHeartbeatAt = 0;
    const heartbeatRun = (status) => {
      const now = Date.now();
      if (!run?.id || now - lastHeartbeatAt < 10000) return;
      lastHeartbeatAt = now;
      prisma.assignmentDailyReviewRun.update({
        where: { id: run.id },
        data: { status },
      }).catch((error) => {
        logger.warn('Daily review heartbeat failed', { runId: run.id, error: error.message });
      });
    };

    await this._markStaleRunsFailed();

    const { workspace, config, timezone } = await this._getWorkspaceContext(workspaceId);
    const dateStr = reviewDate || formatInTimeZone(new Date(), timezone, 'yyyy-MM-dd');
    const reviewDateValue = reviewDateKey(dateStr);

    const activeExisting = await prisma.assignmentDailyReviewRun.findFirst({
      where: {
        workspaceId,
        reviewDate: reviewDateValue,
        status: { in: ACTIVE_STATUSES },
      },
    });
    if (activeExisting) {
      emit({ type: 'error', message: `A daily review is already running for ${dateStr} (run #${activeExisting.id}).` });
      return activeExisting;
    }

    // When force is false (e.g. the scheduled job calling in), short-circuit
    // if today's review has already completed so we don't pile on duplicate
    // rows for the same date. Manual UI clicks always pass force=true and
    // therefore always create a fresh run row below — that's why each rerun
    // now gets its own id (Run #2, #3, ...) instead of overwriting Run #1.
    if (!options.force) {
      const lastCompleted = await prisma.assignmentDailyReviewRun.findFirst({
        where: {
          workspaceId,
          reviewDate: reviewDateValue,
          status: 'completed',
        },
        orderBy: { createdAt: 'desc' },
      });
      if (lastCompleted) {
        return lastCompleted;
      }
    }

    run = await prisma.assignmentDailyReviewRun.create({
      data: {
        workspaceId,
        reviewDate: reviewDateValue,
        timezone,
        triggerSource: options.triggerSource || 'manual',
        status: 'collecting',
        triggeredBy,
        llmModel: config?.llmModel || 'claude-sonnet-4-6-20260217',
      },
    });
    const abortController = new AbortController();
    this.activeRunControllers.set(run.id, abortController);

    emit({ type: 'daily_review_started', runId: run.id, reviewDate: dateStr, workspaceName: workspace.name });

    try {
      emit({
        type: 'phase_update',
        phase: 'collecting',
        message: 'Collecting ticket outcomes, thread history, and assignment evidence...',
        percent: 2,
      });
      const dataset = await this.collectDailyDataset(workspaceId, dateStr, {
        signal: abortController.signal,
        forceRefreshThreads: options.forceRefreshThreads === true,
        onProgress: (event) => {
          heartbeatRun('collecting');
          emit({
            type: 'phase_update',
            phase: event.phase || 'collecting',
            message: event.message,
            percent: event.percent,
            stats: event.stats,
          });
        },
      });

      await prisma.assignmentDailyReviewRun.update({
        where: { id: run.id },
        data: {
          status: 'analyzing',
          rangeStart: dataset.range.start,
          rangeEnd: dataset.range.end,
          summaryMetrics: {
            ...dataset.summaryMetrics,
            collectionDiagnostics: dataset.collectionDiagnostics,
          },
          analyzedTicketIds: dataset.analyzedTicketIds,
          evidenceCases: dataset.cases,
          warnings: dataset.warnings,
        },
      });

      emit({
        type: 'dataset_collected',
        totals: dataset.summaryMetrics.totals,
        topCategories: dataset.summaryMetrics.topCategories,
      });
      emit({
        type: 'phase_update',
        phase: 'analyzing',
        message: 'Generating prompt, process, and skill-matrix recommendations...',
        percent: 92,
      });

      this._throwIfCancelled(abortController.signal);
      const analysis = await this._analyzeDataset(workspaceId, dataset, config?.llmModel, {
        signal: abortController.signal,
      });
      this._throwIfCancelled(abortController.signal);
      const mergedWarnings = [...dataset.warnings, ...(analysis.warnings || [])];

      run = await prisma.$transaction(async (tx) => {
        const updatedRun = await tx.assignmentDailyReviewRun.update({
          where: { id: run.id },
          data: {
            status: 'completed',
            summaryMetrics: {
              ...dataset.summaryMetrics,
              executiveSummary: analysis.executiveSummary,
              collectionDiagnostics: dataset.collectionDiagnostics,
            },
            analyzedTicketIds: dataset.analyzedTicketIds,
            evidenceCases: dataset.cases,
            promptRecommendations: analysis.promptRecommendations,
            processRecommendations: analysis.processRecommendations,
            skillRecommendations: analysis.skillRecommendations,
            warnings: mergedWarnings,
            fullTranscript: analysis.transcript || null,
            totalTokensUsed: analysis.totalTokensUsed || 0,
            totalDurationMs: Date.now() - startedAt,
            completedAt: new Date(),
          },
        });
        await this._replaceRecommendationsForRun(tx, updatedRun, {
          promptRecommendations: analysis.promptRecommendations,
          processRecommendations: analysis.processRecommendations,
          skillRecommendations: analysis.skillRecommendations,
        });
        return updatedRun;
      });

      emit({
        type: 'recommendations_ready',
        executiveSummary: analysis.executiveSummary,
        promptCount: analysis.promptRecommendations?.length || 0,
        processCount: analysis.processRecommendations?.length || 0,
        skillCount: analysis.skillRecommendations?.length || 0,
      });
      emit({ type: 'phase_update', phase: 'completed', message: 'Daily review complete.', percent: 100 });
      emit({ type: 'daily_review_complete', runId: run.id });
      return run;
    } catch (error) {
      if (this._isCancellationError(error)) {
        run = await prisma.assignmentDailyReviewRun.update({
          where: { id: run.id },
          data: {
            status: 'cancelled',
            totalDurationMs: Date.now() - startedAt,
            completedAt: new Date(),
          },
        });
        emit({ type: 'phase_update', phase: 'cancelled', message: error.message, percent: 100 });
        emit({ type: 'cancelled', runId: run.id, message: error.message });
        emit({ type: 'daily_review_complete', runId: run.id });
        return run;
      }

      logger.error('Daily review run failed', { workspaceId, reviewDate: dateStr, error: error.message });
      run = await prisma.assignmentDailyReviewRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          errorMessage: error.message,
          totalDurationMs: Date.now() - startedAt,
          completedAt: new Date(),
        },
      });
      emit({ type: 'error', message: error.message });
      emit({ type: 'daily_review_complete', runId: run.id });
      return run;
    } finally {
      this.activeRunControllers.delete(run?.id);
    }
  }

  async getRuns(workspaceId, { limit = 20, offset = 0 } = {}) {
    const [items, total] = await Promise.all([
      prisma.assignmentDailyReviewRun.findMany({
        where: { workspaceId },
        orderBy: [{ reviewDate: 'desc' }, { createdAt: 'desc' }],
        take: limit,
        skip: offset,
      }),
      prisma.assignmentDailyReviewRun.count({ where: { workspaceId } }),
    ]);
    await this._ensureRecommendationRowsForRuns(workspaceId, items);

    const runIds = items.map((item) => item.id);
    const rows = runIds.length > 0
      ? await prisma.assignmentDailyReviewRecommendation.findMany({
        where: { runId: { in: runIds } },
        select: { runId: true, status: true },
      })
      : [];

    const countsByRun = new Map();
    for (const row of rows) {
      if (!countsByRun.has(row.runId)) {
        countsByRun.set(row.runId, {
          pending: 0,
          approved: 0,
          rejected: 0,
          applied: 0,
        });
      }
      countsByRun.get(row.runId)[row.status] += 1;
    }

    return {
      items: items.map((item) => ({
        ...item,
        recommendationStatusCounts: countsByRun.get(item.id) || {
          pending: 0,
          approved: 0,
          rejected: 0,
          applied: 0,
        },
      })),
      total,
    };
  }

  async getRun(id) {
    const run = await prisma.assignmentDailyReviewRun.findUnique({ where: { id } });
    if (!run) return null;

    await this._ensureRecommendationRowsForRuns(run.workspaceId, [run]);
    const rows = await prisma.assignmentDailyReviewRecommendation.findMany({
      where: { runId: id },
      include: {
        run: {
          select: { id: true, reviewDate: true, triggeredBy: true, status: true },
        },
      },
      orderBy: [{ kind: 'asc' }, { ordinal: 'asc' }],
    });

    return {
      ...run,
      ...this._groupRecommendations(rows),
    };
  }

  async listRecommendations(workspaceId, {
    status,
    kind,
    startDate,
    endDate,
    runId,
    limit = 100,
    offset = 0,
  } = {}) {
    if (status && status !== 'all') this._validateRecommendationStatus(status);
    if (kind) this._validateRecommendationKind(kind);

    await this._ensureRecommendationRowsForWorkspace(workspaceId, { startDate, endDate });

    const where = { workspaceId };
    if (status && status !== 'all') where.status = status;
    if (kind && kind !== 'all') where.kind = kind;
    if (startDate || endDate) {
      where.reviewDate = {};
      if (startDate) where.reviewDate.gte = reviewDateKey(startDate);
      if (endDate) where.reviewDate.lte = reviewDateKey(endDate);
    }
    // Accepts a numeric id, a numeric string, or a label like "Run #12" /
    // "#12" / "run 12" — anything the admin would type after seeing the
    // "Run #N" label in the UI. Non-matching input narrows to no rows so
    // the UI shows "no results" instead of silently ignoring the filter.
    if (runId !== undefined && runId !== null && runId !== '') {
      const numeric = typeof runId === 'number'
        ? runId
        : parseInt(String(runId).replace(/[^0-9]/g, ''), 10);
      where.runId = Number.isInteger(numeric) && numeric > 0 ? numeric : -1;
    }

    const [items, total] = await Promise.all([
      prisma.assignmentDailyReviewRecommendation.findMany({
        where,
        include: {
          run: {
            select: { id: true, reviewDate: true, triggeredBy: true, status: true },
          },
        },
        orderBy: [{ reviewDate: 'desc' }, { kind: 'asc' }, { ordinal: 'asc' }],
        take: limit,
        skip: offset,
      }),
      prisma.assignmentDailyReviewRecommendation.count({ where }),
    ]);

    return {
      items: items.map((item) => this._toRecommendationDto(item)),
      total,
    };
  }

  async getWeeklyRecommendationRollup(workspaceId, {
    weekStart,
    status = 'approved',
    kind = 'all',
  } = {}) {
    this._validateRecommendationKind(kind);
    const normalizedWeekStart = weekStart || formatInTimeZone(new Date(), 'UTC', 'yyyy-MM-dd');
    const start = reviewDateKey(normalizedWeekStart);
    const end = addDaysUtc(start, 6);
    const normalizedWeekEnd = end.toISOString().slice(0, 10);
    const { items } = await this.listRecommendations(workspaceId, {
      status,
      kind,
      startDate: normalizedWeekStart,
      endDate: normalizedWeekEnd,
      limit: 500,
      offset: 0,
    });

    const days = new Map();
    const countsByKind = { prompt: 0, process: 0, skill: 0 };

    for (const item of items) {
      const reviewDate = item.reviewDate instanceof Date
        ? item.reviewDate.toISOString().slice(0, 10)
        : String(item.reviewDate).slice(0, 10);
      if (!days.has(reviewDate)) {
        days.set(reviewDate, {
          reviewDate,
          promptRecommendations: [],
          processRecommendations: [],
          skillRecommendations: [],
          total: 0,
        });
      }
      const day = days.get(reviewDate);
      day.total += 1;
      if (item.kind === 'prompt') day.promptRecommendations.push(item);
      if (item.kind === 'process') day.processRecommendations.push(item);
      if (item.kind === 'skill') day.skillRecommendations.push(item);
      countsByKind[item.kind] += 1;
    }

    return {
      weekStart: normalizedWeekStart,
      weekEnd: normalizedWeekEnd,
      status,
      kind,
      total: items.length,
      countsByKind,
      days: Array.from(days.values()).sort((a, b) => a.reviewDate.localeCompare(b.reviewDate)),
    };
  }

  async updateRecommendation(id, workspaceId, { status, reviewNotes, actorEmail }) {
    this._validateRecommendationStatus(status);

    const existing = await prisma.assignmentDailyReviewRecommendation.findUnique({
      where: { id },
      include: {
        run: {
          select: { id: true, reviewDate: true, triggeredBy: true, status: true },
        },
      },
    });
    if (!existing) return null;
    if (existing.workspaceId !== workspaceId) {
      throw new Error('Recommendation belongs to a different workspace');
    }
    if (status === 'applied' && !['approved', 'applied'].includes(existing.status)) {
      throw new Error('Recommendation must be approved before it can be marked as applied');
    }

    const now = new Date();
    const data = {
      status,
    };

    if (reviewNotes !== undefined) {
      data.reviewNotes = reviewNotes?.trim() || null;
    }

    if (status === 'pending') {
      data.reviewedBy = null;
      data.reviewedAt = null;
      data.appliedBy = null;
      data.appliedAt = null;
    } else if (status === 'approved' || status === 'rejected') {
      data.reviewedBy = actorEmail;
      data.reviewedAt = now;
      data.appliedBy = null;
      data.appliedAt = null;
    } else if (status === 'applied') {
      data.appliedBy = actorEmail;
      data.appliedAt = now;
      if (!existing.reviewedAt) {
        data.reviewedBy = actorEmail;
        data.reviewedAt = now;
      }
    }

    const updated = await prisma.assignmentDailyReviewRecommendation.update({
      where: { id },
      data,
      include: {
        run: {
          select: { id: true, reviewDate: true, triggeredBy: true, status: true },
        },
      },
    });

    return this._toRecommendationDto(updated);
  }

  async bulkUpdateRecommendations(workspaceId, { ids = [], status, reviewNotes, actorEmail }) {
    this._validateRecommendationStatus(status);
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new Error('ids must contain at least one recommendation id');
    }

    const existing = await prisma.assignmentDailyReviewRecommendation.findMany({
      where: { id: { in: ids } },
      include: {
        run: {
          select: { id: true, reviewDate: true, triggeredBy: true, status: true },
        },
      },
    });

    if (existing.some((item) => item.workspaceId !== workspaceId)) {
      throw new Error('One or more recommendations belong to a different workspace');
    }
    if (status === 'applied' && existing.some((item) => !['approved', 'applied'].includes(item.status))) {
      throw new Error('All selected recommendations must be approved before they can be marked as applied');
    }

    const updates = await Promise.all(existing.map((item) => this.updateRecommendation(item.id, workspaceId, {
      status,
      reviewNotes,
      actorEmail,
    })));

    return {
      updated: updates.length,
      items: updates,
    };
  }

  // Generates a one-page meeting briefing from a completed daily review.
  // The briefing is intentionally separate from the structured prompt /
  // process / skill recommendations: those are *operational* artifacts the
  // admin acts on; the briefing is a *narrative* summary the team reads at
  // the next-day standup. We persist it on the run record so it survives
  // refreshes; regeneration overwrites the previous version.
  async generateMeetingBriefing(runId, workspaceId, { actorEmail = 'admin', tone = 'standup' } = {}) {
    const run = await prisma.assignmentDailyReviewRun.findUnique({ where: { id: runId } });
    if (!run) throw new Error('Daily review run not found');
    if (run.workspaceId !== workspaceId) throw new Error('Run belongs to a different workspace');
    if (run.status !== 'completed') {
      throw new Error(`Briefing can only be generated for completed runs (current status: ${run.status})`);
    }

    const apiKey = appConfig.anthropic.apiKey;
    if (!apiKey) throw new Error('Anthropic API key is not configured on the server');

    const summary = run.summaryMetrics || {};
    const totals = summary.totals || {};
    const rates = summary.rates || {};
    const cases = Array.isArray(run.evidenceCases) ? run.evidenceCases : [];

    // Compact case payload — same shape we use for the recommendation
    // analysis, but also passing finalAssignee and rebound context so the
    // briefing can name names and tell a chronological story.
    const trimmedCases = cases
      .slice(0, 30)
      .map((item) => ({
        ticketId: item.ticketId,
        freshserviceTicketId: item.freshserviceTicketId,
        subject: item.subject,
        category: item.category,
        priority: item.priority,
        status: item.status,
        outcome: item.outcome,
        primaryTag: item.primaryTag,
        decision: item.decision,
        triggerSource: item.triggerSource,
        topRecommendation: item.topRecommendation?.techName || null,
        finalAssignee: item.finalAssignee?.name || null,
        rebounded: item.tags?.includes('rebounded') || false,
        overrideReason: item.overrideReason || null,
        decisionNote: item.decisionNote || null,
        ticketCreatedAt: item.ticketCreatedAt,
        resolvedAt: item.resolvedAt,
      }));

    const recommendationsContext = {
      prompt: (run.promptRecommendations || []).slice(0, 5).map((rec) => ({
        title: rec.title,
        severity: rec.severity,
        rationale: rec.rationale,
      })),
      process: (run.processRecommendations || []).slice(0, 5).map((rec) => ({
        title: rec.title,
        severity: rec.severity,
        rationale: rec.rationale,
      })),
      skill: (run.skillRecommendations || []).slice(0, 5).map((rec) => ({
        title: rec.title,
        severity: rec.severity,
        rationale: rec.rationale,
      })),
    };

    const reviewDateStr = run.reviewDate instanceof Date
      ? run.reviewDate.toISOString().slice(0, 10)
      : String(run.reviewDate).slice(0, 10);

    const allowedFreshserviceIds = new Set(
      trimmedCases.map((c) => Number(c.freshserviceTicketId)).filter(Boolean),
    );
    const allowedInternalIds = new Set(
      trimmedCases.map((c) => Number(c.ticketId)).filter(Boolean),
    );

    const briefingInput = {
      workspaceName: summary.workspaceName || 'this workspace',
      reviewDate: reviewDateStr,
      timezone: run.timezone,
      reviewWindow: summary.reviewWindow || null,
      totals,
      rates,
      topCategories: summary.topCategories || [],
      topTechnicians: summary.topTechnicians || [],
      executiveSummary: summary.executiveSummary || null,
      cases: trimmedCases,
      recommendations: recommendationsContext,
      warnings: run.warnings || [],
      allowedSupportingTicketIds: Array.from(allowedInternalIds),
      allowedSupportingFreshserviceTicketIds: Array.from(allowedFreshserviceIds),
    };

    const TOOL = {
      name: 'submit_meeting_briefing',
      description: `Submit the one-page meeting briefing for the "${briefingInput.workspaceName}" workspace's ${reviewDateStr} daily review. Call this tool exactly once. Every ticket id you cite must come from briefingInput.allowedSupportingFreshserviceTicketIds — do not invent ids or technician names.`,
      input_schema: {
        type: 'object',
        properties: {
          headline: {
            type: 'string',
            description: 'A punchy, specific one-line summary of the day (max ~120 chars). Avoid generic phrasing like "Daily review summary"; name what actually drove the day.',
          },
          narrative: {
            type: 'string',
            description: 'A 2-4 short paragraph story of the day in clear conversational English. Tell the day chronologically when possible. Reference real ticket categories, technician names, and notable cases. Keep it readable in under 60 seconds out loud.',
          },
          keyMetrics: {
            type: 'array',
            description: 'The 3-6 numbers worth saying out loud at the standup. Each is a label + value + a short bit of context.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                value: { type: 'string', description: 'The metric value as a string (e.g., "47", "92%", "2 reroutes").' },
                context: { type: 'string', description: 'Optional short qualifier (e.g., "vs typical 35").' },
                tone: { type: 'string', enum: ['good', 'bad', 'neutral', 'watch'] },
              },
              required: ['label', 'value', 'tone'],
            },
          },
          highlights: {
            type: 'array',
            description: 'Scannable callouts grouped by tone. Examples: a clean win, a problem ticket, a tech who carried load, a category that caused friction.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                detail: { type: 'string' },
                tone: { type: 'string', enum: ['good', 'bad', 'neutral', 'watch'] },
                supportingFreshserviceTicketIds: {
                  type: 'array',
                  items: { type: 'integer' },
                  description: 'Optional ticket ids from briefingInput.allowedSupportingFreshserviceTicketIds that back up this highlight.',
                },
              },
              required: ['title', 'detail', 'tone'],
            },
          },
          talkingPoints: {
            type: 'array',
            description: 'Concrete questions or follow-ups for the team to discuss in the standup (e.g., "Should we add a Tableau competency?").',
            items: { type: 'string' },
          },
          shoutouts: {
            type: 'array',
            description: 'Optional named shoutouts to technicians who carried meaningful load or handled tricky cases. Only include techs that appear in the supplied cases.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                reason: { type: 'string' },
              },
              required: ['name', 'reason'],
            },
          },
          lookahead: {
            type: 'string',
            description: '1-2 sentences about what the team should watch today (carried-over tickets, repeat offenders, follow-ups).',
          },
        },
        required: ['headline', 'narrative', 'keyMetrics', 'highlights', 'talkingPoints', 'lookahead'],
      },
    };

    const toneGuidance = tone === 'executive'
      ? 'Tone: executive briefing. Crisp, business-focused, no jargon.'
      : 'Tone: morning standup. Conversational, scannable, useful for a 5-minute daily team sync.';

    const systemPrompt = `You are preparing a one-page meeting briefing for the "${briefingInput.workspaceName}" team's daily standup. The briefing covers the previous business day of automated ticket assignments.

${toneGuidance}

Hard rules:
- Make the day come alive: highlight what went well, what went wrong, who carried the load, what categories caused friction, and what should be on the team's radar today.
- The headline must be specific to today's data — never generic.
- Reference real ticket categories, technician names, and ticket numbers from the supplied cases. Do NOT invent ids, names, or events that are not in the data.
- Every ticket id you cite in highlights.supportingFreshserviceTicketIds MUST come from briefingInput.allowedSupportingFreshserviceTicketIds. Anything else will be discarded.
- Stay scoped to the "${briefingInput.workspaceName}" workspace. Do not reference other workspaces.
- Use the tool exactly once.`;

    const userMessage = `Daily review dataset for the meeting briefing:\n\n${JSON.stringify(briefingInput, null, 2)}\n\nSubmit the briefing using the tool.`;

    const llmModel = run.llmModel || 'claude-sonnet-4-6-20260217';
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: llmModel,
      max_tokens: 3000,
      system: systemPrompt,
      tools: [TOOL],
      messages: [{ role: 'user', content: userMessage }],
    });

    const submission = response.content.find(
      (block) => block.type === 'tool_use' && block.name === 'submit_meeting_briefing',
    )?.input;

    if (!submission) {
      throw new Error('LLM did not return a structured meeting briefing');
    }

    // Defence-in-depth: same allow-list filtering pattern we use for the
    // recommendation supporting-ids, applied to the briefing's highlight
    // citations. Any ticket id outside the allow-list is dropped to prevent
    // hallucinated cross-workspace references from leaking into the standup.
    const cleanedHighlights = (submission.highlights || []).map((item) => {
      const cleanedIds = Array.isArray(item.supportingFreshserviceTicketIds)
        ? item.supportingFreshserviceTicketIds.filter((id) => allowedFreshserviceIds.has(Number(id)))
        : [];
      return { ...item, supportingFreshserviceTicketIds: cleanedIds };
    });

    const briefing = {
      headline: String(submission.headline || '').trim(),
      narrative: String(submission.narrative || '').trim(),
      keyMetrics: Array.isArray(submission.keyMetrics) ? submission.keyMetrics : [],
      highlights: cleanedHighlights,
      talkingPoints: Array.isArray(submission.talkingPoints) ? submission.talkingPoints : [],
      shoutouts: Array.isArray(submission.shoutouts) ? submission.shoutouts : [],
      lookahead: String(submission.lookahead || '').trim(),
      generatedAt: new Date().toISOString(),
      tone,
    };

    const tokens = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

    const updated = await prisma.assignmentDailyReviewRun.update({
      where: { id: runId },
      data: {
        meetingBriefing: briefing,
        meetingBriefingGeneratedAt: new Date(),
        meetingBriefingTokens: tokens,
        meetingBriefingModel: llmModel,
        meetingBriefingBy: actorEmail,
      },
    });

    return {
      briefing: updated.meetingBriefing,
      generatedAt: updated.meetingBriefingGeneratedAt,
      tokens: updated.meetingBriefingTokens,
      model: updated.meetingBriefingModel,
      generatedBy: updated.meetingBriefingBy,
    };
  }

  async cancelRun(id, workspaceId, cancelledBy = 'admin') {
    const run = await prisma.assignmentDailyReviewRun.findUnique({ where: { id } });
    if (!run) return null;
    if (run.workspaceId !== workspaceId) {
      throw new Error('Run belongs to a different workspace');
    }
    if (!ACTIVE_STATUSES.includes(run.status)) {
      throw new Error(`Run is not running (status: ${run.status})`);
    }

    this.activeRunControllers.get(id)?.abort();

    return prisma.assignmentDailyReviewRun.update({
      where: { id },
      data: {
        status: 'cancelled',
        errorMessage: `Cancelled by ${cancelledBy}`,
        completedAt: new Date(),
      },
    });
  }

  async maybeRunScheduledReview(workspace) {
    const { config, timezone } = await this._getWorkspaceContext(workspace.id);
    if (!config?.dailyReviewEnabled) return { triggered: false, reason: 'disabled' };

    const now = new Date();
    const zoned = toZonedTime(now, timezone);
    const dayOfWeek = zoned.getDay();
    const hours = await availabilityService.getBusinessHours(workspace.id);
    const dayConfig = hours.find((entry) => entry.dayOfWeek === dayOfWeek && entry.isEnabled);
    if (!dayConfig) return { triggered: false, reason: 'non_business_day' };

    const reviewDate = formatInTimeZone(now, timezone, 'yyyy-MM-dd');
    const scheduledAt = new Date(
      formatInTimeZone(
        new Date(`${reviewDate}T12:00:00.000Z`),
        timezone,
        `yyyy-MM-dd'T'${String(config.dailyReviewRunHour).padStart(2, '0')}:${String(config.dailyReviewRunMinute).padStart(2, '0')}:00XXX`,
      ),
    );

    if (now < scheduledAt) {
      return { triggered: false, reason: 'before_window' };
    }

    // Latest run for this date — there can now be multiple (each manual rerun
    // creates a fresh row), so we look at the newest one to decide whether
    // the scheduled job should pile on yet another run.
    const existing = await prisma.assignmentDailyReviewRun.findFirst({
      where: {
        workspaceId: workspace.id,
        reviewDate: reviewDateKey(reviewDate),
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existing && ['completed', 'running', 'collecting', 'analyzing'].includes(existing.status)) {
      return { triggered: false, reason: 'already_exists' };
    }

    await this.runReview(workspace.id, reviewDate, 'scheduled_daily_review', {
      triggerSource: 'scheduled',
      force: false,
    });
    return { triggered: true };
  }
}

export default new AssignmentDailyReviewService();
