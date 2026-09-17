/**
 * "E-mail agents a copy of requester replies" (17 Sep 2026).
 *
 * When replies left FreshService from the it@ group mailbox, every agent saw
 * the requester's answer in their own inbox. Replies from Ticket Pulse come
 * back to the workspace mailbox, which only Ticket Pulse reads — so with this
 * on, each requester reply that lands on a ticket is also e-mailed to the
 * assigned agent (else the agent who last replied) and to an optional extra
 * address (a team inbox), with the ticket link and a Reply-To that threads an
 * Outlook answer back onto the ticket.
 *
 * Storage: `app_settings` keys `requester_reply_copy_ws<N>` ('1'|'0', default
 * off) and `requester_reply_copy_extra_ws<N>` (comma-separated addresses).
 * Cached briefly; fail closed.
 */
import prisma from './prisma.js';
import settingsRepository from './settingsRepository.js';
import logger from '../utils/logger.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import { emailShell, escapeHtml, textExcerpt } from './approvalEmailTemplate.js';
import { brandImg } from './emailBrandAssets.js';

const CACHE_TTL_MS = 30 * 1000;
const cache = new Map(); // workspaceId -> { at, value }
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function requesterReplyCopyKey(workspaceId) { return `requester_reply_copy_ws${Number(workspaceId) || 0}`; }
export function requesterReplyCopyExtraKey(workspaceId) { return `requester_reply_copy_extra_ws${Number(workspaceId) || 0}`; }

