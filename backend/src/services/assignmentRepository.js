import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { DatabaseError, NotFoundError } from '../utils/errors.js';

const STALE_RUNNING_MINUTES = 30;

// Ticket status group → list of values stored in tickets.status. The values come from the
// FreshService transformer (string labels) and may also appear as numeric codes in legacy rows.
const TICKET_STATUS_GROUPS = {
  in_progress: ['Open', 'open', '2'],
  pending: ['Pending', 'pending', '3'],
  closed_resolved: ['Closed', 'closed', '5', 'Resolved', 'resolved', '4'],
  deleted: ['Deleted', 'deleted', 'Spam', 'spam'],
};

// 'active' = anything actionable (open or paused, but not closed/resolved/deleted)
TICKET_STATUS_GROUPS.active = [
  ...TICKET_STATUS_GROUPS.in_progress,
  ...TICKET_STATUS_GROUPS.pending,
];

const NON_DELETED_STATUSES = [
  ...TICKET_STATUS_GROUPS.in_progress,
  ...TICKET_STATUS_GROUPS.pending,
  ...TICKET_STATUS_GROUPS.closed_resolved,
];

/**
 * Build a Prisma `ticket` filter clause from a ticketStatus enum value.
 * Returns an object suitable for spreading into a where clause, or {} for 'all' (excludes deleted).
 */
function buildTicketStatusFilter(ticketStatus) {
  if (!ticketStatus || ticketStatus === 'all') {
    // 'all' = any non-deleted ticket
    return { ticket: { is: { status: { in: NON_DELETED_STATUSES } } } };
  }
  if (TICKET_STATUS_GROUPS[ticketStatus]) {
    return { ticket: { is: { status: { in: TICKET_STATUS_GROUPS[ticketStatus] } } } };
  }
  return {};
}

/**
 * Build the per-ticket fields contributed by the modern multi-select filters
 * (priorities, statuses, assignedTechIds, reboundFromTechIds, search).
 *
 * Returns an object that should be spread INTO an existing `ticket.is` clause —
 * not the full `{ ticket: { is: ... } }` wrapper — so callers can compose with
 * the legacy single-status / assignment-state clauses without losing fields.
 *
 * Returns {} when nothing is filtered, so callers can spread unconditionally.
 */
