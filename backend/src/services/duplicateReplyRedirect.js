/**
 * A requester reply that lands on a ticket closed as a duplicate (or merged
 * into another) belongs on the ticket that survived (19 Oct 2026, Vahid: "YES"
 * after #247899 was reopened unassigned while TP-10198 held the work).
 *
 * Every reply path (mail ingest, the FreshService copy pull-back, the FS-born
 * thread sync) raises ticket.reply_received, so emitTicketEvent asks here
 * first. When the ticket is Resolved/Closed and carries a duplicate_of or
 * merged_into link, the reply is copied onto the surviving ticket as a private
 * note (agents see it; nothing is e-mailed), both tickets get an Activity row,
 * and the caller re-raises the reply on the survivor instead of reopening the
 * duplicate. An open duplicate is left alone: someone chose to keep it.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';

const LINK_KINDS = ['duplicate_of', 'merged_into'];
const TERMINAL_BASES = new Set(['Resolved', 'Closed']);
export const MAX_REDIRECT_HOPS = 3;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function survivorOf(ticket) {
  const link = await prisma.ticketLink.findFirst({
    where: { ticketId: ticket.id, kind: { in: LINK_KINDS } },
    select: { relatedTicketId: true, kind: true },
    orderBy: { id: 'desc' },
  });
  if (!link?.relatedTicketId || link.relatedTicketId === ticket.id) return null;
  const target = await prisma.ticket.findUnique({
    where: { id: link.relatedTicketId },
    select: { id: true, workspaceId: true, origin: true, nativeNumber: true, freshserviceTicketId: true, subject: true },
  });
  if (!target || target.workspaceId !== ticket.workspaceId) return null;
  return { target, kind: link.kind };
}

async function findReplyEntry(ticket, extra) {
  if (extra?.entryId) {
    return prisma.ticketThreadEntry.findFirst({ where: { id: Number(extra.entryId), ticketId: ticket.id } });
  }
  if (extra?.externalEntryId) {
    return prisma.ticketThreadEntry.findFirst({ where: { ticketId: ticket.id, externalEntryId: String(extra.externalEntryId) } });
  }
  return null;
}

/**
 * @returns {Promise<null | { targetId: number, hops: number, extra: object, dedupeStamp: string }>}
 *   null = handle the reply on this ticket as usual.
 */
export async function redirectReplyOnClosedDuplicate(ticket, { statusBase, extra = null, dedupeStamp = null } = {}) {
  if (!ticket?.id || !TERMINAL_BASES.has(statusBase)) return null;
  const hops = Number(extra?.redirectHops || 0);
  if (hops >= MAX_REDIRECT_HOPS) return null;
  try {
    const found = await survivorOf(ticket);
    if (!found) return null;
    const { target, kind } = found;
    const fromRef = ticketDisplayRef(ticket);
    const toRef = ticketDisplayRef(target);
    const entry = await findReplyEntry(ticket, extra).catch(() => null);
    const who = entry?.actorName || extra?.fromName || extra?.fromEmail || extra?.from || ticket.requester?.name || 'The requester';
    const bodyText = String(entry?.bodyText || entry?.content || '').trim();
    const intro = `${who} replied on ${fromRef}, which was closed as ${kind === 'merged_into' ? 'merged into' : 'a duplicate of'} this ticket. The reply is below; it was not reopened there.`;
    const bodyHtml = `<p>${esc(intro)}</p>${entry?.bodyHtml ? `<blockquote>${entry.bodyHtml}</blockquote>` : (bodyText ? `<blockquote>${esc(bodyText).replace(/\n/g, '<br/>')}</blockquote>` : '')}`;
    const stamp = String(dedupeStamp || extra?.externalEntryId || extra?.entryId || Date.now());

    let note = null;
    try {
      note = await prisma.ticketThreadEntry.create({
        data: {
          ticketId: target.id,
          workspaceId: target.workspaceId,
          externalEntryId: `dupreply:${ticket.id}:${stamp}`.slice(0, 191),
          source: 'ticketpulse_native',
          eventType: 'note',
          actorName: 'Ticket Pulse',
          authorType: 'system',
          incoming: false,
          isPrivate: true,
          visibility: 'private',
          bodyHtml,
          bodyText: `${intro}${bodyText ? `\n\n${bodyText}` : ''}`,
          content: `${intro}${bodyText ? `\n\n${bodyText}` : ''}`,
          occurredAt: entry?.occurredAt || new Date(),
          rawPayload: { redirectedReply: { fromTicketId: ticket.id, fromRef, kind, entryId: entry?.id || null } },
        },
      });
    } catch (err) {
      // P2002 = this reply was already forwarded (the same event arrived twice).
      if (err?.code !== 'P2002') throw err;
      return { targetId: target.id, hops: hops + 1, duplicateEvent: true, extra: {}, dedupeStamp: `${stamp}:via:${ticket.id}` };
    }

    const { default: ticketActivityRepository } = await import('./ticketActivityRepository.js');
    await Promise.all([
      ticketActivityRepository.create({
        ticketId: ticket.id, activityType: 'reply_redirected', performedBy: 'Ticket Pulse',
        details: { toTicketId: target.id, toRef, kind, note: `Reply forwarded to ${toRef}; this ${kind === 'merged_into' ? 'merged' : 'duplicate'} ticket stays closed.` },
      }).catch(() => null),
      ticketActivityRepository.create({
        ticketId: target.id, activityType: 'reply_redirected', performedBy: 'Ticket Pulse',
        details: { fromTicketId: ticket.id, fromRef, kind, entryId: note.id, note: `Reply on ${fromRef} added here as a note.` },
      }).catch(() => null),
    ]);
    if (target.origin === 'ticketpulse') {
      import('./mirrorService.js')
        .then(({ default: mirrorService }) => mirrorService.enqueueThreadEntry(target.workspaceId, target.id, note.id))
        .catch(() => {});
    }
    logger.info(`Reply on ${fromRef} (closed ${kind}) forwarded to ${toRef} as note ${note.id}`);
    return {
      targetId: target.id,
      hops: hops + 1,
      dedupeStamp: `${stamp}:via:${ticket.id}`,
      // entryId is dropped: the note is ours, not the requester's message.
      extra: { ...(extra || {}), entryId: undefined, redirectedFrom: ticket.id, redirectedNoteId: note.id, redirectHops: hops + 1 },
    };
  } catch (error) {
    logger.warn(`Duplicate reply redirect skipped for ticket ${ticket.id}: ${error.message}`);
    return null;
  }
}

export default { redirectReplyOnClosedDuplicate };
