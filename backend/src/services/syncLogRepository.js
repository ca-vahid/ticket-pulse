import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger.js';
import { DatabaseError, NotFoundError } from '../utils/errors.js';

const prisma = new PrismaClient();

/**
 * Repository for SyncLog operations
 */
class SyncLogRepository {
  /**
   * Create a new sync log entry
   * @param {Object} data - Sync log data
   * @returns {Promise<Object>} Created sync log
   */
  async createLog(data = {}) {
    try {
      return await prisma.syncLog.create({
        data: {
          syncType: data.syncType || 'full',
          status: data.status || 'started',
          recordsProcessed: (data.ticketsSynced || 0) + (data.techniciansSynced || 0),
          errorMessage: data.errorMessage || null,
          startedAt: data.startedAt ? new Date(data.startedAt) : new Date(),
          completedAt: data.completedAt ? new Date(data.completedAt) : null,
        },
      });
    } catch (error) {
      logger.error('Error creating sync log:', error);
      throw new DatabaseError('Failed to create sync log', error);
    }
  }

  /**
   * Update an existing sync log
   * @param {number} id - Sync log ID
   * @param {Object} data - Updated sync log data
   * @returns {Promise<Object>} Updated sync log
   */
  async updateLog(id, data) {
    try {
      const updateData = {};

      if (data.status !== undefined) updateData.status = data.status;
      if (data.recordsProcessed !== undefined) updateData.recordsProcessed = data.recordsProcessed;
      if (data.errorMessage !== undefined) updateData.errorMessage = data.errorMessage;
      if (data.completedAt !== undefined) {
        updateData.completedAt = data.completedAt ? new Date(data.completedAt) : new Date();
      }

      return await prisma.syncLog.update({
        where: { id },
        data: updateData,
      });
    } catch (error) {
      if (error.code === 'P2025') {
        throw new NotFoundError(`Sync log with ID ${id} not found`);
      }
      logger.error(`Error updating sync log ${id}:`, error);
      throw new DatabaseError(`Failed to update sync log ${id}`, error);
    }
  }

  /**
   * Mark sync log as completed
   * @param {number} id - Sync log ID
   * @param {Object} summary - Sync summary data
   * @returns {Promise<Object>} Updated sync log
   */
  async completeLog(id, summary = {}) {
    try {
      const recordsProcessed = (summary.ticketsSynced || 0) + (summary.techniciansSynced || 0);
      return await this.updateLog(id, {
        status: 'completed',
        recordsProcessed,
        completedAt: new Date(),
      });
    } catch (error) {
      logger.error(`Error completing sync log ${id}:`, error);
      throw error; // Re-throw to preserve error type
    }
  }

  /**
   * Mark sync log as failed
   * @param {number} id - Sync log ID
   * @param {string} errorMessage - Error message
   * @returns {Promise<Object>} Updated sync log
   */
  async failLog(id, errorMessage) {
    try {
      return await this.updateLog(id, {
        status: 'failed',
        errorMessage,
        completedAt: new Date(),
      });
    } catch (error) {
      logger.error(`Error failing sync log ${id}:`, error);
      throw error; // Re-throw to preserve error type
    }
  }

  /**
   * Get the latest sync log
   * @returns {Promise<Object|null>} Latest sync log or null
   */
  async getLatest() {
    try {
      return await prisma.syncLog.findFirst({
        orderBy: { startedAt: 'desc' },
      });
    } catch (error) {
      logger.error('Error fetching latest sync log:', error);
      throw new DatabaseError('Failed to fetch latest sync log', error);
    }
  }

  /**
   * Get the latest successful sync log
   * @returns {Promise<Object|null>} Latest successful sync log or null
   */
  async getLatestSuccessful() {
    try {
      return await prisma.syncLog.findFirst({
        where: { status: 'completed' },
        orderBy: { startedAt: 'desc' },
      });
    } catch (error) {
      logger.error('Error fetching latest successful sync log:', error);
      throw new DatabaseError('Failed to fetch latest successful sync log', error);
    }
  }

  /**
   * Get sync logs within a date range
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   * @param {number} limit - Maximum number of logs to return
   * @returns {Promise<Array>} Array of sync logs
   */
  async getByDateRange(startDate, endDate, limit = 100) {
    try {
      return await prisma.syncLog.findMany({
        where: {
          startedAt: {
            gte: startDate,
            lte: endDate,
          },
        },
        orderBy: { startedAt: 'desc' },
        take: limit,
      });
    } catch (error) {
      logger.error('Error fetching sync logs by date range:', error);
      throw new DatabaseError('Failed to fetch sync logs by date range', error);
    }
  }

  /**
   * Get recent sync logs
   * @param {number} limit - Maximum number of logs to return
   * @returns {Promise<Array>} Array of sync logs
   */
  async getRecent(limit = 20) {
    try {
      return await prisma.syncLog.findMany({
        orderBy: { startedAt: 'desc' },
        take: limit,
      });
    } catch (error) {
      logger.error('Error fetching recent sync logs:', error);
      throw new DatabaseError('Failed to fetch recent sync logs', error);
    }
  }

  /**
   * Get sync statistics
   * @param {Date} startDate - Start date (optional)
   * @param {Date} endDate - End date (optional)
   * @returns {Promise<Object>} Sync statistics
   */
  async getStats(startDate = null, endDate = null) {
    try {
      const whereClause = {};
      if (startDate || endDate) {
        whereClause.startedAt = {};
        if (startDate) whereClause.startedAt.gte = startDate;
        if (endDate) whereClause.startedAt.lte = endDate;
      }

      const [total, completed, failed, running] = await Promise.all([
        prisma.syncLog.count({ where: whereClause }),
        prisma.syncLog.count({ where: { ...whereClause, status: 'completed' } }),
        prisma.syncLog.count({ where: { ...whereClause, status: 'failed' } }),
        prisma.syncLog.count({ where: { ...whereClause, status: 'started' } }),
      ]);

      // Calculate totals
      const logs = await prisma.syncLog.findMany({
        where: { ...whereClause, status: 'completed' },
        select: {
          recordsProcessed: true,
        },
      });

      const totalRecordsProcessed = logs.reduce((sum, log) => sum + log.recordsProcessed, 0);

      return {
        total,
        completed,
        failed,
        running,
        totalRecordsProcessed,
        successRate: total > 0 ? ((completed / total) * 100).toFixed(2) : '0.00',
      };
    } catch (error) {
      logger.error('Error fetching sync stats:', error);
      throw new DatabaseError('Failed to fetch sync statistics', error);
    }
  }

  /**
   * Clean up old sync logs
   * @param {number} daysToKeep - Number of days of logs to keep
   * @returns {Promise<number>} Number of logs deleted
   */
  async cleanOldLogs(daysToKeep = 30) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      const result = await prisma.syncLog.deleteMany({
        where: {
          startedAt: { lt: cutoffDate },
        },
      });

      logger.info(`Cleaned up ${result.count} old sync logs`);
      return result.count;
    } catch (error) {
      logger.error('Error cleaning old sync logs:', error);
      throw new DatabaseError('Failed to clean old sync logs', error);
    }
  }

  /**
   * Check if a sync is currently running
   * @returns {Promise<boolean>} True if a sync is running
   */
  async isSyncRunning() {
    try {
      const runningSync = await prisma.syncLog.findFirst({
        where: { status: 'started' },
        orderBy: { startedAt: 'desc' },
      });

      return Boolean(runningSync);
    } catch (error) {
      logger.error('Error checking if sync is running:', error);
      return false;
    }
  }
}

export default new SyncLogRepository();
