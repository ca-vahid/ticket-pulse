import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import ticketActivityRepository from './ticketActivityRepository.js';

/**
 * True ticket merge (gap plan Phase 2.1).
 *
 * Semantics (honest v1):
 *  - The source's conversation entries are COPIED onto the target with a
 *    provenance-stamped externalEntryId (`merged:<srcId>:<entryId>`), keeping
 *    original authors/timestamps so they interleave naturally. Copy (not move)
 *    keeps the source's own history intact and makes re-merge idempotent via
 *    the (ticketId, externalEntryId) unique constraint.
 *  - Tags union onto the target. Attachments stay on the source (a system note
 *    on the target says where they live) — duplicating rows that point at one
 *    stored blob would make deletes destructive across tickets.
 *  - The source gets a `merged_into` link + closing note; TP-born sources are
 *    Closed through the normal status path (mirror + events). FS-born sources
 *    keep their FreshService status (FS owns it) — note + link only.
 *  - Optional requester notification (TP-born sources only): a public reply
 *    through the normal reply path, so it emails via the usual machinery.
 */
class TicketMergeService {
  async merge(sourceId, workspaceId, { targetTicketId, notifyRequester = false }, actor) {
    const targetId = Number(targetTicketId);
    if (!Number.isFinite(targetId) || targetId <= 0) throw new ValidationError('targetTicketId is required');
    if (targetId === sourceId) throw new ValidationError('A ticket cannot be merged into itself');

    const [source, target] = await Promise.all([
      prisma.ticket.findFirst({ where: { id: sourceId, workspaceId } }),
      prisma.ticket.findFirst({ where: { id: targetId, workspaceId } }),
    ]);
    if (!source || !target) throw new NotFoundError('Both tickets must exist in this workspace');
    if (['Deleted', 'Spam'].includes(target.status)) throw new ValidationError('Cannot merge into a deleted/spam ticket');
    if (['Deleted', 'Spam'].includes(source.status)) throw new ValidationError('Cannot merge a deleted/spam ticket');

    // Refuse circular merges (target already merged into source).
    const circular = await prisma.ticketLink.findFirst({
      where: { workspaceId, ticketId: targetId, relatedTicketId: sourceId, kind: 'merged_into' },
    });
    if (circular) throw new ValidationError('That ticket was already merged into this one');

    const srcRef = ticketDisplayRef(source);
    const tgtRef = ticketDisplayRef(target);
    const actorLabel = actor?.name || actor?.email || 'an agent';

    // 1. Copy conversation MESSAGES (not the FS activity feed) with provenance.
    const entries = await prisma.ticketThreadEntry.findMany({
      where: {
        ticketId: sourceId,
        source: { not: 'freshservice_activity' },
        OR: [{ bodyText: { not: null } }, { content: { not: null } }, { bodyHtml: { not: null } }],
      },
      orderBy: { occurredAt: 'asc' },
    });
    let copied = 0;
    if (entries.length) {
      const result = await prisma.ticketThreadEntry.createMany({
        data: entries.map((e) => ({
          ticketId: targetId,
          workspaceId,
          externalEntryId: `merged:${sourceId}:${e.id}`,
          source: e.source,
          eventType: e.eventType,
          actorName: e.actorName,
          actorEmail: e.actorEmail,
          actorFreshserviceId: e.actorFreshserviceId,
          authorType: e.authorType,
          incoming: e.incoming,
          isPrivate: e.isPrivate,
          visibility: e.visibility,
          title: e.title,
          content: e.content,
          bodyHtml: e.bodyHtml,
          bodyText: e.bodyText,
          occurredAt: e.occurredAt,
          // Copies are TP-side records of the merge — never mirrored to FS.
          mirrorState: null,
        })),
        skipDuplicates: true,
      });
      copied = result.count;
    }

    // 2. Union tags onto the target.
    const sourceTagLinks = await prisma.ticketTagLink.findMany({ where: { ticketId: sourceId }, select: { tagId: true } });
    if (sourceTagLinks.length) {
      await prisma.ticketTagLink.createMany({
        data: sourceTagLinks.map((l) => ({ ticketId: targetId, tagId: l.tagId, createdBy: actor?.email || 'merge' })),
        skipDuplicates: true,
      });
    }

    // 3. merged_into link (idempotent upsert).
    await prisma.ticketLink.upsert({
      where: { ticketId_relatedTicketId_kind: { ticketId: sourceId, relatedTicketId: targetId, kind: 'merged_into' } },
      update: {},
      create: { workspaceId, ticketId: sourceId, relatedTicketId: targetId, kind: 'merged_into', createdBy: actor?.email || null },
    });

    // 4. System note on the target describing what arrived.
    const attachmentCount = await prisma.ticketAttachment.count({ where: { ticketId: sourceId } });
    const { default: ticketService } = await import('./ticketService.js');
    await ticketService.addPrivateNote(targetId, workspaceId, {
      bodyText: [
        `Merged ${srcRef} ("${source.subject || 'no subject'}") into this ticket — ${copied} message${copied === 1 ? '' : 's'} copied in.`,
        attachmentCount > 0 ? `${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'} remain on ${srcRef}.` : null,
        `Merged by ${actorLabel}.`,
      ].filter(Boolean).join(' '),
    }, actor).catch((err) => logger.warn(`Merge target note failed (non-fatal): ${err.message}`));

    // 5. Optional requester notification BEFORE closing (TP-born source only —
    //    FreshService owns comms on FS-born tickets).
    let requesterNotified = false;
    if (notifyRequester && source.origin === 'ticketpulse') {
      try {
        await ticketService.addReply(sourceId, workspaceId, {
          bodyText: `Your ticket has been consolidated into ${tgtRef} ("${target.subject || ''}"). All further updates will come from that ticket.`,
        }, actor);
        requesterNotified = true;
      } catch (err) {
        logger.warn(`Merge requester notification failed (non-fatal): ${err.message}`);
      }
    }

    // 6. Close out the source.
    await ticketService.addPrivateNote(sourceId, workspaceId, {
      bodyText: `Merged into ${tgtRef} by ${actorLabel}. The conversation continues there.`,
    }, actor).catch(() => null);
    let sourceClosed = false;
    if (source.origin === 'ticketpulse' && !['Resolved', 'Closed'].includes(source.status)) {
      await ticketService.changeStatus(sourceId, workspaceId, 'Closed', actor);
      sourceClosed = true;
    }

    // 7. Audit both sides.
    const details = { sourceId, targetId, srcRef, tgtRef, copied, requesterNotified };
    await Promise.all([
      ticketActivityRepository.create({ ticketId: sourceId, activityType: 'merged_into', performedBy: actor?.email || 'system', details }),
      ticketActivityRepository.create({ ticketId: targetId, activityType: 'merged_from', performedBy: actor?.email || 'system', details }),
    ]).catch(() => null);

    logger.info(`Merged ticket ${srcRef} -> ${tgtRef} (${copied} entries copied)`);
    return { merged: true, sourceId, targetId, copied, sourceClosed, requesterNotified, targetRef: tgtRef };
  }

  /** The target this ticket was merged into, if any (for the detail banner). */
  async mergedInto(ticketId, workspaceId) {
    const link = await prisma.ticketLink.findFirst({
      where: { workspaceId, ticketId, kind: 'merged_into' },
      include: { relatedTicket: { select: { id: true, subject: true, status: true, origin: true, nativeNumber: true, freshserviceTicketId: true } } },
    });
    if (!link) return null;
    return { ...link.relatedTicket, displayRef: ticketDisplayRef(link.relatedTicket) };
  }
}

const ticketMergeService = new TicketMergeService();
export default ticketMergeService;
