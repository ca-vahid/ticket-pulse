import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';

const LINK_KINDS = ['duplicate_of', 'related_to', 'parent_of'];
// The inverse label shown on the other ticket. merged_into links are created
// by ticketMergeService (not user-linkable directly).
const INVERSE_LABEL = { duplicate_of: 'has duplicate', related_to: 'related to', parent_of: 'child of', merged_into: 'merged from' };

/**
 * Explicit ticket relationships: duplicate_of / related_to / parent_of.
 * "Mark as duplicate" also resolves the source ticket with an audit note —
 * an honest lightweight merge (the conversation stays on the target).
 */
class TicketLinkService {
  async listForTicket(ticketId, workspaceId) {
    const [from, to] = await Promise.all([
      prisma.ticketLink.findMany({
        where: { ticketId, workspaceId },
        include: { relatedTicket: { select: { id: true, subject: true, status: true, origin: true, nativeNumber: true, freshserviceTicketId: true } } },
      }),
      prisma.ticketLink.findMany({
        where: { relatedTicketId: ticketId, workspaceId },
        include: { ticket: { select: { id: true, subject: true, status: true, origin: true, nativeNumber: true, freshserviceTicketId: true } } },
      }),
    ]);
    return [
      ...from.map((l) => ({
        id: l.id, kind: l.kind, direction: 'out',
        other: { ...l.relatedTicket, displayRef: ticketDisplayRef(l.relatedTicket) },
      })),
      ...to.map((l) => ({
        id: l.id, kind: l.kind, direction: 'in', label: INVERSE_LABEL[l.kind] || l.kind,
        other: { ...l.ticket, displayRef: ticketDisplayRef(l.ticket) },
      })),
    ];
  }

  async link(ticketId, workspaceId, { relatedTicketId, kind }, actor) {
    if (!LINK_KINDS.includes(kind)) throw new ValidationError(`Link kind must be one of: ${LINK_KINDS.join(', ')}`);
    const relatedId = Number(relatedTicketId);
    if (!Number.isFinite(relatedId) || relatedId === ticketId) throw new ValidationError('Pick a different ticket to link');
    const [ticket, related] = await Promise.all([
      prisma.ticket.findFirst({ where: { id: ticketId, workspaceId } }),
      prisma.ticket.findFirst({ where: { id: relatedId, workspaceId } }),
    ]);
    if (!ticket) throw new NotFoundError('This ticket no longer exists in the workspace');
    if (!related) throw new NotFoundError(`Ticket ${relatedId} was not found in this workspace — link by its TP-#### or #FS number`);

    const linkRow = await prisma.ticketLink.upsert({
      where: { ticketId_relatedTicketId_kind: { ticketId, relatedTicketId: relatedId, kind } },
      update: {},
      create: { workspaceId, ticketId, relatedTicketId: relatedId, kind, createdBy: actor?.email || null },
    });
    logger.info(`Ticket link: ${ticketDisplayRef(ticket)} ${kind} ${ticketDisplayRef(related)}`);
    return linkRow;
  }

  async unlink(ticketId, workspaceId, linkId) {
    const link = await prisma.ticketLink.findFirst({
      where: { id: Number(linkId), workspaceId, OR: [{ ticketId }, { relatedTicketId: ticketId }] },
    });
    if (!link) throw new NotFoundError('Link not found');
    await prisma.ticketLink.delete({ where: { id: link.id } });
    return { deleted: true };
  }

