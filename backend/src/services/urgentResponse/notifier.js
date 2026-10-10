import prisma from '../prisma.js';
import logger from '../../utils/logger.js';
import { resolvePublicBaseUrl } from '../../utils/publicBaseUrl.js';
import { ticketDisplayRef } from '../../utils/ticketOrigin.js';

/**
 * Urgent response — notices (plans/URGENT_RESPONSE_PLAN.md).
 *
 * Two ways of reaching a technician: tellPeople() (Teams and/or e-mail, the
 * channels the workspace chose) and textOnCall() (one SMS to the on-call
 * person's verified phone). The requester is never told anything from here.
 *
 * Nothing in this file throws: a notice that cannot be sent is reported in
 * the summary and logged, and the action that asked for it carries on.
 * Teams, mail and Twilio are imported lazily (they pull in half the app).
 */

const INK = '#0f172a';
const MUTED = '#64748b';
const BLUE = '#2563eb';
const FONT = '-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif';
const MAX_PEOPLE = 100;
const CHANNELS = Object.freeze(['teams', 'email']);

const listOf = (v) => (Array.isArray(v) ? v : []);
const clean = (v) => String(v ?? '').trim();

class UrgentResponseNotifier {
  /** The people to tell: technicians of the workspace with an address, who can still own tickets. Never the photo. */
  async _people(workspaceId, technicianIds) {
    const ids = [...new Set(listOf(technicianIds).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, MAX_PEOPLE);
    if (!ids.length) return [];
    const rows = await prisma.technician.findMany({
      where: { workspaceId: Number(workspaceId), id: { in: ids } },
      select: { id: true, name: true, email: true, isActive: true, assignableOnly: true },
      take: ids.length,
    });
    return rows.filter((r) => clean(r.email) && (r.isActive || r.assignableOnly));
  }

  /** A path ('/on-call?request=12') or the ticket → an absolute link on the public address. */
  _link({ ticket, link }) {
    const base = resolvePublicBaseUrl({ warn: (m) => logger.warn(m) });
    if (ticket?.id) return { url: `${base}/tickets/${ticket.id}`, label: `Open ${ticketDisplayRef(ticket)}` };
    const path = clean(link);
    if (!path) return null;
    return { url: /^https?:\/\//i.test(path) ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`, label: 'Open Ticket Pulse' };
  }

  /** The e-mail body. Coloured cells are bgcolor + background-color with an explicit text colour (Outlook drops gradients). */
  async _emailHtml({ workspaceName, title, lines, target }) {
    const { emailShell, escapeHtml } = await import('../approvalEmailTemplate.js');
    const bodyRows = [
      `<tr><td style="padding:0 0 12px;font-family:${FONT};font-size:18px;line-height:24px;font-weight:bold;color:${INK};">${escapeHtml(title)}</td></tr>`,
      ...lines.map((line) => `<tr><td style="padding:0 0 10px;font-family:${FONT};font-size:14px;line-height:21px;color:${INK};">${escapeHtml(line)}</td></tr>`),
    ];
    if (target) {
      bodyRows.push([
        '<tr><td style="padding:8px 0 18px;">',
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>',
        `<td bgcolor="${BLUE}" style="background-color:${BLUE};border-radius:8px;">`,
        `<a href="${escapeHtml(target.url)}" style="display:inline-block;padding:10px 18px;font-family:${FONT};font-size:14px;line-height:18px;font-weight:bold;color:#ffffff;text-decoration:none;">${escapeHtml(target.label)}</a>`,
        '</td></tr></table>',
        '</td></tr>',
      ].join(''));
    }
    return emailShell({
      workspaceName,
      bodyRows,
      footerHtml: `<span style="color:${MUTED};">Sent by the Urgent response rule in Ticket Pulse. The requester was not told.</span>`,
      preheader: lines[0] || title,
    });
  }

  /**
   * Tell technicians by Teams and/or e-mail.
   * @param {{ workspaceId: number, technicianIds: number[], title: string, lines: string[], ticket?: object|null,
   *   refKey?: string|null, channels?: string[], link?: string|null }} input
   *   `ticket` (id + what ticketDisplayRef reads) adds the ticket link; without a ticket, `link` is a PATH on the app.
   * @returns {{ people: number, teams: object|null, email: object|null }} never throws.
   */
  async tellPeople({ workspaceId, technicianIds, title, lines = [], ticket = null, refKey = null, channels = CHANNELS, link = null } = {}) {
    const out = { people: 0, teams: null, email: null };
    try {
      const wanted = listOf(channels).filter((c) => CHANNELS.includes(c));
      const text = listOf(lines).map(clean).filter(Boolean);
      const heading = clean(title) || 'Ticket Pulse';
      const people = await this._people(workspaceId, technicianIds);
      out.people = people.length;
      if (!people.length || !wanted.length) return out;
      const target = this._link({ ticket, link });

      if (wanted.includes('teams')) {
        out.teams = await this._teams({ workspaceId, people, heading, text, ticket, target, refKey });
      }
      if (wanted.includes('email')) {
        out.email = await this._email({ workspaceId, people, heading, text, target });
      }
    } catch (err) {
      logger.warn(`Urgent response: notice not sent (${refKey || 'no key'}): ${err.message}`);
    }
    return out;
  }

  async _teams({ workspaceId, people, heading, text, ticket, target, refKey }) {
    try {
      const { default: teams } = await import('../teamsNotificationService.js');
      // A ticket gets the card's own "Open" button; any other link rides in the text.
      const body = [...text, ...(!ticket?.id && target ? [target.url] : [])].join('\n\n');
      const result = await teams.sendWorkflowMessage({
        workspaceId: Number(workspaceId),
        emails: people.map((p) => p.email),
        title: heading,
        body,
        ticketId: ticket?.id || null,
        ticketRef: ticket?.id ? ticketDisplayRef(ticket) : null,
        includeTicketLink: Boolean(ticket?.id),
        refKey,
      });
      return {
        sent: result?.sent || 0, skipped: result?.skipped || 0, failed: result?.failed || 0, off: result?.off || null,
      };
    } catch (err) {
      logger.warn(`Urgent response: Teams notice failed: ${err.message}`);
      return { sent: 0, skipped: 0, failed: people.length, off: null };
    }
  }

  /** One mail per person, one after the other (nobody sees who else was told). */
  async _email({ workspaceId, people, heading, text, target }) {
    const out = { sent: 0, failed: 0 };
    try {
      const { sendTransactionalEmail } = await import('../transactionalEmailService.js');
      const ws = await prisma.workspace.findUnique({ where: { id: Number(workspaceId) }, select: { name: true } }).catch(() => null);
      const html = await this._emailHtml({ workspaceName: ws?.name || null, title: heading, lines: text, target });
      const plain = [heading, '', ...text, ...(target ? ['', `${target.label}: ${target.url}`] : [])].join('\n');
      for (const person of people) {
        const result = await sendTransactionalEmail({
          workspaceId: Number(workspaceId), to: person.email, subject: heading, html, text: plain, label: 'urgent response notice',
        });
        if (result?.sent) out.sent += 1;
        else out.failed += 1;
      }
    } catch (err) {
      logger.warn(`Urgent response: e-mail notice failed: ${err.message}`);
      out.failed = people.length - out.sent;
    }
    return out;
  }

  /**
   * One SMS to the on-call person's verified phone.
   * @returns {{ sent: boolean, reason?: 'no_technician'|'no_verified_phone'|'send_failed', error?: string }} never throws.
   */
  async textOnCall(technician, body) {
    try {
      const technicianId = Number(technician?.id);
      if (!Number.isInteger(technicianId) || technicianId <= 0) return { sent: false, reason: 'no_technician' };
      const pref = await prisma.technicianNotificationPreference.findUnique({
        where: { technicianId },
        select: { phoneOverride: true, entraMobilePhone: true, entraPhone: true, phoneVerifiedAt: true },
      });
      const phone = clean(pref?.phoneOverride) || clean(pref?.entraMobilePhone) || clean(pref?.entraPhone);
      if (!pref?.phoneVerifiedAt || !phone) {
        logger.info(`Urgent response: no verified phone to text for technician ${technicianId}`);
        return { sent: false, reason: 'no_verified_phone' };
      }
      const { sendSms } = await import('../twilioNotificationService.js');
      await sendSms({ to: phone, body: clean(body).slice(0, 600) });
      return { sent: true };
    } catch (err) {
      logger.warn(`Urgent response: text to the on-call person failed: ${err.message}`);
      return { sent: false, reason: 'send_failed', error: err.message };
    }
  }
}

const urgentResponseNotifier = new UrgentResponseNotifier();
export default urgentResponseNotifier;
export { UrgentResponseNotifier };
