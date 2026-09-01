import { randomBytes } from 'node:crypto';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { TICKET_ORIGIN } from '../utils/ticketOrigin.js';

/**
 * Email threading anchors for ticket mail (Mega 08-31 Phase MB-1b/1c/1h).
 *
 * Small helpers shared by every outbound lane:
 *  - threadingHeadersForTicket → In-Reply-To / References from the ticket's
 *    stored Message-IDs (inbound `email_inbound` entries store the sender's
 *    internetMessageId; outbound Graph/SendGrid sends store ours).
 *  - plusAddressReplyTo → `local+tp<n>@domain` so a reply to ANY of our mails
 *    lands back in the monitored mailbox with the ticket number in the
 *    envelope (ingest rung 1.5 parses it). Graph lane only.
 *  - buildOutboundMessageId → our own RFC 5322 Message-ID for the SendGrid
 *    lane, stored on the thread entry exactly like Graph's internetMessageId
 *    so ingest rung 1 matches replies to SendGrid-sent mail too.
 */

export const THREADING_REFERENCE_LIMIT = 10;
export const DEFAULT_MESSAGE_ID_DOMAIN = 'ticketpulse.bgcsaas.com';

/** Normalize a Message-ID to the canonical `<...>` form (or null). */
export function normalizeMessageId(value) {
  const raw = String(value ?? '').replace(/\s+/g, '');
  if (!raw) return null;
  const inner = raw.replace(/^<+/, '').replace(/>+$/, '');
  if (!inner || !inner.includes('@')) return null;
  return `<${inner}>`;
}

/**
 * { inReplyTo, references } for a ticket: the newest stored Message-ID is
 * In-Reply-To; References carries the last ≤10 known ids oldest → newest
 * (RFC 5322 §3.6.4 order). Empty shape when nothing is stored. NEVER throws:
 * threading is a nicety, the send must not depend on it.
 */
export async function threadingHeadersForTicket(ticketId, { limit = THREADING_REFERENCE_LIMIT } = {}) {
  const empty = { inReplyTo: null, references: [] };
  const id = Number(ticketId);
  if (!Number.isInteger(id) || id <= 0) return empty;
  try {
    const rows = await prisma.ticketThreadEntry.findMany({
      where: { ticketId: id, emailMessageId: { not: null } },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: Math.max(1, Math.min(50, Number(limit) || THREADING_REFERENCE_LIMIT)),
      select: { emailMessageId: true },
    });
    const seen = new Set();
    const newestFirst = [];
    for (const row of rows || []) {
      const mid = normalizeMessageId(row?.emailMessageId);
      if (!mid || seen.has(mid)) continue;
      seen.add(mid);
      newestFirst.push(mid);
    }
    if (newestFirst.length === 0) return empty;
    return { inReplyTo: newestFirst[0], references: [...newestFirst].reverse() };
  } catch (err) {
    logger.debug(`threadingHeadersForTicket(${ticketId}) skipped: ${err.message}`);
    return empty;
  }
}

/**
 * Plus-address reply token for a TP-born ticket: `patickets+tp1234@bgc…`.
 * Null for FS-born tickets (no native number — FreshService owns that
 * thread) or an unusable mailbox address. Exchange Online plus addressing
 * delivers `local+tag@domain` to `local@domain` unchanged.
 */
export function plusAddressReplyTo(mailboxAddress, ticket) {
  const address = String(mailboxAddress || '').trim().toLowerCase();
  const at = address.indexOf('@');
  if (at <= 0 || at === address.length - 1) return null;
  if (!ticket || ticket.origin !== TICKET_ORIGIN.TICKETPULSE) return null;
  const n = Number(ticket.nativeNumber);
  if (!Number.isInteger(n) || n <= 0) return null;
  const local = address.slice(0, at).replace(/\+.*$/, ''); // never stack plus-tags
  const domain = address.slice(at + 1);
  if (!local) return null;
  return `${local}+tp${n}@${domain}`;
}

/** Domain of an email address (lower-cased) or null. */
export function domainOfAddress(address) {
  const raw = String(address || '').trim();
  const at = raw.lastIndexOf('@');
  if (at === -1 || at === raw.length - 1) return null;
  return raw.slice(at + 1).toLowerCase();
}

/**
 * Our own Message-ID for the SendGrid lane: `<tp-<ticketId>-<random>@domain>`.
 * `domain` should be the sending From address's domain (bgcengineering.ca)
 * — an address is accepted too; falls back to the app domain.
 */
export function buildOutboundMessageId(ticketId, domain = null) {
  const cleanDomain = String(domain || '').trim().toLowerCase().replace(/^.*@/, '').replace(/[^a-z0-9.-]/g, '')
    || DEFAULT_MESSAGE_ID_DOMAIN;
  const n = Number(ticketId);
  const idPart = Number.isInteger(n) && n > 0 ? String(n) : 'x';
  const random = `${Date.now().toString(36)}.${randomBytes(9).toString('hex')}`;
  return `<tp-${idPart}-${random}@${cleanDomain}>`;
}

/**
 * Persist a Message-ID on a thread entry (rung-1 anchor). Best-effort:
 * swallows every failure so a bookkeeping miss never fails the send.
 */
export async function storeEntryMessageId(entryId, messageId) {
  const mid = normalizeMessageId(messageId);
  const id = Number(entryId);
  if (!mid || !Number.isInteger(id) || id <= 0) return false;
  try {
    await prisma.ticketThreadEntry.update({ where: { id }, data: { emailMessageId: mid } });
    return true;
  } catch (err) {
    logger.debug(`storeEntryMessageId(${entryId}) skipped: ${err.message}`);
    return false;
  }
}

export default {
  threadingHeadersForTicket,
  plusAddressReplyTo,
  buildOutboundMessageId,
  normalizeMessageId,
  domainOfAddress,
  storeEntryMessageId,
};
