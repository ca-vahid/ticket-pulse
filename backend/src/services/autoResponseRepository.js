import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger.js';

const prisma = new PrismaClient();

/**
 * Auto Response Repository
 * Manages auto-response records in the database
 */
class AutoResponseRepository {
  /**
   * Create a new auto-response record
   * @param {Object} data - Auto-response data
   * @returns {Promise<Object>} Created record
   */
  async create(data) {
    try {
      const autoResponse = await prisma.autoResponse.create({
        data,
      });

      logger.debug('Auto-response record created', { id: autoResponse.id });
      return autoResponse;
    } catch (error) {
      logger.error('Failed to create auto-response record', { error: error.message });
      throw error;
    }
  }

  /**
   * Update an auto-response record
   * @param {number} id - Record ID
   * @param {Object} data - Update data
   * @returns {Promise<Object>} Updated record
   */
  async update(id, data) {
    try {
      const autoResponse = await prisma.autoResponse.update({
        where: { id },
        data,
      });

      logger.debug('Auto-response record updated', { id });
      return autoResponse;
    } catch (error) {
      logger.error('Failed to update auto-response record', { id, error: error.message });
      throw error;
    }
  }

  /**
   * Get auto-response by ID
   * @param {number} id - Record ID
   * @returns {Promise<Object|null>}
   */
  async getById(id) {
    return await prisma.autoResponse.findUnique({
      where: { id },
    });
  }

  /**
   * Get auto-responses by ticket ID
   * @param {BigInt} freshserviceTicketId
   * @returns {Promise<Array>}
   */
  async getByTicketId(freshserviceTicketId) {
    return await prisma.autoResponse.findMany({
      where: { freshserviceTicketId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Get recent auto-responses
   * @param {number} limit - Max number of records
   * @returns {Promise<Array>}
   */
  async getRecent(limit = 50) {
    return await prisma.autoResponse.findMany({
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Get auto-responses by sender email
   * @param {string} email
   * @param {number} limit
   * @returns {Promise<Array>}
   */
  async getBySenderEmail(email, limit = 10) {
    return await prisma.autoResponse.findMany({
      where: { senderEmail: email },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Get statistics for auto-responses
   * @param {Date} startDate
   * @param {Date} endDate
   * @returns {Promise<Object>}
   */
  async getStats(startDate, endDate) {
    const responses = await prisma.autoResponse.findMany({
      where: {
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
      },
    });

    const stats = {
      total: responses.length,
      sent: responses.filter(r => r.responseSent).length,
      failed: responses.filter(r => !r.responseSent && r.errorMessage).length,
      byClassification: {},
      afterHours: responses.filter(r => r.isAfterHours).length,
      holidays: responses.filter(r => r.isHoliday).length,
    };

    // Count by classification
    responses.forEach(r => {
      stats.byClassification[r.classification] = (stats.byClassification[r.classification] || 0) + 1;
    });

    return stats;
  }
}

export default new AutoResponseRepository();

