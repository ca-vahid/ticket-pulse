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

    // Which of these rows already exist? Needed below to tell a NEW customer
    // reply (should re-classify requester sentiment) from a re-synced old one
    // (should not). Best-effort — a failed lookup only skips the refresh.
    const keyed = entries.filter((e) => e.externalEntryId);
    let existingKeys = new Set();
    if (keyed.length) {
      try {
        const existing = await prisma.ticketThreadEntry.findMany({
          where: { OR: keyed.map((e) => ({ ticketId: e.ticketId, externalEntryId: e.externalEntryId })) },
          select: { ticketId: true, externalEntryId: true },
        });
        existingKeys = new Set(existing.map((r) => `${r.ticketId}:${r.externalEntryId}`));
      } catch { /* detection only */ }
    }

    const withAttachments = []; // { entryRowId, entry } for FS attachment ingest
    for (const entry of entries) {
      try {
        const row = await prisma.ticketThreadEntry.upsert({
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
        if (Array.isArray(entry.rawPayload?.attachments) && entry.rawPayload.attachments.length) {
          withAttachments.push({ entryRowId: row.id, entry });
        }
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

    // FS conversation attachments ride the conversation payload — record them
    // (metadata only; bytes fetched on first download) against their thread
    // entry so they render inline in the conversation. Dedupe lives in the
    // ingest itself (unique blobName), so re-syncs are no-ops.
    if (withAttachments.length) {
      try {
        const { default: attachmentService } = await import('./attachmentService.js');
        for (const { entryRowId, entry } of withAttachments) {
          for (const att of entry.rawPayload.attachments) {
            await attachmentService.ingestFreshServiceAttachment({
              workspaceId: entry.workspaceId,
              ticketId: entry.ticketId,
              threadEntryId: entryRowId,
              fsAttachment: att,
            });
          }
        }
      } catch (error) {
        logger.warn('FS conversation attachment ingest failed (non-fatal)', { error: error.message });
      }
    }

    // FS-born tickets get requester replies via THIS sync path (there is no
    // mailbox-ingest event for them), so the sentiment chip never refreshed on
    // FS tickets (QA 07-08, #231930). Schedule a re-classification for tickets
    // that just gained a genuinely new, recent customer reply. The 24h recency
    // guard keeps historical preheats/backfills from burning AI calls, and the
    // service's own debounce coalesces multi-entry bursts.
    try {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const refreshTickets = new Map(); // ticketId -> workspaceId
      for (const entry of keyed) {
        if (entry.eventType !== 'customer_reply') continue;
        if (existingKeys.has(`${entry.ticketId}:${entry.externalEntryId}`)) continue;
        const at = entry.occurredAt ? new Date(entry.occurredAt).getTime() : 0;
        if (!at || at < cutoff) continue;
        refreshTickets.set(entry.ticketId, entry.workspaceId);
      }
      if (refreshTickets.size) {
        const { default: ticketSentimentService } = await import('./ticketSentimentService.js');
        for (const [ticketId, workspaceId] of refreshTickets) {
          ticketSentimentService.scheduleRefresh(ticketId, workspaceId);
        }
      }
    } catch { /* sentiment is an annotation, never a sync step */ }

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
