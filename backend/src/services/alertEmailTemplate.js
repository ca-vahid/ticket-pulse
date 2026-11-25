/**
 * The ticket alert e-mail (QA 11-24 item 9): the priority, assignment and
 * after-hours alerts an agent gets about ONE ticket, in the same branded
 * layout the urgent-response notices use (emailShell: the Ticket Pulse band,
 * a white card, one blue button, a muted footer). Until now these went out as
 * the bare one-line text of the SMS, wrapped in a <p> by the transport.
 *
 * Pure: no database, no network. The caller (notificationDeliveryService)
 * hands in what the delivery and its ticket know. Outlook-safe: the button
 * cell carries bgcolor + background-color and an explicit text colour.
 */
import { emailShell, escapeHtml } from './approvalEmailTemplate.js';

const INK = '#0f172a';
const MUTED = '#64748b';
const BLUE = '#2563eb';
const FONT = '-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif';

/** Alert kinds by delivery notificationType. */
const KIND_BY_TYPE = Object.freeze({
  freshservice_priority_change: 'priority',
  ticketpulse_priority_change: 'priority',
  ticket_pulse_assignment: 'assignment',
  freshservice_assignment_change: 'assignment',
  after_hours_urgent_escalation: 'escalation',
  urgent_self_escalation: 'escalation',
  ticket_pulse_public_priority_raise_supervisor: 'escalation',
});

export function alertKindOf(notificationType) {
  return KIND_BY_TYPE[String(notificationType || '')] || 'ticket';
}

/** The heading: "TP-1042 is now Urgent priority". */
export function alertHeading({ kind, ref, priority }) {
  const name = ref || 'A ticket';
  const level = priority ? `${priority} priority` : null;
  if (kind === 'priority') return level ? `${name} is now ${level}` : `${name} changed priority`;
  if (kind === 'assignment') return `${name} is assigned to you`;
  if (kind === 'escalation') return `${name} needs attention now`;
  return level ? `${level} ticket ${name}` : `Ticket ${name}`;
}

/**
 * @param {object} p
 * @param {string|null} p.workspaceName
 * @param {string} p.kind          alertKindOf(notificationType)
 * @param {string|null} p.ref      "TP-1042" / "#250001"
 * @param {string|null} p.priority "Urgent"
 * @param {string|null} p.subject  the ticket subject
 * @param {string|null} p.message  the alert's own sentence (the SMS text)
 * @param {string|null} p.reason   why this person got it ("You are the assignee, …")
 * @param {string|null} p.link     the ticket in Ticket Pulse
 * @returns {{ html: string, text: string }}
 */
export function renderTicketAlertEmail({
  workspaceName = null, kind = 'ticket', ref = null, priority = null, subject = null, message = null, reason = null, link = null,
} = {}) {
  const heading = alertHeading({ kind, ref, priority });
  const cleanSubject = String(subject || '').replace(/\s+/g, ' ').trim();
  const lines = [];
  if (cleanSubject) lines.push(`<tr><td style="padding:0 0 10px;font-family:${FONT};font-size:15px;line-height:22px;color:${INK};">${escapeHtml(cleanSubject)}</td></tr>`);
  if (kind === 'assignment' && priority) {
    lines.push(`<tr><td style="padding:0 0 10px;font-family:${FONT};font-size:14px;line-height:21px;color:${INK};">Priority: <strong>${escapeHtml(priority)}</strong></td></tr>`);
  }
  if (kind === 'escalation' && message) {
    lines.push(`<tr><td style="padding:0 0 10px;font-family:${FONT};font-size:14px;line-height:21px;color:${INK};">${escapeHtml(message)}</td></tr>`);
  }
  if (reason) {
    lines.push(`<tr><td style="padding:0 0 12px;font-family:${FONT};font-size:13px;line-height:19px;color:${MUTED};">${escapeHtml(reason)}</td></tr>`);
  }
  const bodyRows = [
    `<tr><td style="padding:0 0 12px;font-family:${FONT};font-size:18px;line-height:24px;font-weight:bold;color:${INK};">${escapeHtml(heading)}</td></tr>`,
    ...lines,
  ];
  if (link) {
    bodyRows.push([
      '<tr><td style="padding:8px 0 18px;">',
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>',
      `<td bgcolor="${BLUE}" style="background-color:${BLUE};border-radius:8px;">`,
      `<a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;font-family:${FONT};font-size:14px;line-height:18px;font-weight:bold;color:#ffffff;text-decoration:none;">${escapeHtml(ref ? `Open ${ref}` : 'Open the ticket')}</a>`,
      '</td></tr></table>',
      '</td></tr>',
    ].join(''));
  }
  const html = emailShell({
    workspaceName,
    bodyRows,
    footerHtml: `<span style="color:${MUTED};">Sent by Ticket Pulse alerts. Change which alerts you get under My alerts in Ticket Pulse.</span>`,
    preheader: cleanSubject ? `${heading}: ${cleanSubject}` : heading,
  });
  const text = [
    heading,
    cleanSubject || null,
    kind === 'escalation' && message ? message : null,
    reason || null,
    link ? `Open: ${link}` : null,
  ].filter(Boolean).join('\n\n');
  return { html, text };
}

export default { renderTicketAlertEmail, alertKindOf, alertHeading };
