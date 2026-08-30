import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { DatabaseError } from '../utils/errors.js';

/** Rows Ticket Pulse authored itself (live reply/note write). */
export const TP_AUTHORED_SOURCE = 'ticketpulse_user';

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * Update data for an FS-ingested entry landing on a row Ticket Pulse wrote
 * itself (Phase DR2). Attribution + content fields are deliberately absent:
 * source / actorName / actorEmail / actorFreshserviceId / authorType /
 * eventType / incoming / isPrivate / visibility / bodyHtml / bodyText /
 * content stay exactly as the agent sent them. actorFreshserviceId is
 * attribution too: FS's `user_id` on a reply Ticket Pulse posted is the
 * API-key owner, and the detail page's actor resolver would render THAT
 * ("Ticket Pulse") over the stored agent name. FS-derived metadata still
 * refreshes (timestamp, conversation payload).
 */
export function preservedUpdateData(entry, existingRow) {
  const data = { syncedAt: new Date() };
  if (entry.occurredAt) data.occurredAt = entry.occurredAt;
  if (entry.title && !existingRow?.title) data.title = entry.title;
  // Local keys win on collision except the wire-level recipient lists, which
  // FS knows better (it addressed the email) — everything else the local
  // row carries (editHistory, idempotencyKey, subject) is kept.
  const localRaw = plainObject(existingRow?.rawPayload);
  const fsRaw = plainObject(entry.rawPayload);
  if (Object.keys(fsRaw).length || Object.keys(localRaw).length) {
    data.rawPayload = {
      ...fsRaw,
      ...localRaw,
      ...(Array.isArray(fsRaw.to_emails) && fsRaw.to_emails.length ? { to_emails: fsRaw.to_emails } : {}),
      ...(Array.isArray(fsRaw.cc_emails) && fsRaw.cc_emails.length ? { cc_emails: fsRaw.cc_emails } : {}),
    };
  }
  return data;
}

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
    // The same lookup also carries id + source + rawPayload so the update
    // branch below can tell a row Ticket Pulse authored itself
    // (source='ticketpulse_user' — the live reply/note write on an FS-born
    // ticket) from a plain FS-ingested one (Phase DR2).
    const keyed = entries.filter((e) => e.externalEntryId);
    let existingKeys = new Set();
    const existingRows = new Map(); // `${ticketId}:${externalEntryId}` -> { id, source, rawPayload }
    if (keyed.length) {
      try {
        const existing = await prisma.ticketThreadEntry.findMany({
          where: { OR: keyed.map((e) => ({ ticketId: e.ticketId, externalEntryId: e.externalEntryId })) },
          select: { id: true, ticketId: true, externalEntryId: true, source: true, rawPayload: true },
        });
        existingKeys = new Set(existing.map((r) => `${r.ticketId}:${r.externalEntryId}`));
        for (const r of existing) existingRows.set(`${r.ticketId}:${r.externalEntryId}`, r);
      } catch (error) {
        logger.warn('Thread entry pre-lookup failed (attribution guard degraded for this batch)', { error: error.message });
      }
    }

    const withAttachments = []; // { entryRowId, entry } for FS attachment ingest
    for (const entry of entries) {
      try {
        const existingRow = entry.externalEntryId
          ? existingRows.get(`${entry.ticketId}:${entry.externalEntryId}`)
          : null;
        let row;
        if (existingRow && existingRow.source === TP_AUTHORED_SOURCE) {
          // Attribution preservation (Phase DR2, QA 08-28 #1): the row was
          // written by Ticket Pulse when the agent sent the reply — keep the
          // agent's name/email, the clean body and the TP source. Only
          // FS-derived metadata refreshes: the actor's FS id, the FS
          // timestamp, and the conversation payload (merged UNDER the local
          // rawPayload so recipients/editHistory/idempotency survive).
          row = await prisma.ticketThreadEntry.update({
            where: { id: existingRow.id },
            data: preservedUpdateData(entry, existingRow),
          });
        } else {
          row = await prisma.ticketThreadEntry.upsert({
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
        }
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
