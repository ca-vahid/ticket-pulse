import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import ticketActivityRepository from './ticketActivityRepository.js';

/**
 * Split a conversation out of a ticket (QA 09-08).
 *
 * The mirror image of ticketMergeService, and it inherits that service's hard
 * lessons — but its central constraint is the OPPOSITE one:
 *
 *   Merge requires a TP-born SURVIVOR, because it copies messages INTO the
 *   survivor and FreshService would never see them.
 *
 *   Split must work on FS-BORN PARENTS, or it is useless: 473 of the 482
 *   tickets in production with 5+ messages are FS-born. That turns out to be
 *   safe, because a split never modifies the parent's conversation. It adds a
 *   link and a note, and creates a TP-BORN CHILD that owns the split-out
 *   issue from here on.
 *
 * Entries are COPIED, never moved. An FS-sourced entry keeps its
 * externalEntryId for re-sync dedupe, and that dedupe is per-ticket
 * (@@unique([ticketId, externalEntryId])) — so moving one would have it
 * resurrected on the parent by the next FreshService sync. Copies are stamped
 * `split:<parentId>:<entryId>`, which also makes a repeated split idempotent.
 *
 * Attachments tied to the selected entries DO move: a screenshot of the
 * split-out problem belongs with the split-out ticket. Ticket-level
 * attachments (290 of 867 in production have no entry) stay on the parent —
 * we cannot know which issue they belong to. Rows are re-pointed rather than
 * duplicated, because blobName is unique and two rows sharing one blob would
 * make a delete destructive across tickets.
 */

// Copy the conversation, not the FreshService activity feed — same filter merge uses.
const CONVERSATION_SOURCES = { not: 'freshservice_activity' };

