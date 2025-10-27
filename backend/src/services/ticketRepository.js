import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger.js';
import { getTodayRange } from '../utils/timezone.js';
import { DatabaseError, NotFoundError } from '../utils/errors.js';

const prisma = new PrismaClient();

/**
 * Repository for Ticket operations
 */
class TicketRepository {
  /**
   * Get all tickets created today (timezone-aware)
   * @param {string} timezone - Timezone for "today" calculation
   * @returns {Promise<Array>} Array of tickets
   */
  async getAllToday(timezone = 'America/Los_Angeles') {
    try {
      const { start, end } = getTodayRange(timezone);

      return await prisma.ticket.findMany({
        where: {
          createdAt: {
            gte: start,
            lte: end,
          },
        },
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
      return await prisma.ticket.upsert({
        where: { freshserviceTicketId: BigInt(data.freshserviceTicketId) },
        update: {
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
          updatedAt: new Date(),
        },
        create: {
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
        },
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
   * @returns {Promise<Object>} Count statistics
   */
  async getStats(timezone = 'America/Los_Angeles', date = null) {
    try {
      const { start, end } = getTodayRange(timezone, date);

      const [totalToday, openToday, closedToday, selfPickedToday] = await Promise.all([
        prisma.ticket.count({
          where: {
            createdAt: { gte: start, lte: end },
          },
        }),
        prisma.ticket.count({
          where: {
            createdAt: { gte: start, lte: end },
            status: { in: ['Open', 'Pending', 'In Progress'] },
          },
        }),
        prisma.ticket.count({
          where: {
            createdAt: { gte: start, lte: end },
            status: { in: ['Resolved', 'Closed'] },
          },
        }),
        prisma.ticket.count({
          where: {
            createdAt: { gte: start, lte: end },
            isSelfPicked: true,
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
   * Clean up old tickets (optional utility for data management)
   * @param {number} daysToKeep - Number of days of ticket history to keep
   * @returns {Promise<number>} Number of tickets deleted
   */
  async cleanOldTickets(daysToKeep = 90) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      const result = await prisma.ticket.deleteMany({
        where: {
          createdAt: { lt: cutoffDate },
          status: { in: ['Resolved', 'Closed'] },
        },
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
