import prisma from './prisma.js';

class VacationTrackerRepository {
  // ── Config ──

  async getConfig(workspaceId) {
    return prisma.vacationTrackerConfig.findUnique({
      where: { workspaceId },
    });
  }

  async upsertConfig(workspaceId, data) {
    return prisma.vacationTrackerConfig.upsert({
      where: { workspaceId },
      create: { workspaceId, ...data },
      update: data,
    });
  }

  async updateLastSyncAt(workspaceId) {
    return prisma.vacationTrackerConfig.update({
      where: { workspaceId },
      data: { lastSyncAt: new Date() },
    });
  }

  // ── Leave Types ──

  async getLeaveTypes(workspaceId) {
    return prisma.vtLeaveType.findMany({
      where: { workspaceId },
      orderBy: { vtLeaveTypeName: 'asc' },
    });
  }

  async upsertLeaveType(workspaceId, vtLeaveTypeId, data) {
    return prisma.vtLeaveType.upsert({
      where: {
        workspaceId_vtLeaveTypeId: { workspaceId, vtLeaveTypeId },
      },
      create: { workspaceId, vtLeaveTypeId, ...data },
      update: data,
    });
  }

  async updateLeaveTypeCategory(id, category) {
    return prisma.vtLeaveType.update({
      where: { id },
      data: { category },
    });
  }

  async bulkUpdateLeaveTypeCategories(mappings) {
    const ops = mappings.map(({ id, category }) =>
      prisma.vtLeaveType.update({ where: { id }, data: { category } }),
    );
    return prisma.$transaction(ops);
  }

  // ── User Mappings ──

  async getUserMappings(workspaceId) {
    return prisma.vtUserMapping.findMany({
      where: { workspaceId },
      include: { technician: { select: { id: true, name: true, email: true } } },
      orderBy: { vtUserName: 'asc' },
    });
  }

  async upsertUserMapping(workspaceId, vtUserId, data) {
    return prisma.vtUserMapping.upsert({
      where: {
        workspaceId_vtUserId: { workspaceId, vtUserId },
      },
      create: { workspaceId, vtUserId, ...data },
      update: data,
    });
  }

  async updateUserMappingMatch(id, technicianId, matchStatus) {
    return prisma.vtUserMapping.update({
      where: { id },
      data: { technicianId, matchStatus },
    });
  }

  async getMappedUsersByWorkspace(workspaceId) {
    return prisma.vtUserMapping.findMany({
      where: { workspaceId, technicianId: { not: null } },
    });
  }

  // ── Technician Leaves ──

  async upsertLeave(data) {
    return prisma.technicianLeave.upsert({
      where: {
        vtLeaveId_leaveDate: {
          vtLeaveId: data.vtLeaveId,
          leaveDate: data.leaveDate,
        },
      },
      create: data,
      update: {
        leaveTypeName: data.leaveTypeName,
        category: data.category,
        status: data.status,
      },
    });
  }

  async bulkUpsertLeaves(leaves) {
    const ops = leaves.map(leave => this.upsertLeave(leave));
    const BATCH_SIZE = 50;
    const results = [];
    for (let i = 0; i < ops.length; i += BATCH_SIZE) {
      const batch = ops.slice(i, i + BATCH_SIZE);
      results.push(...await Promise.all(batch));
    }
    return results;
  }

  /**
   * Delete leave-day rows in the date window that no longer correspond to a
   * currently-approved VT leave-day.
   *
   * `validKeys` is a Set of `${vtLeaveId}|${ISO date}` strings representing
   * the rows that SHOULD exist after the sync. Anything else in the window
   * is removed.
   *
   * This catches BOTH cases:
   *   1. Entire leave cancelled (vtLeaveId no longer in VT APPROVED set)
   *   2. Leave modified in-place (same vtLeaveId but different date range,
   *      e.g. user moves WFH Thu → Fri — old Thu row must be removed)
   */
  async deleteStaleLeaves(workspaceId, startDate, endDate, validKeys) {
    if (!(validKeys instanceof Set)) {
      throw new Error('deleteStaleLeaves: validKeys must be a Set of "vtLeaveId|ISODate" strings');
    }

    // Fetch current rows in window and diff against the valid set.
    const existing = await prisma.technicianLeave.findMany({
      where: {
        workspaceId,
        leaveDate: { gte: startDate, lte: endDate },
      },
      select: { id: true, vtLeaveId: true, leaveDate: true },
    });

    const toDelete = existing.filter((row) => {
      const key = `${row.vtLeaveId}|${row.leaveDate.toISOString().slice(0, 10)}`;
      return !validKeys.has(key);
    });

    if (toDelete.length === 0) return { count: 0 };

    const res = await prisma.technicianLeave.deleteMany({
      where: { id: { in: toDelete.map((r) => r.id) } },
    });
    return res;
  }

  async getLeavesByDateRange(workspaceId, startDate, endDate) {
    return prisma.technicianLeave.findMany({
      where: {
        workspaceId,
        leaveDate: { gte: startDate, lte: endDate },
      },
      orderBy: { leaveDate: 'asc' },
    });
  }

  async getLeavesForTechnicians(technicianIds, startDate, endDate) {
    return prisma.technicianLeave.findMany({
      where: {
        technicianId: { in: technicianIds },
        leaveDate: { gte: startDate, lte: endDate },
      },
      orderBy: { leaveDate: 'asc' },
    });
  }

  async getLeavesByDate(workspaceId, date) {
    return prisma.technicianLeave.findMany({
      where: {
        workspaceId,
        leaveDate: date,
      },
    });
  }
}

export default new VacationTrackerRepository();