function buildAdvancedTicketFilter({ priorities, statuses, assignedTechIds, reboundFromTechIds, search } = {}) {
  const clause = {};

  // Multi-status (overrides any single-status filter when present).
  if (Array.isArray(statuses) && statuses.length > 0) {
    const expanded = [];
    for (const s of statuses) {
      if (TICKET_STATUS_GROUPS[s]) expanded.push(...TICKET_STATUS_GROUPS[s]);
    }
    if (expanded.length > 0) {
      clause.status = { in: [...new Set(expanded)] };
    }
  }

  if (Array.isArray(priorities) && priorities.length > 0) {
    clause.priority = { in: priorities };
  }

  if (Array.isArray(assignedTechIds) && assignedTechIds.length > 0) {
    clause.assignedTechId = { in: assignedTechIds };
  }

  // "Returned from agent X" — match tickets that have at least one rejected
  // assignment episode against any of the given technicians. Same relation
  // used by _enrichRunsWithReboundContext, just queried as a `some` filter.
  if (Array.isArray(reboundFromTechIds) && reboundFromTechIds.length > 0) {
    clause.assignmentEpisodes = {
      some: {
        endMethod: 'rejected',
        technicianId: { in: reboundFromTechIds },
      },
    };
  }

  if (search && typeof search === 'string') {
    const q = search.trim();
    if (q) {
      const orClauses = [
        { subject: { contains: q, mode: 'insensitive' } },
        { requester: { is: { name: { contains: q, mode: 'insensitive' } } } },
      ];
      const asNumber = parseInt(q.replace(/^#/, ''), 10);
      if (Number.isFinite(asNumber)) {
        orClauses.push({ freshserviceTicketId: asNumber });
      }
      clause.OR = orClauses;
    }
  }

  return clause;
}

class AssignmentRepository {
  // ─── Assignment Config ────────────────────────────────────────────────

  async getConfig(workspaceId) {
    try {
      return await prisma.assignmentConfig.findUnique({
        where: { workspaceId },
      });
    } catch (error) {
      logger.error('Error fetching assignment config:', error);
      throw new DatabaseError('Failed to fetch assignment config', error);
    }
  }

  async upsertConfig(workspaceId, data) {
    try {
      return await prisma.assignmentConfig.upsert({
        where: { workspaceId },
        create: { workspaceId, ...data },
        update: data,
      });
    } catch (error) {
      logger.error('Error upserting assignment config:', error);
      throw new DatabaseError('Failed to upsert assignment config', error);
    }
  }

  async isEnabled(workspaceId) {
    try {
      const cfg = await prisma.assignmentConfig.findUnique({
        where: { workspaceId },
        select: { isEnabled: true },
      });
      return cfg?.isEnabled === true;
    } catch (error) {
      logger.error('Error checking assignment enabled:', error);
      return false;
    }
  }

  async appendFeedback(workspaceId, feedbackEntry) {
    try {
      const cfg = await prisma.assignmentConfig.findUnique({
        where: { workspaceId },
        select: { feedbackContext: true },
      });
      const existing = cfg?.feedbackContext || '';
      const updated = existing
        ? `${existing}\n---\n${feedbackEntry}`
        : feedbackEntry;
      return await prisma.assignmentConfig.update({
        where: { workspaceId },
        data: { feedbackContext: updated },
      });
    } catch (error) {
      logger.error('Error appending feedback:', error);
      throw new DatabaseError('Failed to append feedback', error);
    }
  }

  // ─── Pipeline Runs ────────────────────────────────────────────────────

  async createPipelineRun(data) {
    try {
      return await prisma.assignmentPipelineRun.create({ data });
    } catch (error) {
      logger.error('Error creating pipeline run:', error);
      throw new DatabaseError('Failed to create pipeline run', error);
    }
  }

  async updatePipelineRun(id, data) {
    try {
      return await prisma.assignmentPipelineRun.update({ where: { id }, data });
    } catch (error) {
      logger.error('Error updating pipeline run:', error);
      throw new DatabaseError('Failed to update pipeline run', error);
    }
  }

  async getPipelineRun(id) {
    try {
      await this.sweepStaleRunningRuns();
      const run = await prisma.assignmentPipelineRun.findUnique({
        where: { id },
        include: {
          steps: { orderBy: { stepNumber: 'asc' } },
          ticket: {
            select: {
              id: true,
              freshserviceTicketId: true,
              subject: true,
              description: true,
              descriptionText: true,
              status: true,
              priority: true,
              category: true,
              ticketCategory: true,
              internalCategory: { select: { id: true, name: true } },
              internalSubcategory: { select: { id: true, name: true, parentId: true } },
              internalCategoryConfidence: true,
              internalCategoryRationale: true,
              internalCategoryFit: true,
              internalSubcategoryFit: true,
              taxonomyReviewNeeded: true,
              suggestedInternalCategoryName: true,
              suggestedInternalSubcategoryName: true,
              assignedTechId: true,
              createdAt: true,
              updatedAt: true,
              requester: { select: { name: true, email: true, department: true } },
              assignedTech: { select: { id: true, name: true } },
            },
          },
          assignedTech: { select: { id: true, name: true, email: true } },
        },
      });
      if (!run) throw new NotFoundError(`Pipeline run ${id} not found`);
      return run;
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      logger.error('Error fetching pipeline run:', error);
      throw new DatabaseError('Failed to fetch pipeline run', error);
    }
  }

  async getPendingQueue(workspaceId, {
    limit = 50,
    offset = 0,
    assignmentStatus = 'all',
    ticketStatus = 'all',
    since,
    sinceField,
    priorities,
    statuses,
    assignedTechIds,
    reboundFromTechIds,
    search,
  } = {}) {
    try {
      await this.sweepStaleRunningRuns(workspaceId);

      // Base query: pipeline runs awaiting review (excluding deleted tickets, which live on the Deleted tab).
      const baseTicketFilter = buildTicketStatusFilter('all'); // 'all' = excludes deleted
      const baseWhere = { workspaceId, decision: 'pending_review', status: 'completed', ...baseTicketFilter };

      // Apply time-range filter (used by the 24h / 7d / 30d / All toggle)
      if (since) {
        const field = sinceField === 'decidedAt' ? 'decidedAt' : 'createdAt';
        baseWhere[field] = { gte: new Date(since) };
      }

      // Apply ticket-status filter for the items we return (used by secondary status pills).
      const ticketStatusFilter = buildTicketStatusFilter(ticketStatus);
      const ticketStatusWhere = ticketStatus === 'all' ? baseTicketFilter : ticketStatusFilter;

      // Apply assignment-state filter (unassigned vs outside_assigned vs all)
      let assignmentClause = {};
      if (assignmentStatus === 'unassigned') {
        assignmentClause = { ticket: { is: { ...ticketStatusWhere.ticket.is, assignedTechId: null } } };
      } else if (assignmentStatus === 'outside_assigned') {
        assignmentClause = { ticket: { is: { ...ticketStatusWhere.ticket.is, assignedTechId: { not: null } } } };
      } else {
        assignmentClause = ticketStatusWhere;
      }

      // Build itemsWhere by extending baseWhere so it inherits the time-range filter (since).
      // The assignmentClause's `ticket` field overrides baseWhere's `ticket` field via spread.
      const itemsWhere = { ...baseWhere, ...assignmentClause };

      // Layer the modern multi-select filters into the items-only `ticket.is` clause.
      // Counts (totalAll / totalUnassigned / totalOutsideAssigned) intentionally
      // ignore these so the tab badges keep showing the unfiltered scope —
      // matches the Decided sub-tab counts which are also unfiltered by Source/Status.
      const advancedTicketClause = buildAdvancedTicketFilter({ priorities, statuses, assignedTechIds, reboundFromTechIds, search });
      if (Object.keys(advancedTicketClause).length > 0) {
        // Multi-status (when given) takes precedence over the single ticketStatus value.
        const merged = { ...itemsWhere.ticket.is, ...advancedTicketClause };
        itemsWhere.ticket = { is: merged };
      }

      // For the Awaiting Review tab count, restrict to ACTIVE tickets (open or pending) - excludes
      // closed/resolved tickets that are technically still in our pending_review queue but no
      // longer actionable. The user only wants "things truly waiting on me to decide".
      const activeTicketFilter = buildTicketStatusFilter('active');
      const baseActiveWhere = { ...baseWhere, ticket: { is: { ...activeTicketFilter.ticket.is } } };

      // In-progress runs (status='running'): pipeline is actively analyzing
      // these tickets right now. Returned as a separate `inProgress` array
      // so the UI can show "Analyzing..." indicators without inflating the
      // Awaiting Decision count or messing with the existing filters.
      const inProgressWhere = {
        workspaceId,
        status: 'running',
        ...activeTicketFilter,
      };

      const [items, totalAll, totalUnassigned, totalOutsideAssigned, filteredTotal, inProgress] = await Promise.all([
        prisma.assignmentPipelineRun.findMany({
          where: itemsWhere,
          include: {
            ticket: {
              select: {
                id: true,
                freshserviceTicketId: true,
                subject: true,
                status: true,
                priority: true,
                category: true,
                ticketCategory: true,
                internalCategory: { select: { id: true, name: true } },
                internalSubcategory: { select: { id: true, name: true, parentId: true } },
                internalCategoryConfidence: true,
                internalCategoryRationale: true,
                internalCategoryFit: true,
                internalSubcategoryFit: true,
                taxonomyReviewNeeded: true,
                suggestedInternalCategoryName: true,
                suggestedInternalSubcategoryName: true,
                assignedTechId: true,
                createdAt: true,
                rejectionCount: true,
                requester: { select: { name: true, email: true } },
                assignedTech: { select: { id: true, name: true } },
              },
            },
            assignedTech: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }),
        prisma.assignmentPipelineRun.count({ where: baseWhere }),
        prisma.assignmentPipelineRun.count({
          where: { ...baseActiveWhere, ticket: { is: { ...activeTicketFilter.ticket.is, assignedTechId: null } } },
        }),
        prisma.assignmentPipelineRun.count({
          where: { ...baseWhere, ticket: { is: { ...baseTicketFilter.ticket.is, assignedTechId: { not: null } } } },
        }),
        prisma.assignmentPipelineRun.count({ where: itemsWhere }),
        prisma.assignmentPipelineRun.findMany({
          where: inProgressWhere,
          select: {
            id: true,
            triggerSource: true,
            createdAt: true,
            ticket: {
              select: {
                id: true,
                freshserviceTicketId: true,
                subject: true,
                priority: true,
                requester: { select: { name: true, email: true } },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
      ]);

      await this._enrichRunsWithReboundContext(items);

      return {
        items,
        total: filteredTotal,
        totals: {
          all: totalAll,
          unassigned: totalUnassigned,
          outsideAssigned: totalOutsideAssigned,
        },
        inProgress,
      };
    } catch (error) {
      logger.error('Error fetching pending queue:', error);
      throw new DatabaseError('Failed to fetch pending queue', error);
    }
  }

  async getPipelineRuns(workspaceId, {
    limit = 50,
    offset = 0,
    status,
    decision,
    since,
    sinceField,
    decisions,
    ticketStatus,
    priorities,
    statuses,
    assignedTechIds,
    reboundFromTechIds,
    search,
  } = {}) {
    try {
      await this.sweepStaleRunningRuns(workspaceId);
      const where = { workspaceId };
      if (status) where.status = status;
      if (decision) where.decision = decision;
      if (decisions) where.decision = { in: decisions };
      if (since) {
        const field = sinceField === 'decidedAt' ? 'decidedAt' : 'createdAt';
        where[field] = { gte: new Date(since) };
      }
      // Apply ticket-status filter (defaults to excluding deleted tickets when not specified)
      const ticketFilter = buildTicketStatusFilter(ticketStatus);
      if (ticketFilter.ticket) where.ticket = ticketFilter.ticket;

      // Layer the modern multi-select filters on top. When `statuses` is provided
      // it overrides the single `ticketStatus` value (the multi-select wins).
      const advancedTicketClause = buildAdvancedTicketFilter({ priorities, statuses, assignedTechIds, reboundFromTechIds, search });
      if (Object.keys(advancedTicketClause).length > 0) {
        const baseTicketIs = where.ticket?.is || {};
        where.ticket = { is: { ...baseTicketIs, ...advancedTicketClause } };
      }

      const [items, total] = await Promise.all([
        prisma.assignmentPipelineRun.findMany({
          where,
          include: {
            ticket: {
              select: {
                id: true,
                freshserviceTicketId: true,
                subject: true,
                status: true,
                priority: true,
                category: true,
                ticketCategory: true,
                internalCategory: { select: { id: true, name: true } },
                internalSubcategory: { select: { id: true, name: true, parentId: true } },
                internalCategoryConfidence: true,
                internalCategoryRationale: true,
                internalCategoryFit: true,
                internalSubcategoryFit: true,
                taxonomyReviewNeeded: true,
                suggestedInternalCategoryName: true,
                suggestedInternalSubcategoryName: true,
                assignedTechId: true,
                createdAt: true,
                rejectionCount: true,
                requester: { select: { name: true, email: true, department: true } },
                assignedTech: { select: { id: true, name: true } },
              },
            },
            assignedTech: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }),
        prisma.assignmentPipelineRun.count({ where }),
      ]);
      await this._enrichRunsWithReboundContext(items);
      return { items, total };
    } catch (error) {
      logger.error('Error fetching pipeline runs:', error);
      throw new DatabaseError('Failed to fetch pipeline runs', error);
    }
  }

  /**
   * Enrich a list of pipeline runs with `ticket.lastReboundContext` —
   * the most recent rejected episode for the ticket. This lets the UI
   * show a "Returned from X" badge on ANY run for a ticket that has
   * been bounced before, not just on the rebound run itself. Necessary
   * because rebound runs can be skipped_stale (e.g. someone external
   * grabbed the ticket before the drain ran), and in that case nothing
   * with `reboundFrom` set ever reaches the visible queue/decided
   * lists.
   */
  async _enrichRunsWithReboundContext(items) {
    if (!Array.isArray(items) || items.length === 0) return items;
    const ticketIds = [...new Set(items.map((i) => i.ticket?.id).filter(Boolean))];
    if (ticketIds.length === 0) return items;

    const episodes = await prisma.ticketAssignmentEpisode.findMany({
      where: { ticketId: { in: ticketIds }, endMethod: 'rejected' },
      orderBy: { endedAt: 'desc' },
      select: {
        ticketId: true,
        endedAt: true,
        endActorName: true,
        technician: { select: { id: true, name: true } },
      },
    });

    // Pick the most recent rejection per ticket
    const latestByTicket = new Map();
    for (const ep of episodes) {
      if (!latestByTicket.has(ep.ticketId)) {
        latestByTicket.set(ep.ticketId, ep);
      }
    }

    // Count rejections per ticket
    const countByTicket = new Map();
    for (const ep of episodes) {
      countByTicket.set(ep.ticketId, (countByTicket.get(ep.ticketId) || 0) + 1);
    }

    for (const item of items) {
      const tid = item.ticket?.id;
      if (!tid) continue;
      const ep = latestByTicket.get(tid);
      if (!ep) continue;
      item.ticket.lastReboundContext = {
        previousTechId: ep.technician?.id || null,
        previousTechName: ep.technician?.name || 'Unknown',
        unassignedAt: ep.endedAt ? ep.endedAt.toISOString() : null,
        unassignedByName: ep.endActorName || null,
        reboundCount: countByTicket.get(tid) || 1,
      };
    }
    return items;
  }

  // ─── Open-run dedupe (covers queued + running) ─────────────────────────

  async getOpenPipelineRun(ticketId) {
    try {
      await this.sweepStaleRunningRuns();
      return await prisma.assignmentPipelineRun.findFirst({
        where: { ticketId, status: { in: ['queued', 'running'] } },
        select: { id: true, status: true, decision: true, queuedReason: true },
        orderBy: { createdAt: 'desc' },
      });
    } catch (error) {
      logger.error('Error checking open pipeline run:', error);
      return null;
    }
  }

  async hasActivePipelineRun(ticketId) {
    const run = await this.getOpenPipelineRun(ticketId);
    return Boolean(run);
  }

  // ─── Queue-specific methods ────────────────────────────────────────────

  async createQueuedRun({ ticketId, workspaceId, triggerSource, queuedReason, reboundFrom = null }) {
    try {
      return await prisma.assignmentPipelineRun.create({
        data: {
          ticketId,
          workspaceId,
          status: 'queued',
          triggerSource,
          queuedAt: new Date(),
          queuedReason,
          reboundFrom: reboundFrom || undefined,
        },
      });
    } catch (error) {
      logger.error('Error creating queued run:', error);
      throw new DatabaseError('Failed to create queued run', error);
    }
  }

  async listQueuedRuns(workspaceId, limit = 50) {
    try {
      return await prisma.assignmentPipelineRun.findMany({
        where: { workspaceId, status: 'queued' },
        include: {
          ticket: {
            select: {
              id: true,
              freshserviceTicketId: true,
              subject: true,
              priority: true,
              category: true,
              status: true,
              assignedTechId: true,
              createdAt: true,
              requester: { select: { name: true, email: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
        take: limit,
      });
    } catch (error) {
      logger.error('Error listing queued runs:', error);
      throw new DatabaseError('Failed to list queued runs', error);
    }
  }

  async claimQueuedRun(runId) {
    try {
      const result = await prisma.assignmentPipelineRun.updateMany({
        where: { id: runId, status: 'queued' },
        data: { status: 'running', claimedAt: new Date() },
      });
      return result.count > 0;
    } catch (error) {
      logger.error('Error claiming queued run:', error);
      return false;
    }
  }

  async markRunSuperseded(runId, reason) {
    try {
      return await prisma.assignmentPipelineRun.update({
        where: { id: runId },
        data: {
          status: 'superseded',
          errorMessage: reason,
        },
      });
    } catch (error) {
      logger.error('Error marking run superseded:', error);
      throw new DatabaseError('Failed to mark run superseded', error);
    }
  }

  async markRunSkippedStale(runId, reason) {
    try {
      return await prisma.assignmentPipelineRun.update({
        where: { id: runId },
        data: {
          status: 'skipped_stale',
          errorMessage: reason,
        },
      });
    } catch (error) {
      logger.error('Error marking run skipped_stale:', error);
      throw new DatabaseError('Failed to mark run skipped_stale', error);
    }
  }

  async countQueuedRuns(workspaceId) {
    try {
      return await prisma.assignmentPipelineRun.count({
        where: { workspaceId, status: 'queued' },
      });
    } catch (error) {
      logger.error('Error counting queued runs:', error);
      return 0;
    }
  }

  async touchPipelineRun(id) {
    try {
      await prisma.$executeRawUnsafe(
        'UPDATE assignment_pipeline_runs SET updated_at = NOW() WHERE id = $1',
        id,
      );
    } catch (error) {
      logger.warn('Error touching pipeline run heartbeat:', { id, error: error.message });
    }
  }

  /**
   * Find pipeline runs whose decision was finalized (auto_assigned or
   * noise_dismissed) but whose FreshService sync never completed. This
   * catches the gap where the process restarted between "decision saved"
   * and "syncStatus updated" — the fire-and-forget execute() call dies
   * mid-flight and the run is left permanently stuck (decision saved in
   * our DB, but FS was never told).
   *
   * Returns the orphan runs so the caller can re-trigger
   * freshServiceActionService.execute() for each one. Threshold is
   * conservative (5 min) so we don't fight an in-flight sync that's just
   * slow.
   *
   * @param {object} [opts]
   * @param {number|null} [opts.workspaceId]
   * @param {number} [opts.olderThanMinutes=5]
   * @returns {Promise<Array<{id:number, workspaceId:number, decision:string, decidedAt:Date, syncStatus:string|null}>>}
   */
  async findOrphanedSyncRuns({ workspaceId = null, olderThanMinutes = 5 } = {}) {
    try {
      const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
      const where = {
        status: 'completed',
        decision: { in: ['auto_assigned', 'noise_dismissed'] },
        OR: [{ syncStatus: null }, { syncStatus: 'pending' }],
        decidedAt: { lt: cutoff, not: null },
        ...(workspaceId !== null && workspaceId !== undefined ? { workspaceId } : {}),
      };
      return await prisma.assignmentPipelineRun.findMany({
        where,
        select: {
          id: true, workspaceId: true, decision: true,
          decidedAt: true, syncStatus: true, assignedTechId: true,
        },
        orderBy: { decidedAt: 'asc' },
      });
    } catch (error) {
      logger.error('Error finding orphaned sync runs:', error);
      return [];
    }
  }

  async sweepStaleRunningRuns(workspaceId = null) {
    try {
      const staleBefore = new Date(Date.now() - STALE_RUNNING_MINUTES * 60 * 1000);
      const where = {
        status: 'running',
        updatedAt: { lt: staleBefore },
        ...(workspaceId !== null && workspaceId !== undefined ? { workspaceId } : {}),
      };

      const staleRuns = await prisma.assignmentPipelineRun.findMany({
        where,
        select: { id: true },
      });

      if (staleRuns.length === 0) return 0;

      const ids = staleRuns.map((r) => r.id);
      const result = await prisma.assignmentPipelineRun.updateMany({
        where: { id: { in: ids }, status: 'running' },
        data: {
          status: 'failed',
          errorMessage: `Marked stale after ${STALE_RUNNING_MINUTES} minutes without completion`,
        },
      });

      if (result.count > 0) {
        logger.warn('Swept stale running pipeline runs', {
          workspaceId,
          count: result.count,
          runIds: ids,
        });
      }

      return result.count;
    } catch (error) {
      logger.error('Error sweeping stale running runs:', error);
      return 0;
    }
  }

  // ─── Deletion ──────────────────────────────────────────────────────────

  async deletePipelineRun(id) {
    try {
      await prisma.assignmentPipelineStep.deleteMany({ where: { pipelineRunId: id } });
      return await prisma.assignmentPipelineRun.delete({ where: { id } });
    } catch (error) {
      logger.error('Error deleting pipeline run:', error);
      throw new DatabaseError('Failed to delete pipeline run', error);
    }
  }

  async bulkDeleteRuns(workspaceId, { status, decision } = {}) {
    try {
      const where = { workspaceId };
      if (status) where.status = status;
      if (decision) where.decision = decision;

      const runs = await prisma.assignmentPipelineRun.findMany({
        where,
        select: { id: true },
      });
      const runIds = runs.map((r) => r.id);

      if (runIds.length === 0) return { deleted: 0 };

      await prisma.assignmentPipelineStep.deleteMany({
        where: { pipelineRunId: { in: runIds } },
      });
      const result = await prisma.assignmentPipelineRun.deleteMany({ where: { id: { in: runIds } } });
      return { deleted: result.count };
    } catch (error) {
      logger.error('Error bulk deleting pipeline runs:', error);
      throw new DatabaseError('Failed to bulk delete pipeline runs', error);
    }
  }

  // ─── Pipeline Steps ───────────────────────────────────────────────────

  async createPipelineStep(data) {
    try {
      return await prisma.assignmentPipelineStep.create({ data });
    } catch (error) {
      logger.error('Error creating pipeline step:', error);
      throw new DatabaseError('Failed to create pipeline step', error);
    }
  }

  async updatePipelineStep(id, data) {
    try {
      return await prisma.assignmentPipelineStep.update({ where: { id }, data });
    } catch (error) {
      logger.error('Error updating pipeline step:', error);
      throw new DatabaseError('Failed to update pipeline step', error);
    }
  }

  // ─── Decision ─────────────────────────────────────────────────────────

  async recordDecision(runId, { decision, assignedTechId, decidedByEmail, overrideReason, decisionNote }) {
    try {
      return await prisma.assignmentPipelineRun.update({
        where: { id: runId },
        data: {
          decision,
          assignedTechId,
          decidedByEmail,
          decidedAt: new Date(),
          overrideReason,
          decisionNote: decisionNote || null,
        },
      });
    } catch (error) {
      logger.error('Error recording decision:', error);
      throw new DatabaseError('Failed to record decision', error);
    }
  }

  async recordDecisionIfPending(runId, {
    decision,
    assignedTechId,
    decidedByEmail,
    overrideReason,
    decisionNote,
  }) {
    try {
      const decidedAt = new Date();
      const result = await prisma.assignmentPipelineRun.updateMany({
        where: {
          id: runId,
          status: 'completed',
          decision: 'pending_review',
        },
        data: {
          decision,
          assignedTechId,
          decidedByEmail,
          decidedAt,
          overrideReason,
          decisionNote: decisionNote || null,
        },
      });

      if (result.count === 0) {
        return null;
      }

      return await prisma.assignmentPipelineRun.findUnique({ where: { id: runId } });
    } catch (error) {
      logger.error('Error recording guarded decision:', error);
      throw new DatabaseError('Failed to record decision', error);
    }
  }

  async dismissRunIfPending(runId, decidedByEmail) {
    try {
      const result = await prisma.assignmentPipelineRun.updateMany({
        where: {
          id: runId,
          status: 'completed',
          decision: 'pending_review',
        },
        data: {
          decision: 'noise_dismissed',
          decidedAt: new Date(),
          decidedByEmail,
        },
      });

      return result.count > 0;
    } catch (error) {
      logger.error('Error dismissing guarded run:', error);
      throw new DatabaseError('Failed to dismiss run', error);
    }
  }
}

export default new AssignmentRepository();
