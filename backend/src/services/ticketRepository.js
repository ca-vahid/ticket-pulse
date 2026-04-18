import logger from '../utils/logger.js';
import { getTodayRange } from '../utils/timezone.js';
import { DatabaseError, NotFoundError } from '../utils/errors.js';
import prisma from './prisma.js';

/**
 * Repository for Ticket operations
 */
class TicketRepository {
  /**
   * Get all tickets created today (timezone-aware)
   * @param {string} timezone - Timezone for "today" calculation
   * @param {number|null} workspaceId - When set, restrict to this workspace
   * @returns {Promise<Array>} Array of tickets
   */
  async getAllToday(timezone = 'America/Los_Angeles', workspaceId = null) {
    try {
      const { start, end } = getTodayRange(timezone);

      const where = {
        createdAt: {
          gte: start,
          lte: end,
        },
      };
      if (workspaceId !== null) where.workspaceId = workspaceId;

      return await prisma.ticket.findMany({
        where,
        include: {
          assignedTech: true,
          requester: true,
        },
        orderBy: { createdAt: 'desc' },
      });
    } catch (error) {
      logger.error('Error fetching today\'s tickets:', error);
      throw new DatabaseError('Failed to fetch today\'s tickets', error);
    }
  }

  /**
   * Get all tickets assigned to a specific technician
   * @param {number} technicianId - Internal technician ID
   * @returns {Promise<Array>} Array of tickets
   */
  async getByTechnicianId(technicianId) {
    try {
      return await prisma.ticket.findMany({
        where: { assignedTechId: technicianId },
        include: {
          assignedTech: true,
          requester: true,
        },
        orderBy: { createdAt: 'desc' },
      });
    } catch (error) {
      logger.error(`Error fetching tickets for technician ${technicianId}:`, error);
      throw new DatabaseError(`Failed to fetch tickets for technician ${technicianId}`, error);
    }
  }

  /**
   * Get open tickets assigned to a specific technician
   * @param {number} technicianId - Internal technician ID
   * @returns {Promise<Array>} Array of open tickets
   */
  async getOpenByTechnicianId(technicianId) {
    try {
      return await prisma.ticket.findMany({
        where: {
          assignedTechId: technicianId,
          status: {
            in: ['Open', 'Pending', 'In Progress'],
          },
        },
        include: {
          assignedTech: true,
          requester: true,
        },
        orderBy: { createdAt: 'asc' },
      });
    } catch (error) {
      logger.error(`Error fetching open tickets for technician ${technicianId}:`, error);
      throw new DatabaseError(`Failed to fetch open tickets for technician ${technicianId}`, error);
    }
  }

  /**
   * Get ticket by FreshService ticket ID
   * @param {number} freshserviceTicketId - FreshService ticket ID
   * @returns {Promise<Object|null>} Ticket object or null
   */
  async getByFreshserviceId(freshserviceTicketId) {
    try {
      return await prisma.ticket.findUnique({
        where: { freshserviceTicketId: BigInt(freshserviceTicketId) },
        include: {
          assignedTech: true,
          requester: true,
        },
      });
    } catch (error) {
      logger.error(`Error fetching ticket ${freshserviceTicketId}:`, error);
      throw new DatabaseError(`Failed to fetch ticket ${freshserviceTicketId}`, error);
    }
  }

  /**
   * Batch fetch tickets by multiple FreshService ticket IDs
   * @param {Array<number>} freshserviceTicketIds - Array of FreshService ticket IDs
   * @returns {Promise<Array>} Array of tickets
   */
  async getByFreshserviceIds(freshserviceTicketIds) {
    try {
      return await prisma.ticket.findMany({
        where: {
          freshserviceTicketId: {
            in: freshserviceTicketIds.map(id => BigInt(id)),
          },
        },
        include: {
          assignedTech: true,
          requester: true,
        },
      });
    } catch (error) {
      logger.error(`Error batch fetching ${freshserviceTicketIds.length} tickets:`, error);
      throw new DatabaseError('Failed to batch fetch tickets', error);
    }
  }

