import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { DatabaseError } from '../utils/errors.js';

class TicketThreadRepository {
  async bulkUpsert(entries = []) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return { upserted: 0 };
    }

    let upserted = 0;

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
      } catch (error) {
        logger.warn('Failed to upsert ticket thread entry', {
          ticketId: entry.ticketId,
          externalEntryId: entry.externalEntryId,
          error: error.message,
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
