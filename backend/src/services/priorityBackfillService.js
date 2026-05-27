import prisma from './prisma.js';
import assignmentPipelineService from './assignmentPipelineService.js';
import { isSkillHierarchyWorkspace } from '../utils/workspaceFeatureFlags.js';
import logger from '../utils/logger.js';

const ACTIVE_STATUS_VALUES = Object.freeze(['Open', 'open', '2', 'Pending', 'pending', '3']);
const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizePriorityBackfillOptions(options = {}) {
  const days = Math.max(1, Math.min(90, parseInt(options.days, 10) || 14));
  const limit = Math.max(1, Math.min(100, parseInt(options.limit, 10) || 25));
  return { days, limit };
}

class PriorityBackfillService {
  async findCandidates(workspaceId, options = {}) {
    const { days, limit } = normalizePriorityBackfillOptions(options);
    if (!isSkillHierarchyWorkspace(workspaceId)) {
      return {
        skipped: true,
        reason: 'workspace_not_in_scope',
        workspaceId,
        days,
        limit,
        candidates: [],
      };
    }

    const since = new Date(Date.now() - (days * DAY_MS));
    const tickets = await prisma.ticket.findMany({
      where: {
        workspaceId,
        assessedPriority: null,
        isNoise: false,
        status: { in: ACTIVE_STATUS_VALUES },
        createdAt: { gte: since },
      },
      select: {
        id: true,
        freshserviceTicketId: true,
        subject: true,
        status: true,
        priority: true,
        createdAt: true,
        assignedTechId: true,
        requester: { select: { name: true, email: true } },
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });

    return {
      skipped: false,
      workspaceId,
      days,
      limit,
      since,
      count: tickets.length,
      candidates: tickets,
    };
  }

  async startRuns(workspaceId, candidates = []) {
    const started = [];
    for (const ticket of candidates) {
      try {
        const result = await assignmentPipelineService.runPipeline(
          ticket.id,
          workspaceId,
          'priority_assessment_only',
          null,
          null,
          { priorityBackfill: true },
        );
        started.push({
          ticketId: ticket.id,
          freshserviceTicketId: ticket.freshserviceTicketId,
          runId: result?.id || result?.runId || null,
          skipped: !!result?.skipped,
          reason: result?.reason || null,
        });
      } catch (error) {
        logger.error('Priority assessment backfill run failed', {
          workspaceId,
          ticketId: ticket.id,
          error: error.message,
        });
        started.push({
          ticketId: ticket.id,
          freshserviceTicketId: ticket.freshserviceTicketId,
          error: error.message,
        });
      }
    }
    return started;
  }

  async planOrStart(workspaceId, options = {}) {
    const candidateResult = await this.findCandidates(workspaceId, options);
    if (candidateResult.skipped || !options.run) {
      return { ...candidateResult, started: [] };
    }

    const started = await this.startRuns(workspaceId, candidateResult.candidates);
    return { ...candidateResult, started };
  }
}

export default new PriorityBackfillService();
