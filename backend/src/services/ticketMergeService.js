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
    if (!source) throw new NotFoundError('This ticket no longer exists in the workspace');
    if (!target) throw new NotFoundError(`Ticket ${targetId} was not found in this workspace — use its TP-#### or #FS number`);
    if (['Deleted', 'Spam'].includes(target.status)) throw new ValidationError('Cannot merge into a deleted/spam ticket');
    if (['Deleted', 'Spam'].includes(source.status)) throw new ValidationError('Cannot merge a deleted/spam ticket');

    // Survivor gate: the target carries the live conversation forward, so it
    // must be a TP-born Open/Pending ticket. Copying messages onto an FS-born
    // target would strand them in a TP shadow FreshService never sees; a
    // Resolved/Closed target is a husk nobody watches. (Previously this only
    // guarded the batch path — the single-merge endpoint bypassed it.)
    if (target.origin !== 'ticketpulse') {
      throw new ValidationError('You can only merge into a Ticket Pulse–born ticket (FreshService owns FS-born conversations — merge those in FreshService)');
    }
    if (!['Open', 'Pending'].includes(target.status)) {
      throw new ValidationError('The ticket you merge into must be Open or Pending');
    }

    // Refuse circular merges (target already merged into source).
    const circular = await prisma.ticketLink.findFirst({
      where: { workspaceId, ticketId: targetId, relatedTicketId: sourceId, kind: 'merged_into' },
    });
    if (circular) throw new ValidationError('That ticket was already merged into this one');
    // Refuse chained-merge black holes: never merge into a ticket that has
    // itself already been merged away (A→B, then C→A). Point at the survivor.
    const targetMergedAway = await prisma.ticketLink.findFirst({
      where: { workspaceId, ticketId: targetId, kind: 'merged_into' },
    });
    if (targetMergedAway) throw new ValidationError('That ticket was already merged into another ticket — merge into the surviving ticket instead');

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

    // 3b. Reconcile the source's dependents so nothing is stranded on the husk:
    //     open work and children follow the conversation to the survivor, and
    //     pending approvals are cancelled so their 30-day magic links die.
    const swept = { tasks: 0, children: 0, approvals: 0 };
    try {
      // Open TP-born tasks move to the survivor. FS-born tasks belong to the
      // FreshService ticket (closed there separately) — leave them be.
      const movedTasks = await prisma.ticketTask.updateMany({
        where: { ticketId: sourceId, workspaceId, origin: 'ticketpulse', status: { not: 'done' } },
        data: { ticketId: targetId },
      });
      swept.tasks = movedTasks.count;
    } catch (err) {
      logger.warn(`Merge task reconciliation failed (non-fatal): ${err.message}`);
    }
    try {
      // Re-parent the source's children onto the survivor; drop any link that
      // would point the survivor at itself or duplicate an existing parent.
      const childLinks = await prisma.ticketLink.findMany({
        where: { workspaceId, ticketId: sourceId, kind: 'parent_of' },
      });
      for (const cl of childLinks) {
        if (cl.relatedTicketId === targetId) { await prisma.ticketLink.delete({ where: { id: cl.id } }); continue; }
        try {
          await prisma.ticketLink.update({ where: { id: cl.id }, data: { ticketId: targetId } });
          swept.children += 1;
        } catch { await prisma.ticketLink.delete({ where: { id: cl.id } }); }
      }
      // The husk no longer needs its own parent link.
      await prisma.ticketLink.deleteMany({ where: { workspaceId, relatedTicketId: sourceId, kind: 'parent_of' } });
    } catch (err) {
      logger.warn(`Merge child reconciliation failed (non-fatal): ${err.message}`);
    }
    try {
      const cancelled = await prisma.ticketApproval.updateMany({
        where: { ticketId: sourceId, workspaceId, status: { in: ['pending', 'info_requested'] } },
        data: { status: 'cancelled', decidedAt: new Date(), decidedVia: 'app', decisionNote: `Auto-cancelled: ${srcRef} merged into ${tgtRef}` },
      });
      swept.approvals = cancelled.count;
    } catch (err) {
      logger.warn(`Merge approval reconciliation failed (non-fatal): ${err.message}`);
    }

    // 4. System note on the target describing what arrived.
    const attachmentCount = await prisma.ticketAttachment.count({ where: { ticketId: sourceId } });
    const { default: ticketService } = await import('./ticketService.js');
    const sweptBits = [
      swept.tasks ? `${swept.tasks} open task${swept.tasks === 1 ? '' : 's'}` : null,
      swept.children ? `${swept.children} child ticket${swept.children === 1 ? '' : 's'}` : null,
    ].filter(Boolean);
    await ticketService.addPrivateNote(targetId, workspaceId, {
      bodyText: [
        `Merged ${srcRef} ("${source.subject || 'no subject'}") into this ticket — ${copied} message${copied === 1 ? '' : 's'} copied in.`,
        sweptBits.length ? `${sweptBits.join(' and ')} moved over.` : null,
        swept.approvals ? `${swept.approvals} pending approval${swept.approvals === 1 ? '' : 's'} on ${srcRef} cancelled.` : null,
        attachmentCount > 0 ? `${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'} remain on ${srcRef}.` : null,
        `Merged by ${actorLabel}.`,
      ].filter(Boolean).join(' '),
    }, actor).catch((err) => logger.warn(`Merge target note failed (non-fatal): ${err.message}`));

    // 5. Optional requester notification BEFORE closing. addReply routes a
    //    public reply through FreshService for an FS-born source (which emails
    //    the requester), and through the TP mirror for a TP-born source.
    let requesterNotified = false;
    if (notifyRequester) {
      try {
        await ticketService.addReply(sourceId, workspaceId, {
          bodyText: `Your ticket has been consolidated into ${tgtRef} ("${target.subject || ''}"). All further updates will come from that ticket.`,
        }, actor);
        requesterNotified = true;
      } catch (err) {
        logger.warn(`Merge requester notification failed (non-fatal): ${err.message}`);
      }
    }

    // 6. Close out the source. addPrivateNote routes to FreshService for an
    //    FS-born source, so the pointer note lands on the FS ticket too.
    await ticketService.addPrivateNote(sourceId, workspaceId, {
      bodyText: `Merged into ${tgtRef} by ${actorLabel}. The conversation continues there.`,
    }, actor).catch(() => null);
    let sourceClosed = false;
    if (!['Resolved', 'Closed'].includes(source.status)) {
      if (source.origin === 'ticketpulse') {
        await ticketService.changeStatus(sourceId, workspaceId, 'Closed', actor);
        sourceClosed = true;
      } else {
        // FS-born source (QA 07-16 #5): close it in FreshService via the
        // origin-aware writeback path (interactive client + FS status map).
        try {
          await ticketService.updateFsTicket(sourceId, workspaceId, { status: 'Closed' }, actor);
          sourceClosed = true;
        } catch (err) {
          logger.warn(`Merge could not close FS-born source ${srcRef} in FreshService (non-fatal): ${err.message}`);
        }
      }
    }

    // 7. Audit both sides.
    const details = { sourceId, targetId, srcRef, tgtRef, copied, requesterNotified, swept };
    await Promise.all([
      ticketActivityRepository.create({ ticketId: sourceId, activityType: 'merged_into', performedBy: actor?.email || 'system', details }),
      ticketActivityRepository.create({ ticketId: targetId, activityType: 'merged_from', performedBy: actor?.email || 'system', details }),
    ]).catch(() => null);

    logger.info(`Merged ticket ${srcRef} -> ${tgtRef} (${copied} entries copied)`);
    return { merged: true, sourceId, targetId, copied, sourceClosed, requesterNotified, swept, targetRef: tgtRef };
  }

  /**
   * Multi-merge (QA 07-13 #1): merge several tickets into one chosen primary
   * in a single confirmed action. Validates the whole batch up front, then
   * runs the proven single merges sequentially (idempotent provenance stamps
   * make a retry after a mid-batch failure safe). The primary must be an
   * open/pending TP-born ticket — it's about to carry the live conversation.
   */
  async mergeMany(primaryId, workspaceId, { ticketIds, notifyRequester = false }, actor) {
    const primary = await prisma.ticket.findFirst({ where: { id: Number(primaryId), workspaceId } });
    if (!primary) throw new NotFoundError('Primary ticket not found');
    if (primary.origin !== 'ticketpulse') {
      throw new ValidationError('The primary must be a Ticket Pulse–born ticket (FreshService owns FS-born conversations — merge those in FreshService)');
    }
    if (!['Open', 'Pending'].includes(primary.status)) {
      throw new ValidationError('The primary ticket must be Open or Pending');
    }

    const ids = [...new Set((ticketIds || []).map(Number).filter((n) => Number.isFinite(n) && n !== primary.id))];
    if (!ids.length) throw new ValidationError('Pick at least one ticket to merge');
    if (ids.length > 20) throw new ValidationError('Merge at most 20 tickets at once');
    const sources = await prisma.ticket.findMany({ where: { id: { in: ids }, workspaceId } });
    if (sources.length !== ids.length) throw new NotFoundError('One or more selected tickets were not found in this workspace');
    for (const s of sources) {
      if (['Deleted', 'Spam'].includes(s.status)) {
        throw new ValidationError(`${ticketDisplayRef(s)} is ${s.status} and cannot be merged`);
      }
    }

    const merged = [];
    const failed = [];
    // Oldest first so the primary's copied thread interleaves naturally.
    sources.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    for (const s of sources) {
      try {
        const result = await this.merge(s.id, workspaceId, { targetTicketId: primary.id, notifyRequester }, actor);
        merged.push({ id: s.id, ref: ticketDisplayRef(s), copied: result.copied });
      } catch (err) {
        failed.push({ id: s.id, ref: ticketDisplayRef(s), error: err.message });
        logger.warn(`Multi-merge: ${ticketDisplayRef(s)} -> ${ticketDisplayRef(primary)} failed: ${err.message}`);
      }
    }
    return {
      primaryId: primary.id,
      primaryRef: ticketDisplayRef(primary),
      merged,
      failed,
      messagesCopied: merged.reduce((n, m) => n + (m.copied || 0), 0),
    };
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
