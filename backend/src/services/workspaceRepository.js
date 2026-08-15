import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { DatabaseError, NotFoundError } from '../utils/errors.js';

/**
 * Merge access-row workspaces with technician workspaces, deduped by id.
 * The ACCESS row wins the role label when both lists grant the same
 * workspace; technician-only rows keep their 'agent' label. Sorted by name
 * for a stable picker. Pure function — exported for the auth login/session
 * paths (Phase A1 picker merge) and unit tests.
 */
export function mergeWorkspaceLists(accessible = [], technician = []) {
  const byId = new Map();
  for (const ws of technician) byId.set(ws.id, ws);
  for (const ws of accessible) byId.set(ws.id, ws); // access-role wins
  return [...byId.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

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
      if (data.nativeTicketingEnabled !== undefined) {
        updateData.nativeTicketingEnabled = data.nativeTicketingEnabled === true;
      }
      if (data.defaultInternalGroupId !== undefined) {
        // Default internal group for new tickets (QA 08-06 #1); null clears it.
        updateData.defaultInternalGroupId = data.defaultInternalGroupId === null
          ? null
          : Number(data.defaultInternalGroupId);
      }
      if (data.internalDomains !== undefined) {
        // Normalize: lowercase bare domains ("BGCengineering.ca", "@x.com",
        // "user@x.com" all → "x.com"), deduped, empty entries dropped.
        const cleaned = (Array.isArray(data.internalDomains) ? data.internalDomains : [])
          .map((d) => String(d || '').trim().toLowerCase().replace(/^.*@/, ''))
          .filter((d) => /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(d));
        updateData.internalDomains = [...new Set(cleaned)];
      }

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
          nativeTicketingEnabled: a.workspace.nativeTicketingEnabled === true,
        }));
    } catch (error) {
      logger.error(`Error fetching accessible workspaces for ${email}:`, error);
      throw new DatabaseError('Failed to fetch accessible workspaces', error);
    }
  }

  /**
   * Workspaces where the user is an active technician. This is how agent-role
   * users (no workspace_access rows) get a workspace for native ticketing.
   */
  async getTechnicianWorkspaces(email) {
    try {
      const techs = await prisma.technician.findMany({
        where: {
          email: { equals: String(email || '').toLowerCase(), mode: 'insensitive' },
          isActive: true,
          workspace: { isActive: true },
        },
        include: { workspace: true },
        orderBy: { workspaceId: 'asc' },
      });
      const seen = new Set();
      return techs
        .filter(t => !seen.has(t.workspaceId) && seen.add(t.workspaceId))
        .map(t => ({
          id: t.workspace.id,
          name: t.workspace.name,
          slug: t.workspace.slug,
          role: 'agent',
          freshserviceWorkspaceId: t.workspace.freshserviceWorkspaceId,
          defaultTimezone: t.workspace.defaultTimezone,
          nativeTicketingEnabled: t.workspace.nativeTicketingEnabled === true,
        }));
    } catch (error) {
      logger.error(`Error fetching technician workspaces for ${email}:`, error);
      throw new DatabaseError('Failed to fetch technician workspaces', error);
    }
  }

  /**
   * Union of the user's access-row workspaces and technician workspaces,
   * deduped by id — the ACCESS role wins the label when both grant the same
   * workspace (Phase A1 picker merge). A partial grant (one access row) must
   * never shrink the picker below what the user's technician profiles cover.
   */
  async getMergedWorkspaces(email) {
    const [accessible, technician] = await Promise.all([
      this.getAccessibleWorkspaces(email),
      this.getTechnicianWorkspaces(email),
    ]);
    return mergeWorkspaceLists(accessible, technician);
  }

  /**
   * True when the user is an active technician in the given workspace —
   * the membership check behind the agent-allowed read tier (Phase A1):
   * global-'agent' users have no workspace_access rows but their technician
   * profile grants the ticket queue's read set (/sse, ticket types).
   */
  async hasActiveTechnician(email, workspaceId) {
    try {
      const tech = await prisma.technician.findFirst({
        where: {
          workspaceId,
          isActive: true,
          email: { equals: String(email || '').toLowerCase(), mode: 'insensitive' },
        },
        select: { id: true },
      });
      return Boolean(tech);
    } catch (error) {
      logger.error(`Error checking technician membership for ${email}:`, error);
      return false;
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
