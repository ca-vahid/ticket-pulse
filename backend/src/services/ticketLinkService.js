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
    if (!ticket || !related) throw new NotFoundError('Both tickets must exist in this workspace');

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
}

const ticketLinkService = new TicketLinkService();
export default ticketLinkService;
