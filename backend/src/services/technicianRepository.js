import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { DatabaseError, NotFoundError } from '../utils/errors.js';

/**
 * Repository for Technician operations
 */
class TechnicianRepository {
  /**
   * Get all technicians (active and inactive)
   * @returns {Promise<Array>} Array of all technicians
   */
  async getAll() {
    try {
      return await prisma.technician.findMany({
        include: {
          tickets: {
            include: {
              requester: true,
            },
          },
        },
        orderBy: { name: 'asc' },
      });
    } catch (error) {
      logger.error('Error fetching all technicians:', error);
      throw new DatabaseError('Failed to fetch all technicians', error);
    }
  }

  /**
   * Get all active technicians
   * @returns {Promise<Array>} Array of active technicians
   */
  async getAllActive() {
    try {
      return await prisma.technician.findMany({
        where: { isActive: true },
        include: {
          tickets: {
            include: {
              requester: true, // Include requester for ticket details
            },
          },
        },
        orderBy: { name: 'asc' },
      });
    } catch (error) {
      logger.error('Error fetching active technicians:', error);
      throw new DatabaseError('Failed to fetch active technicians', error);
    }
  }

  /**
   * Get all active technicians with only the tickets relevant to a specific
   * date range.  Loads: (1) tickets assigned in [dateStart, dateEnd],
   * (2) currently Open/Pending tickets (for workload indicators),
   * (3) CSAT tickets submitted in the range.
   *
   * @param {Date} dateStart - Start of the date range (inclusive)
   * @param {Date} dateEnd   - End of the date range (inclusive)
   * @returns {Promise<Array>} Array of active technicians with scoped tickets
   */
  async getAllActiveScoped(dateStart, dateEnd, { excludeNoise = false } = {}) {
    try {
      const ticketWhere = {
        OR: [
          { firstAssignedAt: { gte: dateStart, lte: dateEnd } },
          { firstAssignedAt: null, createdAt: { gte: dateStart, lte: dateEnd } },
          { status: { in: ['Open', 'Pending'] } },
          { csatSubmittedAt: { gte: dateStart, lte: dateEnd } },
        ],
      };

      if (excludeNoise) {
        ticketWhere.isNoise = false;
      }

      return await prisma.technician.findMany({
        where: { isActive: true },
        include: {
          tickets: {
            where: ticketWhere,
            include: { requester: true },
          },
        },
        orderBy: { name: 'asc' },
      });
    } catch (error) {
      logger.error('Error fetching active technicians (scoped):', error);
      throw new DatabaseError('Failed to fetch active technicians (scoped)', error);
    }
  }

  /**
   * Get technician by internal ID
   * @param {number} id - Internal technician ID
   * @returns {Promise<Object|null>} Technician object or null
   */
  async getById(id, { excludeNoise = false } = {}) {
    try {
      const ticketWhere = excludeNoise ? { isNoise: false } : undefined;
      return await prisma.technician.findUnique({
        where: { id },
        include: {
          tickets: {
            where: ticketWhere,
            include: {
              requester: true,
            },
          },
        },
      });
    } catch (error) {
      logger.error(`Error fetching technician by ID ${id}:`, error);
      throw new DatabaseError(`Failed to fetch technician ${id}`, error);
    }
  }

  /**
   * Get technician by FreshService ID
   * @param {number} freshserviceId - FreshService technician ID
   * @returns {Promise<Object|null>} Technician object or null
   */
  async getByFreshserviceId(freshserviceId) {
    try {
      return await prisma.technician.findUnique({
        where: { freshserviceId: BigInt(freshserviceId) },
        include: {
          tickets: true,
        },
      });
    } catch (error) {
      logger.error(`Error fetching technician by FreshService ID ${freshserviceId}:`, error);
      throw new DatabaseError(`Failed to fetch technician ${freshserviceId}`, error);
    }
  }

  /**
   * Create a new technician
   * @param {Object} data - Technician data
   * @returns {Promise<Object>} Created technician
   */
  async create(data) {
    try {
      return await prisma.technician.create({
        data: {
          freshserviceId: BigInt(data.freshserviceId),
          name: data.name,
          email: data.email || null,
          timezone: data.timezone || 'America/Los_Angeles',
          isActive: data.isActive !== undefined ? data.isActive : true,
        },
      });
    } catch (error) {
      logger.error('Error creating technician:', error);
      throw new DatabaseError('Failed to create technician', error);
    }
  }

