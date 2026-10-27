import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import { ticketLinkUrl } from '../utils/ticketLink.js';
import { escapeHtml, descriptionHtmlForEmail, replyHint } from './approvalEmailTemplate.js';
import { resolvePublicBaseUrl } from '../utils/publicBaseUrl.js';

/**
 * Watcher notifications (T3.6). Watchers subscribe to a CATEGORY (top or sub)
 * or a GROUP — never a single ticket (decision d7) — and get emailed when a
 * ticket is created in, or gets a requester reply within, that scope.
 * Always non-fatal: ticket flows never block on watcher mail.
 *
 * 26 Oct 2026 (Vahid): the e-mail is the requester's message itself — their
 * words, one grey line saying why you got it with the link, and (for a reply)
 * the conversation so far — sent as "<requester> via Ticket Pulse" and
 * threaded under the ticket. It was a "[watching]" notice with a quote box.
 */

/** The watcher's e-mail body. `scopeName` is what they watch; `quoteHtml` the history (replies only). */
export function renderWatcherEmail({ eventKind, ref, appUrl, scopeName = null, requesterName = null, bodyHtml = '', quoteHtml = '' }) {
  const watch = scopeName ? `You watch ${escapeHtml(scopeName)}.` : 'You watch this category or group.';
  const what = eventKind === 'created'
    ? `${escapeHtml(String(requesterName || 'Someone').trim().split(/\s+/)[0])} opened ${escapeHtml(ref)}.`
    : `${escapeHtml(String(requesterName || 'The requester').trim().split(/\s+/)[0])} replied on ${escapeHtml(ref)}.`;
  const link = appUrl ? ` <a href="${escapeHtml(appUrl)}" target="_blank" style="color:#1d4ed8;text-decoration:none;font-weight:600;">Open the ticket&nbsp;&rarr;</a>` : '';
  const body = bodyHtml || '<p style="font-family:Calibri,\'Segoe UI\',Arial,sans-serif;font-size:14.5px;line-height:21px;color:#6b7280;margin:0;">(no message)</p>';
  return `<div style="font-family:Calibri,'Segoe UI',Arial,sans-serif;font-size:14.5px;line-height:21px;color:#111827;">${body}</div>`
    + replyHint(`${what} ${watch}${link}`)
    + (quoteHtml || '');
}