class TicketSplitService {
  /**
   * @param {number} parentId
   * @param {number} workspaceId
   * @param {object} input
   *   entryIds        {number[]} thread entries to carry over (may be empty)
   *   subject         {string}   required — the new ticket's subject
   *   description     {string?}  optional opening description
   *   requesterId     {number?}  defaults to the parent's requester
   *   priority        {number?}  defaults to the parent's
   *   internalCategoryId / internalSubcategoryId / groupId / internalGroupId
   *   assignedTechId  {number?}
   *   moveAttachments {boolean}  default true — attachments on the copied entries
   *   notifyRequester {boolean}  default false — a public reply on the child
   * @param {object} actor
   */
  async split(parentId, workspaceId, input = {}, actor = null) {
    const subject = String(input.subject || '').trim();
    if (!subject) throw new ValidationError('The new ticket needs a subject');
    if (subject.length > 500) throw new ValidationError('Subject is too long (max 500 characters)');

    const parent = await prisma.ticket.findFirst({
      where: { id: parentId, workspaceId },
      include: { requester: { select: { id: true, email: true, name: true } } },
    });
    if (!parent) throw new NotFoundError('This ticket no longer exists in the workspace');
    if (['Deleted', 'Spam'].includes(parent.status)) {
      throw new ValidationError(`Cannot split a ${parent.status.toLowerCase()} ticket`);
    }

    const requestedIds = [...new Set((Array.isArray(input.entryIds) ? input.entryIds : [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0))];

    // Only entries that actually belong to THIS ticket, and only real
    // messages — an agent selecting an id from another ticket gets a clear
    // error rather than a silently empty split.
    let entries = [];
    if (requestedIds.length) {
      entries = await prisma.ticketThreadEntry.findMany({
        where: {
          id: { in: requestedIds },
          ticketId: parentId,
          source: CONVERSATION_SOURCES,
        },
        orderBy: { occurredAt: 'asc' },
      });
      // Check what is MISSING rather than comparing lengths: a length test
      // can fire with an empty list and an error message that names nothing.
      const found = new Set(entries.map((e) => e.id));
      const missing = requestedIds.filter((id) => !found.has(id));
      if (missing.length) {
        throw new ValidationError(`These messages are not part of this ticket's conversation: ${missing.join(', ')}`);
      }
      // And only carry what was actually asked for.
      entries = entries.filter((e) => requestedIds.includes(e.id));
    }

    const parentRef = ticketDisplayRef(parent);
    const actorLabel = actor?.name || actor?.email || 'an agent';

    // 1. The child is always TP-born, whatever the parent is: it owns the
    //    split-out issue going forward, so it must be fully editable here.
    const { default: ticketService } = await import('./ticketService.js');
    const opening = String(input.description || '').trim()
      || `<p>Split out of ${parentRef} by ${actorLabel}.</p>`;

    const child = await ticketService.createTicket(workspaceId, {
      subject,
      description: opening,
      priority: Number(input.priority) || parent.priority || 2,
      requesterId: input.requesterId !== undefined && input.requesterId !== null
        ? Number(input.requesterId) || undefined
        : (parent.requesterId || undefined),
      requesterEmail: parent.requester?.email || undefined,
      requesterName: parent.requester?.name || undefined,
      internalCategoryId: input.internalCategoryId !== undefined
        ? (input.internalCategoryId === null ? null : Number(input.internalCategoryId))
        : (parent.internalCategoryId || null),
      internalSubcategoryId: input.internalSubcategoryId !== undefined
        ? (input.internalSubcategoryId === null ? null : Number(input.internalSubcategoryId))
        : (parent.internalSubcategoryId || null),
      ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
      ...(input.internalGroupId !== undefined ? { internalGroupId: input.internalGroupId } : {}),
      ...(input.assignedTechId ? { assignedTechId: Number(input.assignedTechId) } : {}),
      // The agent chose the category deliberately; don't spend an LLM run
      // re-deciding it, and don't email the requester unless asked.
      runAiTriage: false,
      notifyRequester: input.notifyRequester === true,
    }, actor);

    const childRef = child.displayRef || `TP-${child.nativeNumber || child.id}`;

    // 2. Copy the selected messages with provenance. NEVER move: an FS-sourced
    //    entry would be resurrected on the parent by the next sync.
    let copied = 0;
    if (entries.length) {
      const result = await prisma.ticketThreadEntry.createMany({
        data: entries.map((e) => ({
          ticketId: child.id,
          workspaceId,
          externalEntryId: `split:${parentId}:${e.id}`,
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
          // TP-side records of the split — never mirrored back to FreshService.
          mirrorState: null,
        })),
        skipDuplicates: true,
      });
      copied = result.count;
    }

    // 3. Attachments on the copied entries follow the issue they illustrate.
    //    Re-pointed, not duplicated: blobName is unique and a shared blob
    //    would make deleting from one ticket destroy the other's copy.
    let attachmentsMoved = 0;
    if (entries.length && input.moveAttachments !== false) {
      try {
        const moved = await prisma.ticketAttachment.updateMany({
          where: { ticketId: parentId, workspaceId, threadEntryId: { in: entries.map((e) => e.id) } },
          data: { ticketId: child.id },
        });
        attachmentsMoved = moved.count;
      } catch (err) {
        logger.warn(`Split attachment move failed (non-fatal): ${err.message}`);
      }
    }

    // 4. Family link. setParent owns the invariants (one parent, no cycles),
    //    so go through it rather than writing the link directly.
    let linkKind = 'parent_of';
    try {
      const { default: ticketLinkService } = await import('./ticketLinkService.js');
      await ticketLinkService.setParent(child.id, workspaceId, { parentTicketId: parentId }, actor);
    } catch (err) {
      // A parent that is itself a child of the new ticket, or any other
      // invariant, must not lose us the split — fall back to a plain relation.
      logger.warn(`Split parent link failed, falling back to related_to: ${err.message}`);
      linkKind = 'related_to';
      await prisma.ticketLink.upsert({
        where: { ticketId_relatedTicketId_kind: { ticketId: parentId, relatedTicketId: child.id, kind: 'related_to' } },
        update: {},
        create: { workspaceId, ticketId: parentId, relatedTicketId: child.id, kind: 'related_to', createdBy: actor?.email || null },
      });
    }

    // 5. A note on each side. On an FS-born parent this is an FS API write on
    //    the interactive lane, so it can 503 under queue pressure — the split
    //    must already be complete and durable by now. Best-effort, like merge.
    const parts = [
      `Split into ${childRef} ("${subject}") by ${actorLabel}.`,
      copied ? `${copied} message${copied === 1 ? '' : 's'} copied across.` : null,
      attachmentsMoved ? `${attachmentsMoved} attachment${attachmentsMoved === 1 ? '' : 's'} moved to ${childRef}.` : null,
      'This ticket is unchanged otherwise.',
    ].filter(Boolean);
    await ticketService.addPrivateNote(parentId, workspaceId, { bodyText: parts.join(' ') }, actor)
      .catch((err) => logger.warn(`Split parent note failed (non-fatal): ${err.message}`));
    await ticketService.addPrivateNote(child.id, workspaceId, {
      bodyText: `Split out of ${parentRef} ("${parent.subject || 'no subject'}") by ${actorLabel}.`
        + (copied ? ` ${copied} message${copied === 1 ? '' : 's'} carried over.` : '')
        + ` Attachments and history that stayed behind are on ${parentRef}.`,
    }, actor).catch((err) => logger.warn(`Split child note failed (non-fatal): ${err.message}`));

    // 6. Audit on both tickets.
    const details = { childId: child.id, childRef, parentId, parentRef, copied, attachmentsMoved, linkKind, subject };
    await Promise.all([
      ticketActivityRepository.create({
        ticketId: parentId,
        activityType: 'split_into',
        performedBy: actor?.email || actor?.name || 'system',
        performedAt: new Date(),
        details,
      }).catch(() => {}),
      ticketActivityRepository.create({
        ticketId: child.id,
        activityType: 'split_from',
        performedBy: actor?.email || actor?.name || 'system',
        performedAt: new Date(),
        details,
      }).catch(() => {}),
    ]);

    logger.info(`Ticket split: ${parentRef} -> ${childRef} (${copied} messages, ${attachmentsMoved} attachments)`);

    return {
      parent: { id: parentId, ref: parentRef },
      child: { id: child.id, ref: childRef, subject },
      copied,
      attachmentsMoved,
      linkKind,
    };
  }

  /**
   * The messages a split can carry — the same set the thread shows, so the UI
   * checkbox list and the server agree on what is selectable.
   */
  async splittableEntries(ticketId, workspaceId) {
    const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, workspaceId }, select: { id: true } });
    if (!ticket) throw new NotFoundError('This ticket no longer exists in the workspace');
    const rows = await prisma.ticketThreadEntry.findMany({
      where: {
        ticketId,
        source: CONVERSATION_SOURCES,
        OR: [{ bodyText: { not: null } }, { content: { not: null } }, { bodyHtml: { not: null } }],
      },
      orderBy: { occurredAt: 'asc' },
      select: {
        id: true, eventType: true, actorName: true, actorEmail: true, authorType: true,
        isPrivate: true, occurredAt: true, bodyText: true, content: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      author: r.actorName || r.actorEmail || 'unknown',
      authorType: r.authorType,
      isPrivate: r.isPrivate === true,
      occurredAt: r.occurredAt,
      excerpt: String(r.bodyText || r.content || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    }));
  }
}

export default new TicketSplitService();
