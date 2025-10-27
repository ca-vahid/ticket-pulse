import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger.js';
import { DatabaseError, NotFoundError } from '../utils/errors.js';

const prisma = new PrismaClient();

/**
 * Repository for Technician operations
 */
class TechnicianRepository {
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
   * Get technician by internal ID
   * @param {number} id - Internal technician ID
   * @returns {Promise<Object|null>} Technician object or null
   */
  async getById(id) {
    try {
      return await prisma.technician.findUnique({
        where: { id },
        include: {
          tickets: {
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
      if (data.isActive !== undefined) updateData.isActive = data.isActive;

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
        timezone: data.timezone || 'America/Los_Angeles',
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
      throw new DatabaseError(`Failed to deactivate technicians by workspace`, error);
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
