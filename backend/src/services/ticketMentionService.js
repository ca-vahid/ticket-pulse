import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import { ticketLinkUrl } from '../utils/ticketLink.js';
import { escapeHtml, replyHint } from './approvalEmailTemplate.js';
import { resolvePublicBaseUrl } from '../utils/publicBaseUrl.js';

/**
 * @mentions in internal notes (29 Oct 2026, Vahid): an agent types @ in a note,
 * picks a colleague, and that colleague is told — by e-mail, and in Teams when
 * they already have a chat with the bot. Workspace agents only. A note is never
 * blocked by this: every step here is non-fatal.
 *
 * Mentions are kept in ticket_mentions (who, on which note, by whom, seen when),
 * which feeds the "You were mentioned" line on the ticket and the Mentions view.
 */

/** Two e-mails to one person about one ticket within this window become one. */
export const MENTION_EMAIL_COALESCE_MS = 5 * 60 * 1000;
const MAX_MENTIONS_PER_NOTE = 10;

/** The ids the composer sent: an array, a JSON array or a comma list (multipart). */
export function parseMentionIds(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return [];
    try { list = text.startsWith('[') ? JSON.parse(text) : text.split(','); } catch { list = text.split(','); }
  }
  if (!Array.isArray(list)) list = raw === null || raw === undefined ? [] : [raw];
  const ids = [];
  for (const value of list) {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0 && !ids.includes(n)) ids.push(n);
  }
  return ids.slice(0, MAX_MENTIONS_PER_NOTE);
}

/** Whether "@<name>" (or "@<first name>") is still in the note the agent sent. */
export function noteNamesPerson(bodyText, name) {
  const text = String(bodyText || '').toLowerCase().replace(/\s+/g, ' ');
  const full = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!full) return false;
  const first = full.split(' ')[0];
  return text.includes(`@${full}`) || (first.length >= 2 && text.includes(`@${first}`));
}

/** The e-mail body: the note as written, then one grey line saying why. */
export function renderMentionEmail({ authorName, ref, subject, appUrl, bodyHtml }) {
  const first = escapeHtml(String(authorName || 'A colleague').trim().split(/\s+/)[0]);
  const link = appUrl ? ` <a href="${escapeHtml(appUrl)}" target="_blank" style="color:#1d4ed8;text-decoration:none;font-weight:600;">Open the ticket&nbsp;&rarr;</a>` : '';
  const about = subject ? ` (${escapeHtml(String(subject).slice(0, 160))})` : '';
  const body = bodyHtml || '<p style="font-family:Calibri,\'Segoe UI\',Arial,sans-serif;font-size:14.5px;line-height:21px;color:#6b7280;margin:0;">(no message)</p>';
  return `<div style="font-family:Calibri,'Segoe UI',Arial,sans-serif;font-size:14.5px;line-height:21px;color:#111827;">${body}</div>`
    + replyHint(`${first} mentioned you in an internal note on ${escapeHtml(ref)}${about}. Only agents can see it.${link}`);
}

function plainParagraphs(text) {
  return String(text || '').trim().split(/\n{2,}/).filter(Boolean)
    .map((p) => `<p style="margin:0 0 10px;">${escapeHtml(p).replace(/\r?\n/g, '<br>')}</p>`).join('');
}

class TicketMentionService {
  /**
   * Record the mentions on a note just written and tell the people named.
   * `ids` come from the composer; only active agents of the ticket's workspace,
   * other than the author, whose name is still in the note, are kept.
   * Returns the technician ids recorded. Never throws.
   */
  async recordForNote({ ticket, entry, actor, ids, bodyText, bodyHtml = null }) {
    try {
      const wanted = parseMentionIds(ids).filter((id) => id !== actor?.technicianId);
      if (!wanted.length || !ticket?.id || !entry?.id) return [];
      const people = await prisma.technician.findMany({
        where: { id: { in: wanted }, workspaceId: ticket.workspaceId, isActive: true },
        select: { id: true, name: true, email: true },
      });
      const actorEmail = String(actor?.email || '').toLowerCase();
      const named = people.filter((p) => noteNamesPerson(bodyText, p.name)
        && String(p.email || '').toLowerCase() !== actorEmail);
      if (!named.length) return [];

      const since = new Date(Date.now() - MENTION_EMAIL_COALESCE_MS);
      const recent = await prisma.ticketMention.findMany({
        where: { ticketId: ticket.id, technicianId: { in: named.map((p) => p.id) }, notifiedAt: { gte: since } },
        select: { technicianId: true },
      }).catch(() => []);
      const recentlyTold = new Set((recent || []).map((r) => r.technicianId));

      const rows = [];
      for (const person of named) {
        const row = await prisma.ticketMention.create({
          data: {
            workspaceId: ticket.workspaceId,
            ticketId: ticket.id,
            threadEntryId: entry.id,
            technicianId: person.id,
            mentionedByTechnicianId: actor?.technicianId || null,
            mentionedByName: String(actor?.name || actor?.email || 'Ticket Pulse').slice(0, 255),
          },
        });
        rows.push({ row, person });
      }
      // Telling people happens after the note is saved and never holds it up.
      const toTell = rows.filter(({ person }) => !recentlyTold.has(person.id));
      if (toTell.length) {
        this._notify({ ticket, entry, actor, bodyText, bodyHtml, rows: toTell })
          .catch((err) => logger.warn(`Mention notifications for ticket ${ticket.id} failed (non-fatal): ${err.message}`));
      }
      logger.info(`Ticket ${ticket.id}: note ${entry.id} mentions ${rows.length} agent(s)${toTell.length < rows.length ? ` (${rows.length - toTell.length} told a moment ago)` : ''}`);
      return rows.map(({ person }) => person.id);
    } catch (err) {
      logger.warn(`Mentions not recorded for ticket ${ticket?.id} (non-fatal): ${err.message}`);
      return [];
    }
  }

