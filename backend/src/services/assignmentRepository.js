import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { DatabaseError, NotFoundError } from '../utils/errors.js';

const STALE_RUNNING_MINUTES = 30;

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
              status: true,
              priority: true,
              category: true,
              ticketCategory: true,
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

  async getPendingQueue(workspaceId, { limit = 50, offset = 0 } = {}) {
    try {
      await this.sweepStaleRunningRuns(workspaceId);
      const [items, total] = await Promise.all([
        prisma.assignmentPipelineRun.findMany({
          where: { workspaceId, decision: 'pending_review', status: 'completed' },
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
                assignedTechId: true,
                createdAt: true,
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
        prisma.assignmentPipelineRun.count({
          where: { workspaceId, decision: 'pending_review', status: 'completed' },
        }),
      ]);
      return { items, total };
    } catch (error) {
      logger.error('Error fetching pending queue:', error);
      throw new DatabaseError('Failed to fetch pending queue', error);
    }
  }

  async getPipelineRuns(workspaceId, { limit = 50, offset = 0, status, decision, since, sinceField, decisions } = {}) {
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
                assignedTechId: true,
                createdAt: true,
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
      return { items, total };
    } catch (error) {
      logger.error('Error fetching pipeline runs:', error);
      throw new DatabaseError('Failed to fetch pipeline runs', error);
    }
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

  // ─── Queue-specific methods ────────────────────────────────────────────

  async createQueuedRun({ ticketId, workspaceId, triggerSource, queuedReason }) {
    try {
      return await prisma.assignmentPipelineRun.create({
        data: {
          ticketId,
          workspaceId,
          status: 'queued',
          triggerSource,
          queuedAt: new Date(),
          queuedReason,
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
}

export default new AssignmentRepository();
