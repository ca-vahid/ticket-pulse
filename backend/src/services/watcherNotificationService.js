import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import { pickOutboundMailbox } from './mailboxPicker.js';

/**
 * Watcher notifications (T3.6). Watchers subscribe to a CATEGORY (top or sub)
 * or a GROUP — never a single ticket (decision d7) — and get emailed when a
 * ticket is created in, or gets a requester reply within, that scope.
 * Always non-fatal: ticket flows never block on watcher mail.
 */
class WatcherNotificationService {
  /** eventKind: 'created' | 'requester_reply' */
  async notify(eventKind, ticketId, { entryPreview = null } = {}) {
    try {
      const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        select: {
          id: true, workspaceId: true, subject: true, origin: true,
          nativeNumber: true, freshserviceTicketId: true,
          internalCategoryId: true, internalSubcategoryId: true, groupId: true,
          requester: { select: { name: true, email: true } },
        },
      });
      if (!ticket) return { sent: 0 };

      const scopeOr = [];
      const catIds = [ticket.internalCategoryId, ticket.internalSubcategoryId].filter(Boolean);
      if (catIds.length) scopeOr.push({ scopeType: 'category', categoryId: { in: catIds } });
      if (ticket.groupId) scopeOr.push({ scopeType: 'group', groupId: ticket.groupId });
      if (!scopeOr.length) return { sent: 0 };

      const subs = await prisma.ticketWatchSubscription.findMany({
        where: {
          workspaceId: ticket.workspaceId,
          OR: scopeOr,
          ...(eventKind === 'created' ? { notifyCreated: true } : { notifyRequesterReply: true }),
        },
      });
      const requesterEmail = ticket.requester?.email?.toLowerCase() || null;
      const recipients = [...new Set(subs.map((s) => s.userEmail))]
        .filter((email) => email && email !== requesterEmail);
      if (!recipients.length) return { sent: 0 };

      const ref = ticketDisplayRef(ticket);
      const esc = (s) => String(s || '').replace(/</g, '&lt;');
      const subject = eventKind === 'created'
        ? `[watching] New ticket ${ref}: ${ticket.subject || ''}`.slice(0, 250)
        : `[watching] Requester replied on ${ref}: ${ticket.subject || ''}`.slice(0, 250);
      const appUrl = (process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || '').replace(/\/$/, '');
      const html = [
        `<p>${eventKind === 'created'
          ? 'A new ticket landed in a category/group you watch.'
          : 'The requester replied on a ticket in a category/group you watch.'}</p>`,
        `<p><b>${esc(ticket.subject || '(no subject)')}</b> (${ref})</p>`,
        ticket.requester?.name ? `<p>Requester: ${esc(ticket.requester.name)}</p>` : '',
        entryPreview ? `<blockquote>${esc(String(entryPreview).slice(0, 800))}</blockquote>` : '',
        appUrl ? `<p><a href="${appUrl}/tickets/${ticket.id}">Open in Ticket Pulse</a></p>` : '',
        '<p style="color:#64748b;font-size:12px">You get this because you watch this category or group in Ticket Pulse.</p>',
      ].join('');

      // Centralized outbound picker (MB-1g): primary first, then oldest.
      const connection = await pickOutboundMailbox(ticket.workspaceId);
      // Workspace sender identity (Phase EB): guaranteed on SendGrid,
      // best-effort on Graph (Exchange rewrites to the mailbox name).
      const { resolveFromName } = await import('./workspaceEmailIdentityService.js');
      const fromName = await resolveFromName(ticket.workspaceId);
      const { default: graphMailClient } = await import('../integrations/graphMailClient.js');
      if (connection && graphMailClient.isConfigured()) {
        await graphMailClient.sendMailAsMailbox(connection.address, {
          to: recipients, subject, html, fromName,
        });
      } else {
        const { default: sendgrid } = await import('./sendgridNotificationService.js');
        await sendgrid.sendEmail({
          to: recipients, subject, html, fromName,
        });
      }
      logger.info(`Watcher notification (${eventKind}) sent for ticket ${ticket.id} to ${recipients.length} watcher(s)`);
      return { sent: recipients.length };
    } catch (err) {
      logger.warn(`Watcher notification failed for ticket ${ticketId} (non-fatal): ${err.message}`);
      return { sent: 0, error: err.message };
    }
  }
}

export default new WatcherNotificationService();