  /**
   * Create a new ticket
   * @param {Object} data - Ticket data
   * @returns {Promise<Object>} Created ticket
   */
  async create(data) {
    try {
      return await prisma.ticket.create({
        data: {
          freshserviceTicketId: BigInt(data.freshserviceTicketId),
          subject: data.subject,
          status: data.status,
          priority: data.priority || 3,
          assignedTechId: data.assignedTechId || null,
          isSelfPicked: data.isSelfPicked || false,
          workspaceId: data.workspaceId || 1,
          createdAt: data.createdAt ? new Date(data.createdAt) : undefined,
          updatedAt: data.updatedAt ? new Date(data.updatedAt) : undefined,
        },
        include: {
          assignedTech: true,
          requester: true,
        },
      });
    } catch (error) {
      logger.error('Error creating ticket:', error);
      throw new DatabaseError('Failed to create ticket', error);
    }
  }

  /**
   * Update ticket data
   * @param {number} freshserviceTicketId - FreshService ticket ID
   * @param {Object} data - Updated ticket data
   * @returns {Promise<Object>} Updated ticket
   */
  async update(freshserviceTicketId, data) {
    try {
      const updateData = {};
      if (data.subject !== undefined) updateData.subject = data.subject;
      if (data.status !== undefined) updateData.status = data.status;
      if (data.priority !== undefined) updateData.priority = data.priority;
      if (data.assignedTechId !== undefined) updateData.assignedTechId = data.assignedTechId;
      if (data.isSelfPicked !== undefined) updateData.isSelfPicked = data.isSelfPicked;

      updateData.updatedAt = new Date();

      return await prisma.ticket.update({
        where: { freshserviceTicketId: BigInt(freshserviceTicketId) },
        data: updateData,
        include: {
          assignedTech: true,
          requester: true,
        },
      });
    } catch (error) {
      if (error.code === 'P2025') {
        throw new NotFoundError(`Ticket ${freshserviceTicketId} not found`);
      }
      logger.error(`Error updating ticket ${freshserviceTicketId}:`, error);
      throw new DatabaseError(`Failed to update ticket ${freshserviceTicketId}`, error);
    }
  }

