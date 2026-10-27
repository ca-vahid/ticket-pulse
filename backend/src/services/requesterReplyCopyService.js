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
import { escapeHtml } from './approvalEmailTemplate.js';
import { stripQuotedHtml } from '../utils/replyQuoteStripper.js';

import { resolvePublicBaseUrl } from '../utils/publicBaseUrl.js';
import { ticketLinkUrl } from '../utils/ticketLink.js';
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
  return resolvePublicBaseUrl({ warn: (m) => logger.warn(m) });
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

/**
 * The copy reads like the e-mail conversation itself (Vahid, 27 Oct 2026):
 * the requester's words, one quiet line about where to answer, then the
 * ticket's history in the same "Earlier in this conversation" format a reply
 * carries. It was a "Requester replied" card with a button.
 */
export function renderRequesterReplyCopyEmail({ ref, appUrl, fromName, fromEmail, bodyHtml, bodyText, primary, quoteHtml = '' }) {
  const who = String(fromName || fromEmail || 'The requester').trim();
  const firstName = who.split(/\s+/)[0];
  const body = bodyHtml
    ? (stripQuotedHtml(bodyHtml) || bodyHtml)
    : String(bodyText || '').split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\r?\n/g, '<br>')}</p>`).join('');
  const why = primary?.why === 'last_replier' ? ' The ticket is unassigned; you get this because you replied last.' : '';
  const hint = '<p style="font-family:Calibri,\'Segoe UI\',Arial,sans-serif;font-size:12.5px;line-height:18px;color:#6b7280;margin:22px 0 0;">'
    + `${escapeHtml(firstName)} replied on ${escapeHtml(ref)}. Answer from <a href="${escapeHtml(appUrl)}" target="_blank" style="color:#1d4ed8;">the ticket</a>; `
    + `a reply to this e-mail is added to the ticket as a note and does not reach ${escapeHtml(firstName)}.${escapeHtml(why)}</p>`;
  return `${body}${hint}${quoteHtml || ''}`;
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
    const bodyText = entry.bodyText || entry.content || '';
    // The history below the reply, with photos and pictures, exactly as a reply carries it.
    let quoteHtml = '';
    let attachments = [];
    let bodyHtml = entry.bodyHtml || null;
    try {
      const { default: ticketService } = await import('./ticketService.js');
      const { createInlineBudget, inlinePictures, inlineAttachments } = await import('./replyEmailPictures.js');
      const budget = createInlineBudget();
      if (bodyHtml) bodyHtml = await inlinePictures(bodyHtml, { budget, ticketId: ticket.id, entryId: entry.id ?? null, at: entry.occurredAt || null, maxWidth: 600 });
      const quote = await ticketService._lastInboundQuote(ticket.id, entry.id ?? null, { reply: { text: bodyText, authorName: fromName, authorEmail: fromEmail }, budget });
      quoteHtml = quote?.html || '';
      attachments = inlineAttachments(budget);
    } catch (err) {
      logger.debug?.(`requesterReplyCopy: history skipped for ticket ${ticket.id}: ${err.message}`);
    }
    const html = renderRequesterReplyCopyEmail({
      ref, appUrl: `${ticketLinkUrl(publicBaseUrl(), ticket)}`,
      fromName, fromEmail, bodyHtml, bodyText, primary, quoteHtml,
    });
    const { sendTransactionalEmail } = await import('./transactionalEmailService.js');
    const result = await sendTransactionalEmail({
      workspaceId: ticket.workspaceId,
      to,
      subject: `Re: ${String(ticket.subject || 'Your ticket').replace(/[\r\n]+/g, ' ').trim()} [${ref}]`,
      html,
      attachments,
      fromName: `${fromName || fromEmail || 'The requester'} via Ticket Pulse`,
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