class WatcherNotificationService {
  /** eventKind: 'created' | 'requester_reply'. `entryId` (a reply) lets the e-mail carry the reply as written. */
  async notify(eventKind, ticketId, { entryPreview = null, entryId = null } = {}) {
    try {
      const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        select: {
          id: true, workspaceId: true, subject: true, origin: true,
          nativeNumber: true, freshserviceTicketId: true,
          internalCategoryId: true, internalSubcategoryId: true, groupId: true,
          description: true, descriptionText: true,
          internalCategory: { select: { name: true } },
          internalSubcategory: { select: { name: true } },
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
      const subject = eventKind === 'created'
        ? `[watching] New ticket ${ref}: ${ticket.subject || ''}`.slice(0, 250)
        : `[watching] Requester replied on ${ref}: ${ticket.subject || ''}`.slice(0, 250);
      const base = (process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || '').replace(/\/$/, '')
        || resolvePublicBaseUrl({ warn: () => {} });
      const appUrl = base ? ticketLinkUrl(base, ticket) : null;

      // What each watcher watches, named: the category, the sub-category or the group.
      let groupName = null;
      if (ticket.groupId && subs.some((s) => s.scopeType === 'group')) {
        groupName = await Promise.resolve()
          .then(() => prisma.group.findFirst({ where: { workspaceId: ticket.workspaceId, freshserviceId: ticket.groupId }, select: { name: true } }))
          .then((g) => g?.name || null)
          .catch(() => null);
      }
      const scopeNameOf = (sub) => {
        if (sub.scopeType === 'group') return groupName ? `the ${groupName} group` : null;
        if (sub.categoryId && sub.categoryId === ticket.internalSubcategoryId && ticket.internalSubcategory?.name) {
          return ticket.internalCategory?.name ? `${ticket.internalCategory.name} › ${ticket.internalSubcategory.name}` : ticket.internalSubcategory.name;
        }
        return ticket.internalCategory?.name || null;
      };
      const scopeFor = new Map();
      for (const s of subs) if (s.userEmail && !scopeFor.has(s.userEmail)) scopeFor.set(s.userEmail, scopeNameOf(s));

      // The message itself: the ticket's description for a new ticket; the
      // reply as written (pictures inline) and the history for a reply.
      let bodyHtml = '';
      let quoteHtml = '';
      let attachments = [];
      let entry = null;
      if (eventKind !== 'created' && entryId) {
        entry = await Promise.resolve()
          .then(() => prisma.ticketThreadEntry.findUnique({ where: { id: entryId }, select: { id: true, bodyHtml: true, bodyText: true, content: true, actorName: true, actorEmail: true, occurredAt: true } }))
          .catch(() => null);
      }
      try {
        const { createInlineBudget, inlinePictures, inlineAttachments } = await import('./replyEmailPictures.js');
        const budget = createInlineBudget();
        if (eventKind === 'created') {
          bodyHtml = descriptionHtmlForEmail(ticket.description || ticket.descriptionText || '').html;
          if (bodyHtml) bodyHtml = await inlinePictures(bodyHtml, { budget, ticketId: ticket.id, maxWidth: 600 });
        } else {
          const { stripQuotedHtml } = await import('../utils/replyQuoteStripper.js');
          const text = entry?.bodyText || entry?.content || entryPreview || '';
          bodyHtml = entry?.bodyHtml
            ? await inlinePictures(stripQuotedHtml(entry.bodyHtml) || entry.bodyHtml, { budget, ticketId: ticket.id, entryId: entry.id, at: entry.occurredAt || null, maxWidth: 600 })
            : String(text).trim().split(/\n{2,}/).filter(Boolean).map((p) => `<p style="margin:0 0 10px;">${escapeHtml(p).replace(/\r?\n/g, '<br>')}</p>`).join('');
          const { default: ticketService } = await import('./ticketService.js');
          const quote = await ticketService._lastInboundQuote(ticket.id, entry?.id ?? null, {
            reply: { text, authorName: entry?.actorName || ticket.requester?.name || null, authorEmail: entry?.actorEmail || requesterEmail },
            budget,
          });
          quoteHtml = quote?.html || '';
        }
        attachments = inlineAttachments(budget);
      } catch (err) {
        logger.debug(`Watcher e-mail body for ticket ${ticket.id} kept plain: ${err.message}`);
        if (!bodyHtml && entryPreview) bodyHtml = `<p>${escapeHtml(String(entryPreview).slice(0, 2000))}</p>`;
      }

      // The requester's name on it, like the agent copy of a reply; the
      // workspace identity when there is no requester name.
      const requesterName = entry?.actorName || ticket.requester?.name || null;
      let fromName = requesterName ? `${requesterName} via Ticket Pulse` : null;
      if (!fromName) {
        const { resolveFromName } = await import('./workspaceEmailIdentityService.js');
        fromName = await resolveFromName(ticket.workspaceId);
      }

      const { sendTransactionalEmail } = await import('./transactionalEmailService.js');
      let sent = 0;
      for (const to of recipients) {
        const html = renderWatcherEmail({ eventKind, ref, appUrl, scopeName: scopeFor.get(to) || null, requesterName, bodyHtml, quoteHtml });
        const res = await sendTransactionalEmail({ workspaceId: ticket.workspaceId, to: [to], subject, html, attachments, fromName, label: 'watcher', ticket });
        if (res?.sent !== false) sent += 1;
      }
      logger.info(`Watcher notification (${eventKind}) sent for ticket ${ticket.id} to ${sent} watcher(s)`);
      return { sent };
    } catch (err) {
      logger.warn(`Watcher notification failed for ticket ${ticketId} (non-fatal): ${err.message}`);
      return { sent: 0, error: err.message };
    }
  }
}

export default new WatcherNotificationService();