  /**
   * Upsert ticket (create or update based on FreshService ticket ID)
   * @param {Object} data - Ticket data
   * @returns {Promise<Object>} Created or updated ticket
   */
  async upsert(data) {
    try {
      const updatePayload = {
        subject: data.subject,
        description: data.description,
        descriptionText: data.descriptionText,
        status: data.status,
        priority: data.priority || 3,
        assignedTechId: data.assignedTechId || null,
        isSelfPicked: data.isSelfPicked || false,
        assignedBy: data.assignedBy || null,
        requesterFreshserviceId: data.requesterId ? BigInt(data.requesterId) : null,
        assignedAt: data.assignedAt,
        resolvedAt: data.resolvedAt,
        closedAt: data.closedAt,
        dueBy: data.dueBy,
        frDueBy: data.frDueBy,
        source: data.source,
        category: data.category,
        subCategory: data.subCategory,
        ticketCategory: data.ticketCategory,
        department: data.department,
        isEscalated: data.isEscalated,
        timeSpentMinutes: data.timeSpentMinutes,
        billableMinutes: data.billableMinutes,
        nonBillableMinutes: data.nonBillableMinutes,
        resolutionTimeSeconds: data.resolutionTimeSeconds,
        firstAssignedAt: data.firstAssignedAt,
        isNoise: data.isNoise ?? undefined,
        noiseRuleMatched: data.noiseRuleMatched ?? undefined,
        groupId: data.groupId !== undefined ? data.groupId : undefined,
        rejectionCount: data.rejectionCount !== undefined ? data.rejectionCount : undefined,
        updatedAt: new Date(),
      };

      if (data.workspaceId !== undefined) {
        updatePayload.workspaceId = data.workspaceId;
      }

      const createPayload = {
        freshserviceTicketId: BigInt(data.freshserviceTicketId),
        subject: data.subject,
        description: data.description,
        descriptionText: data.descriptionText,
        status: data.status,
        priority: data.priority || 3,
        assignedTechId: data.assignedTechId || null,
        isSelfPicked: data.isSelfPicked || false,
        assignedBy: data.assignedBy || null,
        requesterFreshserviceId: data.requesterId ? BigInt(data.requesterId) : null,
        createdAt: data.createdAt ? new Date(data.createdAt) : undefined,
        assignedAt: data.assignedAt,
        resolvedAt: data.resolvedAt,
        closedAt: data.closedAt,
        dueBy: data.dueBy,
        frDueBy: data.frDueBy,
        source: data.source,
        category: data.category,
        subCategory: data.subCategory,
        ticketCategory: data.ticketCategory,
        department: data.department,
        isEscalated: data.isEscalated,
        timeSpentMinutes: data.timeSpentMinutes,
        billableMinutes: data.billableMinutes,
        nonBillableMinutes: data.nonBillableMinutes,
        resolutionTimeSeconds: data.resolutionTimeSeconds,
        firstAssignedAt: data.firstAssignedAt,
        isNoise: data.isNoise || false,
        noiseRuleMatched: data.noiseRuleMatched || null,
        groupId: data.groupId || null,
        rejectionCount: data.rejectionCount || 0,
        workspaceId: data.workspaceId || 1,
      };

      return await prisma.ticket.upsert({
        where: { freshserviceTicketId: BigInt(data.freshserviceTicketId) },
        update: updatePayload,
        create: createPayload,
        include: {
          assignedTech: true,
          requester: true,
        },
      });
    } catch (error) {
      logger.error('Error upserting ticket:', error);
      throw new DatabaseError('Failed to upsert ticket', error);
    }
  }

  /**
   * Get ticket count statistics
   * @param {string} timezone - Timezone for "today" calculation
   * @param {Date} date - Optional date to get stats for (defaults to today)
   * @param {number|null} workspaceId - When set, restrict to this workspace
   * @returns {Promise<Object>} Count statistics
   */
  async getStats(timezone = 'America/Los_Angeles', date = null, workspaceId = null) {
    try {
      const { start, end } = getTodayRange(timezone, date);

      const workspaceClause = workspaceId !== null ? { workspaceId } : {};

      const [totalToday, openToday, closedToday, selfPickedToday] = await Promise.all([
        prisma.ticket.count({
          where: {
            createdAt: { gte: start, lte: end },
            ...workspaceClause,
          },
        }),
        prisma.ticket.count({
          where: {
            createdAt: { gte: start, lte: end },
            status: { in: ['Open', 'Pending', 'In Progress'] },
            ...workspaceClause,
          },
        }),
        prisma.ticket.count({
          where: {
            createdAt: { gte: start, lte: end },
            status: { in: ['Resolved', 'Closed'] },
            ...workspaceClause,
          },
        }),
        prisma.ticket.count({
          where: {
            createdAt: { gte: start, lte: end },
            isSelfPicked: true,
            ...workspaceClause,
          },
        }),
      ]);

      return {
        totalToday,
        openToday,
        closedToday,
        selfPickedToday,
      };
    } catch (error) {
      logger.error('Error fetching ticket stats:', error);
      throw new DatabaseError('Failed to fetch ticket statistics', error);
    }
  }

  /**
   * Update ticket by FreshService ticket ID
   * @param {number} freshserviceTicketId - FreshService ticket ID
   * @param {Object} data - Data to update
   * @returns {Promise<Object>} Updated ticket
   */
  async updateByFreshserviceId(freshserviceTicketId, data) {
    try {
      return await prisma.ticket.update({
        where: { freshserviceTicketId: BigInt(freshserviceTicketId) },
        data,
      });
    } catch (error) {
      logger.error(`Error updating ticket ${freshserviceTicketId}:`, error);
      throw new DatabaseError(`Failed to update ticket ${freshserviceTicketId}`, error);
    }
  }