  async _notify({ ticket, entry, actor, bodyText, bodyHtml, rows }) {
    const ref = ticketDisplayRef(ticket);
    const base = (process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || '').replace(/\/$/, '')
      || resolvePublicBaseUrl({ warn: () => {} });
    const appUrl = base ? ticketLinkUrl(base, ticket) : null;
    const authorName = actor?.name || actor?.email || 'A colleague';
    const authorFirst = String(authorName).trim().split(/\s+/)[0];

    let html = '';
    let attachments = [];
    try {
      const { createInlineBudget, inlinePictures, inlineAttachments } = await import('./replyEmailPictures.js');
      const budget = createInlineBudget();
      html = bodyHtml
        ? await inlinePictures(bodyHtml, { budget, ticketId: ticket.id, entryId: entry.id, at: entry.occurredAt || null, maxWidth: 600 })
        : plainParagraphs(bodyText);
      attachments = inlineAttachments(budget);
    } catch (err) {
      logger.debug(`Mention e-mail body for ticket ${ticket.id} kept plain: ${err.message}`);
      html = plainParagraphs(bodyText);
    }

    const subject = `${authorFirst} mentioned you on ${ref}: ${ticket.subject || ''}`.trim().slice(0, 250);
    const { sendTransactionalEmail } = await import('./transactionalEmailService.js');
    const { default: teams } = await import('./teamsNotificationService.js');
    const snippet = String(bodyText || '').replace(/\s+/g, ' ').trim().slice(0, 240);

    for (const { row, person } of rows) {
      const channels = [];
      if (person.email) {
        const res = await sendTransactionalEmail({
          workspaceId: ticket.workspaceId,
          to: [person.email],
          subject,
          html: renderMentionEmail({ authorName, ref, subject: ticket.subject, appUrl, bodyHtml: html }),
          attachments,
          fromName: `${authorName} via Ticket Pulse`,
          label: 'mention',
          ticket,
        }).catch((err) => ({ sent: false, error: err.message }));
        if (res?.sent !== false) channels.push('email');
      }
      const teamsRes = await teams.sendAgentAlert({
        workspaceId: ticket.workspaceId,
        technician: person,
        title: `${authorFirst} mentioned you on ${ref}`,
        lines: [appUrl ? `[${ref}: ${String(ticket.subject || '').slice(0, 120)}](${appUrl})` : `${ref}: ${String(ticket.subject || '').slice(0, 120)}`, snippet].filter(Boolean),
        url: appUrl,
      }).catch(() => ({ sent: false }));
      if (teamsRes?.sent) channels.push('teams');
      await prisma.ticketMention.update({
        where: { id: row.id },
        data: { notifiedAt: new Date(), notifiedVia: channels.join(',') || 'none' },
      }).catch(() => {});
    }
  }

  /**
   * The mentions of this person on this ticket nobody has seen yet, marked seen
   * now (they are looking at the ticket). Never throws.
   */
  async takeUnseen(ticketId, workspaceId, technicianId) {
    if (!technicianId) return [];
    try {
      const rows = await prisma.ticketMention.findMany({
        where: { ticketId, workspaceId, technicianId, seenAt: null },
        orderBy: { createdAt: 'asc' },
        take: 20,
        select: { id: true, threadEntryId: true, mentionedByName: true, createdAt: true },
      });
      if (!rows.length) return [];
      await prisma.ticketMention.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { seenAt: new Date() } });
      return rows.map((r) => ({ entryId: r.threadEntryId, by: r.mentionedByName, at: r.createdAt }));
    } catch (err) {
      logger.debug?.(`Mention lookup skipped for ticket ${ticketId}: ${err.message}`);
      return [];
    }
  }

  /** How many tickets have a mention of this person not yet seen. Never throws. */
  async unseenTicketCount(workspaceId, technicianId) {
    if (!technicianId) return 0;
    try {
      const rows = await prisma.ticketMention.findMany({
        where: { workspaceId, technicianId, seenAt: null },
        distinct: ['ticketId'],
        select: { ticketId: true },
        take: 500,
      });
      return rows.length;
    } catch {
      return 0;
    }
  }
}

export default new TicketMentionService();
