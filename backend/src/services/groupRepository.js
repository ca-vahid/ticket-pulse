import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { DatabaseError, NotFoundError, ValidationError } from '../utils/errors.js';

/**
 * Repository for Group operations, including TP-native ("internal") groups.
 *
 * Internal groups have origin='local' and freshserviceId=null. They are owned
 * by Ticket Pulse, carry a membership roster (GroupMember), and are referenced
 * on tickets via Ticket.internalGroupId (NOT the FS BigInt groupId). FreshService
 * groups (origin='freshservice') are sync-owned and read-only here.
 */
class GroupRepository {
  /**
   * All groups for a workspace (FS + internal), with member counts.
   */
  async listForWorkspace(workspaceId, { includeInactive = true } = {}) {
    try {
      const where = { workspaceId };
      if (!includeInactive) where.isActive = true;
      const groups = await prisma.group.findMany({
        where,
        select: {
          id: true,
          name: true,
          description: true,
          origin: true,
          freshserviceId: true,
          isActive: true,
          _count: { select: { members: true } },
        },
        orderBy: [{ origin: 'asc' }, { name: 'asc' }],
      });
      return groups.map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description,
        origin: g.origin,
        freshserviceId: g.freshserviceId ? g.freshserviceId.toString() : null,
        isActive: g.isActive,
        memberCount: g._count.members,
      }));
    } catch (error) {
      logger.error('Error listing groups:', error);
      throw new DatabaseError('Failed to list groups', error);
    }
  }

  async getById(id) {
    return prisma.group.findUnique({ where: { id } });
  }

  /**
   * Create an internal (TP-native) group. No freshserviceId — assignable to
   * TP-born tickets only, never mirrored to FreshService.
   */
  async createInternal({ workspaceId, name, description }) {
    try {
      return await prisma.group.create({
        data: {
          workspaceId,
          origin: 'local',
          freshserviceId: null,
          name: name.trim(),
          description: description?.trim() || null,
          isActive: true,
        },
      });
    } catch (error) {
      logger.error('Error creating internal group:', error);
      throw new DatabaseError('Failed to create internal group', error);
    }
  }

  /**
   * Update an internal group. Throws ValidationError if the target is a
   * FreshService (sync-owned) group.
   */
  async updateInternal(id, data) {
    const group = await prisma.group.findUnique({ where: { id } });
    if (!group) throw new NotFoundError(`Group ${id} not found`);
    if (group.origin !== 'local') {
      throw new ValidationError('FreshService groups are managed by sync and cannot be edited here.');
    }
    const updateData = {};
    if (data.name !== undefined) updateData.name = data.name.trim();
    if (data.description !== undefined) updateData.description = data.description?.trim() || null;
    if (data.isActive !== undefined) updateData.isActive = !!data.isActive;
    try {
      return await prisma.group.update({ where: { id }, data: updateData });
    } catch (error) {
      logger.error(`Error updating internal group ${id}:`, error);
      throw new DatabaseError('Failed to update internal group', error);
    }
  }

  /**
   * Members of a group (id, name, email, photo, origin, active).
   */
  async getMembers(groupId) {
    const rows = await prisma.groupMember.findMany({
      where: { groupId },
      include: {
        technician: {
          select: { id: true, name: true, email: true, photoUrl: true, origin: true, isActive: true },
        },
      },
      orderBy: { technician: { name: 'asc' } },
    });
    return rows.map((r) => r.technician);
  }

  /**
   * Replace a group's membership with the given technician ids. Only technicians
   * in the same workspace are accepted (mixed FS + local is fine — membership is
   * routing metadata, not an assignment).
   */
  async setMembers(groupId, technicianIds, workspaceId) {
    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group) throw new NotFoundError(`Group ${groupId} not found`);
    if (group.origin !== 'local') {
      throw new ValidationError('Membership is only editable on internal groups.');
    }
    const ids = [...new Set((technicianIds || []).map((n) => parseInt(n, 10)).filter(Number.isInteger))];
    // Guard: every id must be a technician in this workspace.
    const valid = ids.length
      ? await prisma.technician.findMany({
        where: { id: { in: ids }, workspaceId },
        select: { id: true },
      })
      : [];
    const validIds = new Set(valid.map((t) => t.id));
    const accepted = ids.filter((id) => validIds.has(id));

    return prisma.$transaction(async (tx) => {
      await tx.groupMember.deleteMany({ where: { groupId } });
      if (accepted.length) {
        await tx.groupMember.createMany({
          data: accepted.map((technicianId) => ({ groupId, technicianId, workspaceId })),
          skipDuplicates: true,
        });
      }
      return accepted.length;
    });
  }

  /**
   * Resolve an internal group by id, scoped to a workspace. Used to validate a
   * ticket's internalGroupId before persisting.
   */
  async getInternalForWorkspace(workspaceId, id) {
    return prisma.group.findFirst({
      where: { id, workspaceId, origin: 'local' },
      select: { id: true, name: true, isActive: true },
    });
  }
}

export default new GroupRepository();
