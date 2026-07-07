import logger from '../utils/logger.js';
import { DatabaseError } from '../utils/errors.js';
import prisma from './prisma.js';

/**
 * Repository for TicketActivity operations
 */
class TicketActivityRepository {
  /**
   * Create a new ticket activity
   * @param {Object} data - Activity data
   * @returns {Promise<Object>} Created activity
   */
  async create(data) {
    try {
      return await prisma.ticketActivity.create({
        data: {
          ticketId: data.ticketId,
          activityType: data.activityType,
          performedBy: data.performedBy,
          performedAt: data.performedAt ? new Date(data.performedAt) : new Date(),
          details: data.details || null,
        },
      });
    } catch (error) {
      logger.error('Error creating ticket activity:', error);
      throw new DatabaseError('Failed to create ticket activity', error);
    }
  }

  /**
   * Get all activities for a specific ticket
   * @param {number} ticketId - Ticket ID
   * @param {number} limit - Maximum number of activities to return
   * @returns {Promise<Array>} Array of activities
   */
  async getByTicketId(ticketId, limit = 50) {
    try {
      return await prisma.ticketActivity.findMany({
        where: { ticketId },
        orderBy: { performedAt: 'desc' },
        take: limit,
      });
    } catch (error) {
      logger.error(`Error fetching activities for ticket ${ticketId}:`, error);
      throw new DatabaseError(`Failed to fetch activities for ticket ${ticketId}`, error);
    }
  }

  /**
   * Get the latest assignment activity for a ticket
   * @param {number} ticketId - Ticket ID
   * @returns {Promise<Object|null>} Latest assignment activity or null
   */
  async getLatestAssignmentActivity(ticketId) {
    try {
      return await prisma.ticketActivity.findFirst({
        where: {
          ticketId,
          activityType: 'assigned',
        },
        orderBy: { performedAt: 'desc' },
      });
    } catch (error) {
      logger.error(`Error fetching latest assignment for ticket ${ticketId}:`, error);
      throw new DatabaseError(`Failed to fetch latest assignment for ticket ${ticketId}`, error);
    }
  }

  /**
   * Get all activities for a specific technician (as source or target)
   * @param {number} technicianId - Technician ID
   * @param {number} limit - Maximum number of activities to return
   * @returns {Promise<Array>} Array of activities
   */
  async getByTechnicianId(technicianId, limit = 100) {
    try {
      // JSON containment pushed into SQL (GIN jsonb_path_ops index on details).
      // The old version fetched the 2×limit most-recent rows GLOBALLY and
      // filtered in JS — slow at scale and silently missed older activities.
      const id = Number(technicianId);
      const from = JSON.stringify({ fromTechId: id });
      const to = JSON.stringify({ toTechId: id });
      return await prisma.$queryRaw`
        SELECT * FROM ticket_activities
        WHERE details @> ${from}::jsonb OR details @> ${to}::jsonb
        ORDER BY performed_at DESC
        LIMIT ${Math.max(1, Math.min(Number(limit) || 100, 500))}`;
    } catch (error) {
      logger.error(`Error fetching activities for technician ${technicianId}:`, error);
      throw new DatabaseError(`Failed to fetch activities for technician ${technicianId}`, error);
    }
  }

  /**
   * Get activity statistics for a time range
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   * @returns {Promise<Object>} Activity statistics
   */
  async getStats(startDate, endDate) {
    try {
      const activities = await prisma.ticketActivity.findMany({
        where: {
          performedAt: {
            gte: startDate,
            lte: endDate,
          },
        },
        select: {
          activityType: true,
        },
      });

      const stats = activities.reduce((acc, activity) => {
        acc[activity.activityType] = (acc[activity.activityType] || 0) + 1;
        return acc;
      }, {});

      return {
        total: activities.length,
        byType: stats,
      };
    } catch (error) {
      logger.error('Error fetching activity stats:', error);
      throw new DatabaseError('Failed to fetch activity statistics', error);
    }
  }

  /**
   * Clean up old activities (optional utility for data management)
   * @param {number} daysToKeep - Number of days of activity history to keep
   * @returns {Promise<number>} Number of activities deleted
   */
  async cleanOldActivities(daysToKeep = 90) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      const result = await prisma.ticketActivity.deleteMany({
        where: {
          performedAt: { lt: cutoffDate },
        },
      });

      logger.info(`Cleaned up ${result.count} old activities`);
      return result.count;
    } catch (error) {
      logger.error('Error cleaning old activities:', error);
      throw new DatabaseError('Failed to clean old activities', error);
    }
  }

  /**
   * Create multiple activities in a transaction
   * @param {Array<Object>} activities - Array of activity data objects
   * @returns {Promise<number>} Number of activities created
   */
  async createMany(activities) {
    try {
      const result = await prisma.ticketActivity.createMany({
        data: activities.map(activity => ({
          ticketId: activity.ticketId,
          activityType: activity.activityType,
          performedBy: activity.performedBy,
          performedAt: activity.performedAt ? new Date(activity.performedAt) : new Date(),
          details: activity.details || null,
        })),
        skipDuplicates: true,
      });

      logger.info(`Created ${result.count} activities`);
      return result.count;
    } catch (error) {
      logger.error('Error creating multiple activities:', error);
      throw new DatabaseError('Failed to create multiple activities', error);
    }
  }
}

export default new TicketActivityRepository();
