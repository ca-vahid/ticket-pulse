import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { DatabaseError, NotFoundError } from '../utils/errors.js';

class WorkspaceRepository {
  async getAll() {
    try {
      return await prisma.workspace.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
      });
    } catch (error) {
      logger.error('Error fetching workspaces:', error);
      throw new DatabaseError('Failed to fetch workspaces', error);
    }
  }

  async getById(id) {
    try {
      const ws = await prisma.workspace.findUnique({ where: { id } });
      if (!ws) throw new NotFoundError(`Workspace ${id} not found`);
      return ws;
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      logger.error(`Error fetching workspace ${id}:`, error);
      throw new DatabaseError(`Failed to fetch workspace ${id}`, error);
    }
  }

  async getBySlug(slug) {
    try {
      return await prisma.workspace.findUnique({ where: { slug } });
    } catch (error) {
      logger.error(`Error fetching workspace by slug ${slug}:`, error);
      throw new DatabaseError(`Failed to fetch workspace ${slug}`, error);
    }
  }

  async create(data) {
    try {
      return await prisma.workspace.create({
        data: {
          name: data.name,
          slug: data.slug,
          freshserviceWorkspaceId: BigInt(data.freshserviceWorkspaceId),
          defaultTimezone: data.defaultTimezone || 'America/Los_Angeles',
          syncIntervalMinutes: data.syncIntervalMinutes || 5,
          isActive: data.isActive !== undefined ? data.isActive : true,
        },
      });
    } catch (error) {
      logger.error('Error creating workspace:', error);
      throw new DatabaseError('Failed to create workspace', error);
    }
  }

  async update(id, data) {
    try {
      const updateData = {};
      if (data.name !== undefined) updateData.name = data.name;
      if (data.slug !== undefined) updateData.slug = data.slug;
      if (data.freshserviceWorkspaceId !== undefined) {
        updateData.freshserviceWorkspaceId = BigInt(data.freshserviceWorkspaceId);
      }
      if (data.defaultTimezone !== undefined) updateData.defaultTimezone = data.defaultTimezone;
      if (data.syncIntervalMinutes !== undefined) updateData.syncIntervalMinutes = data.syncIntervalMinutes;
      if (data.isActive !== undefined) updateData.isActive = data.isActive;

      return await prisma.workspace.update({
        where: { id },
        data: updateData,
      });
    } catch (error) {
      if (error.code === 'P2025') throw new NotFoundError(`Workspace ${id} not found`);
      logger.error(`Error updating workspace ${id}:`, error);
      throw new DatabaseError(`Failed to update workspace ${id}`, error);
    }
  }

  /**
   * Get all workspaces a user has access to (by email).
   * Returns workspace data with the user's role in each.
   */
  async getAccessibleWorkspaces(email) {
    try {
      const accessRecords = await prisma.workspaceAccess.findMany({
        where: { email: email.toLowerCase() },
        include: { workspace: true },
      });

      return accessRecords
        .filter(a => a.workspace.isActive)
        .map(a => ({
          id: a.workspace.id,
          name: a.workspace.name,
          slug: a.workspace.slug,
          role: a.role,
          freshserviceWorkspaceId: a.workspace.freshserviceWorkspaceId,
          defaultTimezone: a.workspace.defaultTimezone,
        }));
    } catch (error) {
      logger.error(`Error fetching accessible workspaces for ${email}:`, error);
      throw new DatabaseError('Failed to fetch accessible workspaces', error);
    }
  }

  /**
   * Check if a user has access to a specific workspace. Returns the role
   * ('viewer'|'admin') or null if no access.
   */
  async getAccessRole(email, workspaceId) {
    try {
      const record = await prisma.workspaceAccess.findUnique({
        where: { email_workspaceId: { email: email.toLowerCase(), workspaceId } },
      });
      return record?.role || null;
    } catch (error) {
      logger.error(`Error checking workspace access for ${email}:`, error);
      return null;
    }
  }

  async grantAccess(email, workspaceId, role = 'viewer') {
    try {
      return await prisma.workspaceAccess.upsert({
        where: {
          email_workspaceId: { email: email.toLowerCase(), workspaceId },
        },
        update: { role },
        create: { email: email.toLowerCase(), workspaceId, role },
      });
    } catch (error) {
      logger.error(`Error granting workspace access for ${email}:`, error);
      throw new DatabaseError('Failed to grant workspace access', error);
    }
  }

  async revokeAccess(email, workspaceId) {
    try {
      await prisma.workspaceAccess.delete({
        where: {
          email_workspaceId: { email: email.toLowerCase(), workspaceId },
        },
      });
      return true;
    } catch (error) {
      if (error.code === 'P2025') return false;
      logger.error(`Error revoking workspace access for ${email}:`, error);
      throw new DatabaseError('Failed to revoke workspace access', error);
    }
  }

  async getAccessList(workspaceId) {
    try {
      return await prisma.workspaceAccess.findMany({
        where: { workspaceId },
        orderBy: { email: 'asc' },
      });
    } catch (error) {
      logger.error(`Error fetching access list for workspace ${workspaceId}:`, error);
      throw new DatabaseError('Failed to fetch workspace access list', error);
    }
  }

  async getAllActive() {
    try {
      return await prisma.workspace.findMany({
        where: { isActive: true },
        orderBy: { id: 'asc' },
      });
    } catch (error) {
      logger.error('Error fetching active workspaces:', error);
      throw new DatabaseError('Failed to fetch active workspaces', error);
    }
  }

  async getAllInactive() {
    try {
      return await prisma.workspace.findMany({
        where: { isActive: false },
        orderBy: { id: 'asc' },
      });
    } catch (error) {
      logger.error('Error fetching inactive workspaces:', error);
      throw new DatabaseError('Failed to fetch inactive workspaces', error);
    }
  }

  async getByFreshserviceId(freshserviceWorkspaceId) {
    try {
      return await prisma.workspace.findFirst({
        where: { freshserviceWorkspaceId: BigInt(freshserviceWorkspaceId) },
      });
    } catch (error) {
      logger.error(`Error fetching workspace by FS ID ${freshserviceWorkspaceId}:`, error);
      throw new DatabaseError('Failed to fetch workspace by FreshService ID', error);
    }
  }
}

export default new WorkspaceRepository();
