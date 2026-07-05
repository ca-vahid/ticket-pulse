import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { DatabaseError } from '../utils/errors.js';

class TicketThreadRepository {
  async bulkUpsert(entries = []) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return { upserted: 0 };
    }

    let upserted = 0;
    // Track the newest REAL entry per ticket (has a body) so tickets carry an
    // honest last_real_activity_at even when FS's updated_at is noise.
    const latestRealByTicket = new Map();

    for (const entry of entries) {
      try {
        await prisma.ticketThreadEntry.upsert({
          where: {
            ticketId_externalEntryId: {
              ticketId: entry.ticketId,
              externalEntryId: entry.externalEntryId,
            },
          },
          create: entry,
          update: {
            source: entry.source,
            eventType: entry.eventType,
            actorName: entry.actorName,
            actorEmail: entry.actorEmail,
            actorFreshserviceId: entry.actorFreshserviceId,
            incoming: entry.incoming,
            isPrivate: entry.isPrivate,
            visibility: entry.visibility,
            title: entry.title,
            content: entry.content,
            bodyHtml: entry.bodyHtml,
            bodyText: entry.bodyText,
            occurredAt: entry.occurredAt,
            syncedAt: new Date(),
            rawPayload: entry.rawPayload,
          },
        });
        upserted++;
        if ((entry.bodyText || entry.bodyHtml || entry.content) && entry.occurredAt) {
          const at = new Date(entry.occurredAt);
          if (!Number.isNaN(at.getTime())) {
            const prev = latestRealByTicket.get(entry.ticketId);
            if (!prev || at > prev) latestRealByTicket.set(entry.ticketId, at);
          }
        }
      } catch (error) {
        logger.warn('Failed to upsert ticket thread entry', {
          ticketId: entry.ticketId,
          externalEntryId: entry.externalEntryId,
          error: error.message,
        });
      }
    }

    // GREATEST keeps re-syncs of old history from moving the timestamp back.
    for (const [ticketId, at] of latestRealByTicket) {
      try {
        await prisma.$executeRaw`
          UPDATE tickets
          SET last_real_activity_at = GREATEST(COALESCE(last_real_activity_at, 'epoch'::timestamp), ${at})
          WHERE id = ${ticketId}
        `;
      } catch (error) {
        logger.warn('Failed to bump last_real_activity_at from thread sync (non-fatal)', {
          ticketId, error: error.message,
        });
      }
    }

    return { upserted };
  }

  async listForTickets(ticketIds = [], { start = null, end = null, workspaceId = null } = {}) {
    if (!Array.isArray(ticketIds) || ticketIds.length === 0) {
      return [];
    }

    const where = {
      ticketId: { in: ticketIds },
    };

    // Optional defence-in-depth scoping: callers from a workspace context
    // (e.g. the daily review service) pass workspaceId so a cross-workspace
    // ticket id collision can never leak into their analysis input.
    if (workspaceId) {
      where.workspaceId = workspaceId;
    }

    if (start || end) {
      where.occurredAt = {};
      if (start) where.occurredAt.gte = start;
      if (end) where.occurredAt.lte = end;
    }

    try {
      return await prisma.ticketThreadEntry.findMany({
        where,
        orderBy: [
          { ticketId: 'asc' },
          { occurredAt: 'asc' },
        ],
      });
    } catch (error) {
      logger.error('Failed to fetch ticket thread entries', error);
      throw new DatabaseError('Failed to fetch ticket thread entries', error);
    }
  }

  async listForTicket(ticketId, { limit = 200 } = {}) {
    try {
      return await prisma.ticketThreadEntry.findMany({
        where: { ticketId },
        orderBy: { occurredAt: 'asc' },
        take: limit,
      });
    } catch (error) {
      logger.error('Failed to fetch ticket thread for ticket', { ticketId, error: error.message });
      throw new DatabaseError('Failed to fetch ticket thread entries', error);
    }
  }
}

export default new TicketThreadRepository();