  /**
   * Get recent closed/resolved tickets without CSAT responses
   * @param {Date} cutoffDate - Only get tickets closed/resolved after this date
   * @param {number|null} workspaceId - When set, restrict to this workspace
   * @returns {Promise<Array>} Array of tickets
   */
  /**
   * Get recent closed/resolved tickets without CSAT responses.
   *
   * Picks tickets in a smart order so we walk through the backlog instead of
   * re-checking the same 30 freshly-synced tickets every cycle:
   *  - Never-checked tickets first (csat_checked_at NULL)
   *  - Then oldest-checked-first
   *  - Skips tickets checked within the last `minRecheckHours` hours
   *
   * closedAt/resolvedAt are used when populated; updatedAt is the robust
   * fallback since those two fields are NULL for most historical tickets.
   *
   * @param {Date} cutoffDate - Only consider tickets with activity since this date
   * @param {number|null} workspaceId
   * @param {number} [limit] - Optional cap (default 500)
   * @param {number} [minRecheckHours=24] - Don't re-check a ticket within this window
   */
  async getRecentClosedWithoutCSAT(cutoffDate, workspaceId = null, limit = 500, minRecheckHours = 24) {
    try {
      const recheckCutoff = new Date(Date.now() - minRecheckHours * 3600 * 1000);
      const where = {
        status: { in: ['Resolved', 'Closed'] },
        OR: [
          { closedAt: { gte: cutoffDate } },
          { resolvedAt: { gte: cutoffDate } },
          { updatedAt: { gte: cutoffDate } },
        ],
        csatResponseId: null,
        // Either never checked, OR last checked more than minRecheckHours ago
        AND: [
          {
            OR: [
              { csatCheckedAt: null },
              { csatCheckedAt: { lt: recheckCutoff } },
            ],
          },
        ],
      };
      if (workspaceId !== null) where.workspaceId = workspaceId;

      return await prisma.ticket.findMany({
        where,
        select: {
          id: true,
          freshserviceTicketId: true,
          subject: true,
          status: true,
          closedAt: true,
          resolvedAt: true,
          updatedAt: true,
          csatCheckedAt: true,
        },
        // Priority:
        //  1. Never-checked tickets first (csatCheckedAt NULL)
        //  2. Within that bucket, NEWEST tickets first — CSAT surveys land
        //     within days/weeks of closure, so recent tickets are far more
        //     likely to have one waiting. (Previously we fell back to
        //     freshservice_ticket_id ASC which sorted oldest-first → recent
        //     tickets like #217324 at rank 12,000+ never got checked.)
        //  3. For already-checked, oldest-checked-first rotates the backlog.
        orderBy: [
          { csatCheckedAt: { sort: 'asc', nulls: 'first' } },
          { createdAt: 'desc' },
        ],
        take: limit,
      });
    } catch (error) {
      logger.error('Error fetching recent closed tickets without CSAT:', error);
      throw new DatabaseError('Failed to fetch recent closed tickets without CSAT', error);
    }
  }

  /**
   * Get all closed/resolved tickets without CSAT responses (for backfill)
   * @param {number} limit - Maximum number of tickets to return
   * @param {number|null} workspaceId - When set, restrict to this workspace
   * @returns {Promise<Array>} Array of tickets
   */
  async getAllClosedWithoutCSAT(limit = 1000, workspaceId = null) {
    try {
      const where = {
        status: { in: ['Resolved', 'Closed'] },
        csatResponseId: null, // No CSAT response yet
      };
      if (workspaceId !== null) where.workspaceId = workspaceId;

      return await prisma.ticket.findMany({
        where,
        select: {
          id: true,
          freshserviceTicketId: true,
          subject: true,
          status: true,
          closedAt: true,
          resolvedAt: true,
        },
        orderBy: [
          { freshserviceTicketId: 'desc' }, // Newest tickets first (higher ID = newer)
        ],
        take: limit,
      });
    } catch (error) {
      logger.error('Error fetching all closed tickets without CSAT:', error);
      throw new DatabaseError('Failed to fetch all closed tickets without CSAT', error);
    }
  }

