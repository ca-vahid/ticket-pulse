import prisma from './prisma.js';
import logger from '../utils/logger.js';

// Groups change rarely — refresh the cache at most this often per workspace.
const GROUP_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * FreshService group cache. Tickets store the raw FS group id (Ticket.groupId);
 * this cache gives those ids resolvable names and powers group pickers without
 * a live FS call. TP-native groups (freshserviceId = null) are never touched
 * by this sync.
 */
class GroupSyncService {
  async syncWorkspaceGroups(workspaceId, freshserviceWorkspaceId, client, { force = false } = {}) {
    try {
      if (!force) {
        const latest = await prisma.group.aggregate({
          where: { workspaceId },
          _max: { syncedAt: true },
        });
        const last = latest._max.syncedAt;
        if (last && Date.now() - last.getTime() < GROUP_SYNC_INTERVAL_MS) {
          return { skipped: true, reason: 'recently_synced' };
        }
      }

      const filters = {};
      if (freshserviceWorkspaceId) {
        filters.workspace_id = Number(freshserviceWorkspaceId);
      }
      const fsGroups = await client.listGroups(filters);
      const syncedAt = new Date();

      let synced = 0;
      for (const g of fsGroups) {
        if (!g?.id) continue;
        const fields = {
          name: g.name || `Group ${g.id}`,
          description: g.description || null,
          isActive: true,
          syncedAt,
        };
        await prisma.group.upsert({
          where: {
            workspaceId_freshserviceId: {
              workspaceId,
              freshserviceId: BigInt(g.id),
            },
          },
          update: fields,
          create: { workspaceId, freshserviceId: BigInt(g.id), ...fields },
        });
        synced++;
      }

      // FS groups that vanished go inactive (kept so old tickets still resolve a label).
      // NULL syncedAt rows are untouched, which also protects TP-native groups.
      const deactivated = await prisma.group.updateMany({
        where: {
          workspaceId,
          freshserviceId: { not: null },
          isActive: true,
          syncedAt: { lt: syncedAt },
        },
        data: { isActive: false },
      });

      logger.info(`Group cache synced for workspace ${workspaceId}: ${synced} groups${deactivated.count ? `, ${deactivated.count} deactivated` : ''}`);
      return { skipped: false, synced, deactivated: deactivated.count };
    } catch (error) {
      logger.warn(`Group cache sync failed for workspace ${workspaceId} (non-fatal): ${error.message}`);
      return { skipped: true, reason: 'error', error: error.message };
    }
  }
}

export default new GroupSyncService();