function parseFlag(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

export function parseAddressList(value) {
  return [...new Set(String(value || '').split(/[,;\s]+/).map((a) => a.trim().toLowerCase()).filter((a) => EMAIL_RE.test(a)))].slice(0, 10);
}

export async function getRequesterReplyCopySettings(workspaceId) {
  const id = Number(workspaceId);
  if (!Number.isFinite(id) || id <= 0) return { enabled: false, extra: [] };
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  let value = { enabled: false, extra: [] };
  try {
    const [flag, extra] = await Promise.all([settingsRepository.get(requesterReplyCopyKey(id)), settingsRepository.get(requesterReplyCopyExtraKey(id))]);
    value = { enabled: parseFlag(flag), extra: parseAddressList(extra) };
  } catch (err) {
    logger.warn(`requesterReplyCopy: settings read failed for workspace ${id} (treating as off): ${err.message}`);
  }
  cache.set(id, { at: Date.now(), value });
  return value;
}

export async function setRequesterReplyCopySettings(workspaceId, { enabled, extra } = {}) {
  const id = Number(workspaceId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('workspaceId is required');
  if (typeof enabled === 'boolean') await settingsRepository.set(requesterReplyCopyKey(id), enabled ? '1' : '0');
  if (extra !== undefined) await settingsRepository.set(requesterReplyCopyExtraKey(id), parseAddressList(extra).join(', '));
  cache.delete(id);
  return getRequesterReplyCopySettings(id);
}

export function invalidateRequesterReplyCopyCache(workspaceId = null) {
  if (workspaceId === null) cache.clear();
  else cache.delete(Number(workspaceId));
}

function publicBaseUrl() {
  const configured = process.env.PUBLIC_APP_URL || process.env.FRONTEND_PUBLIC_URL || process.env.FRONTEND_URL
    || process.env.CORS_ORIGIN?.split(',')?.[0] || 'http://localhost:5173';
  return String(configured).trim().replace(/\/+$/, '');
}

/**
 * Who should get the copy: the assigned technician, else the agent who last
 * replied on the ticket, plus the configured extra addresses. Never the sender.
 */
export async function copyRecipientsFor(ticket, { senderEmail = null, extra = [] } = {}) {
  const out = new Set();
  const skip = String(senderEmail || '').toLowerCase();
  let primary = null;
  try {
    if (ticket?.assignedTechId) {
      const tech = await prisma.technician.findUnique({ where: { id: ticket.assignedTechId }, select: { email: true, name: true, isActive: true } });
      if (tech?.email && tech.isActive !== false) primary = { email: String(tech.email).toLowerCase(), name: tech.name || null, why: 'assigned' };
    }
    if (!primary) {
      const last = await prisma.ticketThreadEntry.findFirst({
        where: { ticketId: ticket.id, eventType: 'reply', authorType: 'agent', actorEmail: { not: null } },
        orderBy: { occurredAt: 'desc' },
        select: { actorEmail: true, actorName: true },
      });
      if (last?.actorEmail) primary = { email: String(last.actorEmail).toLowerCase(), name: last.actorName || null, why: 'last_replier' };
    }
  } catch (err) {
    logger.debug?.(`requesterReplyCopy: recipient lookup skipped for ticket ${ticket?.id}: ${err.message}`);
  }
  if (primary && primary.email !== skip) out.add(primary.email);
  for (const a of extra || []) if (a && a !== skip) out.add(a);
  return { to: [...out], primary };
}

export function renderRequesterReplyCopyEmail({ workspaceName, ticket, ref, appUrl, fromName, fromEmail, bodyHtml, bodyText, primary }) {
  const FONT = 'Arial,Helvetica,sans-serif';
  const INK = '#0f172a'; const MUTED = '#64748b'; const LINE = '#e2e8f0'; const BLUE = '#2563eb';
  const art = brandImg('kind-answer', { size: 64, alt: 'Requester replied' });
  const rows = [];
  rows.push(`<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>${art ? `<td width="80" valign="top" style="padding:2px 16px 0 0;">${art}</td>` : ''}<td valign="top">`
    + `<div style="font-family:${FONT};font-size:12px;line-height:16px;font-weight:bold;letter-spacing:0.8px;text-transform:uppercase;color:#065f46;">Requester replied</div>`
    + `<div style="font-family:${FONT};font-size:23px;line-height:29px;font-weight:bold;color:${INK};margin-top:6px;">${escapeHtml(ticket.subject || 'Ticket')}</div>`
    + `<div style="font-family:Consolas,'Courier New',monospace;font-size:12.5px;line-height:18px;color:${MUTED};margin-top:4px;">${escapeHtml(ref)}${primary?.why === 'last_replier' ? '  ·  unassigned — you replied last' : ''}</div>`
    + '</td></tr></table></td></tr>');
  rows.push('<tr><td height="16" style="height:16px;line-height:16px;font-size:1px;">&nbsp;</td></tr>');
  rows.push(`<tr><td style="font-family:${FONT};font-size:15px;line-height:22px;color:${INK};"><b>${escapeHtml(fromName || fromEmail || 'The requester')}</b>${fromEmail ? ` &lt;${escapeHtml(fromEmail)}&gt;` : ''} wrote:</td></tr>`);
  rows.push('<tr><td height="10" style="height:10px;line-height:10px;font-size:1px;">&nbsp;</td></tr>');
  const body = bodyHtml || `<p style="margin:0;">${escapeHtml(bodyText || '').replace(/\r?\n/g, '<br>')}</p>`;
  rows.push(`<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f8fafc" style="border-collapse:separate;background:#f8fafc;border:1px solid ${LINE};border-radius:10px;"><tr><td width="4" bgcolor="#059669" style="width:4px;background:#059669;border-radius:10px 0 0 10px;">&nbsp;</td><td style="padding:14px 16px;font-family:${FONT};font-size:15px;line-height:22px;color:${INK};">${body}</td></tr></table></td></tr>`);
  rows.push('<tr><td height="18" style="height:18px;line-height:18px;font-size:1px;">&nbsp;</td></tr>');
  rows.push(`<tr><td><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td align="center" bgcolor="${BLUE}" style="border-radius:10px;background:${BLUE};"><a href="${escapeHtml(appUrl)}" target="_blank" style="display:inline-block;padding:13px 28px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:10px;">Open the ticket &rarr;</a></td></tr></table></td></tr>`);
  rows.push(`<tr><td style="padding-top:10px;font-family:${FONT};font-size:13px;line-height:19px;color:${MUTED};">Reply from the ticket to answer ${escapeHtml(fromName || 'the requester')}. Replying to this e-mail adds your note to the ticket but does not reach them.</td></tr>`);
  rows.push('<tr><td height="8" style="height:8px;line-height:8px;font-size:1px;">&nbsp;</td></tr>');
  return emailShell({
    workspaceName,
    bodyRows: rows,
    footerHtml: `Sent by Ticket Pulse${workspaceName ? ` · ${escapeHtml(workspaceName)} workspace` : ''} because the requester answered a reply on this ticket. Turn this off in Settings → Email Branding → Sender identity.`,
    preheader: `${fromName || fromEmail || 'The requester'} replied on ${ref}: ${textExcerpt(bodyHtml || bodyText, 120).text}`,
  });
}

/**
 * Send the copy for a requester reply that just landed on `ticket` as `entry`.
 * Never throws; returns what was sent (for the log and tests).
 */
export async function copyAgentsOnRequesterReply(ticket, entry, { fromEmail = null, fromName = null } = {}) {
  try {
    const settings = await getRequesterReplyCopySettings(ticket.workspaceId);
    if (!settings.enabled) return { sent: false, reason: 'off' };
    const { to, primary } = await copyRecipientsFor(ticket, { senderEmail: fromEmail, extra: settings.extra });
    if (!to.length) return { sent: false, reason: 'no_recipient' };
    const ref = ticketDisplayRef(ticket);
    const workspace = await prisma.workspace.findUnique({ where: { id: ticket.workspaceId }, select: { name: true } }).catch(() => null);
    const html = renderRequesterReplyCopyEmail({
      workspaceName: workspace?.name || null, ticket, ref,
      appUrl: `${publicBaseUrl()}/tickets/${ticket.id}`,
      fromName, fromEmail, bodyHtml: entry.bodyHtml || null, bodyText: entry.bodyText || entry.content || '', primary,
    });
    const { sendTransactionalEmail } = await import('./transactionalEmailService.js');
    const result = await sendTransactionalEmail({
      workspaceId: ticket.workspaceId,
      to,
      subject: `Re: ${String(ticket.subject || 'Your ticket').replace(/[\r\n]+/g, ' ').trim()} [${ref}]`,
      html,
      label: 'requester_reply_copy',
      ticket,
    });
    logger.info(`Requester reply on ${ref} copied to ${to.join(', ')} (${primary?.why || 'extra only'}): ${result?.sent ? result.via : `not sent (${result?.error || result?.reason || 'unknown'})`}`);
    return { ...result, to };
  } catch (err) {
    logger.warn(`Requester reply copy failed for ticket ${ticket?.id} (non-fatal): ${err.message}`);
    return { sent: false, error: err.message };
  }
}

export default {
  getRequesterReplyCopySettings, setRequesterReplyCopySettings, invalidateRequesterReplyCopyCache,
  copyRecipientsFor, copyAgentsOnRequesterReply, renderRequesterReplyCopyEmail, parseAddressList,
};