  /**
   * Count closed/resolved tickets that have no CSAT response
   * @param {number|null} workspaceId - When set, restrict to this workspace
   * @returns {Promise<number>}
   */
  async getCSATPendingCount(workspaceId = null) {
    try {
      const where = {
        status: { in: ['Resolved', 'Closed'] },
        csatResponseId: null,
      };
      if (workspaceId !== null) where.workspaceId = workspaceId;

      return await prisma.ticket.count({
        where,
      });
    } catch (error) {
      logger.error('Error counting CSAT-pending tickets:', error);
      return 0;
    }
  }

  /**
   * Get all tickets with CSAT responses for a specific technician
   * @param {number} technicianId - Internal technician ID
   * @param {number} workspaceId - Workspace scope
   * @returns {Promise<Array>} Array of tickets with CSAT data
   */
  async getTicketsWithCSATByTechnician(technicianId, workspaceId) {
    try {
      return await prisma.ticket.findMany({
        where: {
          assignedTechId: technicianId,
          workspaceId,
          csatScore: { not: null }, // Has CSAT response
        },
        include: {
          requester: true,
        },
        orderBy: [
          { csatScore: 'asc' }, // Lowest scores first (problem tickets)
          { csatSubmittedAt: 'desc' }, // Then by most recent
        ],
      });
    } catch (error) {
      logger.error(`Error fetching CSAT tickets for technician ${technicianId}:`, error);
      throw new DatabaseError(`Failed to fetch CSAT tickets for technician ${technicianId}`, error);
    }
  }

  /**
   * Get CSAT statistics for a technician within a date range
   * @param {number} technicianId - Internal technician ID
   * @param {Date} startDate - Start of date range
   * @param {Date} endDate - End of date range
   * @returns {Promise<Object>} CSAT statistics
   */
  async getCSATStatsByTechnician(technicianId, startDate, endDate) {
    try {
      const tickets = await prisma.ticket.findMany({
        where: {
          assignedTechId: technicianId,
          csatScore: { not: null },
          csatSubmittedAt: {
            gte: startDate,
            lte: endDate,
          },
        },
        select: {
          csatScore: true,
          csatTotalScore: true,
        },
      });

      if (tickets.length === 0) {
        return {
          count: 0,
          average: null,
          total: 0,
        };
      }

      const totalScore = tickets.reduce((sum, t) => sum + (t.csatScore || 0), 0);
      const avgScore = totalScore / tickets.length;

      return {
        count: tickets.length,
        average: parseFloat(avgScore.toFixed(2)),
        total: tickets.length,
      };
    } catch (error) {
      logger.error(`Error fetching CSAT stats for technician ${technicianId}:`, error);
      throw new DatabaseError(`Failed to fetch CSAT stats for technician ${technicianId}`, error);
    }
  }

  /**
   * Clean up old tickets (optional utility for data management)
   * @param {number} daysToKeep - Number of days of ticket history to keep
   * @param {number|null} workspaceId - When set, restrict deletes to this workspace
   * @returns {Promise<number>} Number of tickets deleted
   */
  async cleanOldTickets(daysToKeep = 90, workspaceId = null) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      const where = {
        createdAt: { lt: cutoffDate },
        status: { in: ['Resolved', 'Closed'] },
      };
      if (workspaceId !== null) where.workspaceId = workspaceId;

      const result = await prisma.ticket.deleteMany({
        where,
      });

      logger.info(`Cleaned up ${result.count} old tickets`);
      return result.count;
    } catch (error) {
      logger.error('Error cleaning old tickets:', error);
      throw new DatabaseError('Failed to clean old tickets', error);
    }
  }
}

export default new TicketRepository();