  /**
   * Update technician data
   * @param {number} id - Internal technician ID
   * @param {Object} data - Updated technician data
   * @returns {Promise<Object>} Updated technician
   */
  async update(id, data) {
    try {
      const updateData = {};
      if (data.name !== undefined) updateData.name = data.name;
      if (data.email !== undefined) updateData.email = data.email;
      if (data.timezone !== undefined) updateData.timezone = data.timezone;
      if (data.location !== undefined) updateData.location = data.location;
      if (data.isActive !== undefined) updateData.isActive = data.isActive;
      if (data.showOnMap !== undefined) updateData.showOnMap = data.showOnMap;
      if (data.isMapManager !== undefined) updateData.isMapManager = data.isMapManager;
      if (data.workStartTime !== undefined) updateData.workStartTime = data.workStartTime;
      if (data.workEndTime !== undefined) updateData.workEndTime = data.workEndTime;

      updateData.updatedAt = new Date();

      return await prisma.technician.update({
        where: { id },
        data: updateData,
      });
    } catch (error) {
      if (error.code === 'P2025') {
        throw new NotFoundError(`Technician with ID ${id} not found`);
      }
      logger.error(`Error updating technician ${id}:`, error);
      throw new DatabaseError(`Failed to update technician ${id}`, error);
    }
  }

  /**
   * Upsert technician (create or update based on FreshService ID)
   * @param {Object} data - Technician data
   * @returns {Promise<Object>} Created or updated technician
   */
  async upsert(data) {
    try {
      const updateData = {
        name: data.name,
        email: data.email || null,
        isActive: data.isActive !== undefined ? data.isActive : true,
        updatedAt: new Date(),
      };

      const createData = {
        freshserviceId: BigInt(data.freshserviceId),
        name: data.name,
        email: data.email || null,
        timezone: data.timezone || 'America/Los_Angeles',
        isActive: data.isActive !== undefined ? data.isActive : true,
      };

      // Location, timezone, showOnMap, and isMapManager are managed manually
      // These fields are NEVER updated during sync to preserve manual changes
      // Only set defaults for new technicians
      if (data.location) {
        createData.location = data.location;
      }
      // Note: updateData intentionally does NOT include location, timezone, showOnMap, or isMapManager

      // Log what we're upserting to debug location resets
      logger.debug(`Upserting technician ${data.email}`, {
        hasLocationInData: !!data.location,
        locationValue: data.location,
        updateDataKeys: Object.keys(updateData),
        createDataKeys: Object.keys(createData),
      });

      // Include workspaceId if provided
      if (data.workspaceId !== undefined) {
        updateData.workspaceId = data.workspaceId;
        createData.workspaceId = data.workspaceId;
      }

      return await prisma.technician.upsert({
        where: { freshserviceId: BigInt(data.freshserviceId) },
        update: updateData,
        create: createData,
      });
    } catch (error) {
      logger.error('Error upserting technician:', error);
      throw new DatabaseError('Failed to upsert technician', error);
    }
  }

  /**
   * Deactivate a technician
   * @param {number} id - Internal technician ID
   * @returns {Promise<Object>} Updated technician
   */
  async deactivate(id) {
    try {
      return await this.update(id, { isActive: false });
    } catch (error) {
      logger.error(`Error deactivating technician ${id}:`, error);
      throw error; // Re-throw to preserve error type
    }
  }

  /**
   * Deactivate technicians not in the specified workspace
   * @param {number|string} workspaceId - Workspace ID to keep active
   * @returns {Promise<number>} Number of deactivated technicians
   */
  async deactivateByWorkspace(workspaceId) {
    try {
      const result = await prisma.technician.updateMany({
        where: {
          OR: [
            { workspaceId: null },
            { workspaceId: { not: BigInt(workspaceId) } },
          ],
          isActive: true, // Only deactivate currently active technicians
        },
        data: {
          isActive: false,
          updatedAt: new Date(),
        },
      });

      return result.count;
    } catch (error) {
      logger.error(`Error deactivating technicians not in workspace ${workspaceId}:`, error);
      throw new DatabaseError('Failed to deactivate technicians by workspace', error);
    }
  }

  /**
   * Get technician count statistics
   * @returns {Promise<Object>} Count statistics
   */
  async getStats() {
    try {
      const total = await prisma.technician.count();
      const active = await prisma.technician.count({
        where: { isActive: true },
      });

      return {
        total,
        active,
        inactive: total - active,
      };
    } catch (error) {
      logger.error('Error fetching technician stats:', error);
      throw new DatabaseError('Failed to fetch technician statistics', error);
    }
  }
}

export default new TechnicianRepository();