  /**
   * Mark THIS ticket as a duplicate of the target: link + resolve the source
   * with an audit trail. TP-born sources resolve through the normal status
   * path (mirror + events); FS-born sources only get the link (FreshService
   * owns their status).
   */
  async markDuplicate(ticketId, workspaceId, targetTicketId, actor) {
    const link = await this.link(ticketId, workspaceId, { relatedTicketId: targetTicketId, kind: 'duplicate_of' }, actor);
    const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, workspaceId } });
    const target = await prisma.ticket.findFirst({ where: { id: Number(targetTicketId), workspaceId } });

    let resolved = false;
    if (ticket.origin === 'ticketpulse' && !['Resolved', 'Closed'].includes(ticket.status)) {
      const { default: ticketService } = await import('./ticketService.js');
      await ticketService.addPrivateNote(ticketId, workspaceId, {
        bodyText: `Marked as a duplicate of ${ticketDisplayRef(target)} by ${actor?.name || actor?.email || 'an agent'}. The conversation continues there.`,
      }, actor);
      await ticketService.changeStatus(ticketId, workspaceId, 'Resolved', actor);
      resolved = true;
    }
    return { link, resolved };
  }

  // ---- Parent / child (QA 07-16 #4, Option A) --------------------------
  // Convention: a `parent_of` link is stored as { ticketId: parent,
  // relatedTicketId: child }. Children are real, independently-assigned
  // tickets; the relationship is Ticket-Pulse-authoritative and mirrored to
  // FreshService as a cosmetic pointer note (FS has no writable parent field).

  /** { parent: {…}|null, children: [{…}] } for the family cards. */
  async family(ticketId, workspaceId) {
    const [parentLink, childLinks] = await Promise.all([
      prisma.ticketLink.findFirst({
        where: { workspaceId, relatedTicketId: ticketId, kind: 'parent_of' },
        include: { ticket: { select: { id: true, subject: true, status: true, origin: true, nativeNumber: true, freshserviceTicketId: true, assignedTech: { select: { id: true, name: true, photoUrl: true } } } } },
      }),
      prisma.ticketLink.findMany({
        where: { workspaceId, ticketId, kind: 'parent_of' },
        include: { relatedTicket: { select: { id: true, subject: true, status: true, origin: true, nativeNumber: true, freshserviceTicketId: true, assignedTech: { select: { id: true, name: true, photoUrl: true } } } } },
        orderBy: { id: 'asc' },
      }),
    ]);
    const asCard = (t, linkId) => ({
      id: t.id, linkId, subject: t.subject, status: t.status,
      displayRef: ticketDisplayRef(t),
      assignee: t.assignedTech ? { id: t.assignedTech.id, name: t.assignedTech.name, photoUrl: t.assignedTech.photoUrl } : null,
    });
    return {
      parent: parentLink ? asCard(parentLink.ticket, parentLink.id) : null,
      children: childLinks.map((l) => asCard(l.relatedTicket, l.id)),
    };
  }

  /** Make `childId` a child of `parentTicketId`. Enforces one-parent-per-child
   *  and forbids cycles (a ticket can't become a child of its own descendant). */
  async setParent(childId, workspaceId, { parentTicketId }, actor) {
    const parentId = Number(parentTicketId);
    if (!Number.isFinite(parentId) || parentId === childId) throw new ValidationError('Pick a different ticket as the parent');
    const [child, parent] = await Promise.all([
      prisma.ticket.findFirst({ where: { id: childId, workspaceId } }),
      prisma.ticket.findFirst({ where: { id: parentId, workspaceId } }),
    ]);
    if (!child) throw new NotFoundError('This ticket no longer exists in the workspace');
    if (!parent) throw new NotFoundError(`Ticket ${parentId} was not found in this workspace — link by its TP-#### or #FS number`);

    // Cycle guard: the proposed parent must not be a descendant of the child.
    if (await this._isDescendant(parentId, childId, workspaceId)) {
      throw new ValidationError('That would create a loop — the chosen parent is already a descendant of this ticket');
    }

    // One parent per child: replace any existing parent link.
    const existing = await prisma.ticketLink.findFirst({ where: { workspaceId, relatedTicketId: childId, kind: 'parent_of' } });
    if (existing && existing.ticketId !== parentId) {
      await prisma.ticketLink.delete({ where: { id: existing.id } });
    }
    await prisma.ticketLink.upsert({
      where: { ticketId_relatedTicketId_kind: { ticketId: parentId, relatedTicketId: childId, kind: 'parent_of' } },
      update: {},
      create: { workspaceId, ticketId: parentId, relatedTicketId: childId, kind: 'parent_of', createdBy: actor?.email || null },
    });

    const who = actor?.name || actor?.email || 'an agent';
    await this._fsPointerNote(child, workspaceId, `Linked as a child of ${ticketDisplayRef(parent)} in Ticket Pulse by ${who}.`);
    await this._fsPointerNote(parent, workspaceId, `${ticketDisplayRef(child)} was linked as a child ticket in Ticket Pulse by ${who}.`);
    logger.info(`Parent/child: ${ticketDisplayRef(child)} is now a child of ${ticketDisplayRef(parent)}`);
    return this.family(childId, workspaceId);
  }

  /** Add `childTicketId` as a child of `parentId` (the inverse entry point of
   *  setParent — used from the parent's Children card). Returns the parent's
   *  family so the card can refresh. */
  async addChild(parentId, workspaceId, { childTicketId }, actor) {
    const childId = Number(childTicketId);
    if (!Number.isFinite(childId)) throw new ValidationError('Pick a valid child ticket');
    await this.setParent(childId, workspaceId, { parentTicketId: parentId }, actor);
    return this.family(parentId, workspaceId);
  }

  async removeParent(childId, workspaceId, actor) {
    const link = await prisma.ticketLink.findFirst({ where: { workspaceId, relatedTicketId: childId, kind: 'parent_of' } });
    if (!link) throw new NotFoundError('This ticket has no parent to remove');
    const [child, parent] = await Promise.all([
      prisma.ticket.findFirst({ where: { id: childId, workspaceId } }),
      prisma.ticket.findFirst({ where: { id: link.ticketId, workspaceId } }),
    ]);
    await prisma.ticketLink.delete({ where: { id: link.id } });
    const who = actor?.name || actor?.email || 'an agent';
    if (child && parent) {
      await this._fsPointerNote(child, workspaceId, `Unlinked from parent ${ticketDisplayRef(parent)} in Ticket Pulse by ${who}.`);
      await this._fsPointerNote(parent, workspaceId, `${ticketDisplayRef(child)} was unlinked as a child in Ticket Pulse by ${who}.`);
    }
    return { removed: true };
  }

  /** True if `candidateId` sits anywhere under `rootId` in the parent tree. */
  async _isDescendant(candidateId, rootId, workspaceId, seen = new Set()) {
    if (candidateId === rootId) return true;
    if (seen.has(candidateId)) return false;
    seen.add(candidateId);
    const parentLink = await prisma.ticketLink.findFirst({ where: { workspaceId, relatedTicketId: candidateId, kind: 'parent_of' }, select: { ticketId: true } });
    if (!parentLink) return false;
    return this._isDescendant(parentLink.ticketId, rootId, workspaceId, seen);
  }

  /** Drop a cosmetic note on a ticket's FreshService copy (both origins that
   *  have an FS id), so the relationship is visible in FreshService even though
   *  FS has no native parent/child field to write. Best-effort. */
  async _fsPointerNote(ticket, workspaceId, text) {
    if (!ticket?.freshserviceTicketId) return;
    try {
      const { default: mirrorService } = await import('./mirrorService.js');
      const client = await mirrorService.getInteractiveClient(workspaceId);
      if (client) await client.addPrivateNote(Number(ticket.freshserviceTicketId), text);
    } catch (err) {
      logger.warn(`Parent/child FS pointer note failed (non-fatal): ${err.message}`);
    }
  }
}

const ticketLinkService = new TicketLinkService();
export default ticketLinkService;
