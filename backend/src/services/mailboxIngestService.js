import prisma from './prisma.js';
import logger from '../utils/logger.js';
import graphMailClient from '../integrations/graphMailClient.js';
import ticketService from './ticketService.js';
import ticketActivityRepository from './ticketActivityRepository.js';
import mirrorService from './mirrorService.js';
import { TICKET_ORIGIN, ticketDisplayRef } from '../utils/ticketOrigin.js';
import { sseManager } from '../routes/sse.routes.js';

const TICK_MS = Number(process.env.MAILBOX_INGEST_TICK_MS || 30 * 1000);
const FIRST_LOOKBACK_MS = 15 * 60 * 1000; // fresh connections look back 15 minutes
const MAX_CREATES_PER_SENDER_PER_CYCLE = 3;

const SYSTEM_ACTOR = { email: 'mailbox@ticketpulse.internal', name: 'Ticket Pulse Mail', role: 'system', technicianId: null };

const AUTOREPLY_SUBJECT = /^(automatic reply|auto(mated)? (reply|response)|out of office|undeliverable|delivery status notification|mail delivery failed)/i;
const LOOP_SENDERS = /(mailer-daemon|postmaster|no-?reply|donotreply|do-not-reply)@/i;

export function looksLikeLoopMail(email, connectionAddress) {
  const from = String(email.from || '').toLowerCase();
  if (!from) return 'missing_sender';
  if (from === String(connectionAddress || '').toLowerCase()) return 'self_send';
  if (LOOP_SENDERS.test(from)) return 'automated_sender';
  if (AUTOREPLY_SUBJECT.test(String(email.subject || ''))) return 'autoreply_subject';
  const auto = String(email.autoSubmitted || '').toLowerCase();
  if (auto && auto !== 'no') return 'auto_submitted_header';
  const precedence = String(email.precedence || '').toLowerCase();
  if (precedence === 'bulk' || precedence === 'junk' || precedence === 'list') return 'bulk_precedence';
  return null;
}

/** Extract candidate Message-IDs from In-Reply-To/References headers. */
export function referencedMessageIds(email) {
  const raw = `${email.inReplyTo || ''} ${email.references || ''}`;
  return [...raw.matchAll(/<[^<>\s]+>/g)].map((m) => m[0]);
}

/**
 * Email → ticket ingestion for native ticketing.
 *
 * Matching ladder (per inbound message):
 *  1. In-Reply-To / References ↔ stored thread-entry emailMessageIds
 *  2. "TP-1042" ticket ref in the subject (TP-born tickets)
 *  3. "#12345" FreshService ref in the subject → SKIPPED here (FreshService
 *     receives the same mail itself; ingesting would duplicate the thread)
 *  4. Sender + recency heuristic against open TP-born tickets
 *  → no match: create a new TP-born ticket (AI triage runs; ticket.created
 *    workflows send the acknowledgement)
 */
class MailboxIngestService {
  constructor() {
    this._timer = null;
    this._running = false;
  }

  isEnabled() {
    return process.env.MAILBOX_INGEST_ENABLED !== 'false' && graphMailClient.isConfigured();
  }

  start() {
    if (this._timer || !this.isEnabled()) return;
    this._timer = setInterval(() => {
      this.tick().catch((err) => logger.warn(`Mailbox ingest tick failed (non-fatal): ${err.message}`));
    }, TICK_MS);
    this._timer.unref?.();
    logger.info(`Mailbox ingest worker started (tick ${Math.round(TICK_MS / 1000)}s)`);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async tick() {
    if (this._running) return { skipped: true };
    this._running = true;
    try {
      const now = Date.now();
      const connections = await prisma.mailboxConnection.findMany({
        where: { isEnabled: true, mode: { in: ['ingest', 'both'] }, workspace: { isActive: true, nativeTicketingEnabled: true } },
      });
      const due = connections.filter((c) => {
        const last = c.lastCheckedAt ? new Date(c.lastCheckedAt).getTime() : 0;
        return now - last >= (c.pollIntervalSec || 60) * 1000;
      });
      for (const connection of due) {
        await this.pollConnection(connection).catch((err) => {
          logger.warn(`Mailbox poll failed for ${connection.address} (non-fatal): ${err.message}`);
        });
      }
      return { polled: due.length };
    } finally {
      this._running = false;
    }
  }

  async pollConnection(connection) {
    const since = connection.lastMessageAt
      ? new Date(connection.lastMessageAt)
      : new Date(Date.now() - FIRST_LOOKBACK_MS);

    let emails;
    try {
      emails = await graphMailClient.getInboxMessagesForIngest(connection.address, since, 25);
    } catch (err) {
      await prisma.mailboxConnection.update({
        where: { id: connection.id },
        data: { lastCheckedAt: new Date(), lastError: String(err.message).slice(0, 2000), lastErrorAt: new Date() },
      }).catch(() => {});
      throw err;
    }

    const senderCreates = new Map();
    let latest = since;
    const results = { matchedReplies: 0, created: 0, skipped: 0 };

    for (const email of emails) {
      if (email.receivedAt > latest) latest = email.receivedAt;
      try {
        const outcome = await this.processEmail(connection, email, senderCreates);
        if (outcome === 'reply') results.matchedReplies += 1;
        else if (outcome === 'created') results.created += 1;
        else results.skipped += 1;
      } catch (err) {
        results.skipped += 1;
        logger.warn(`Mailbox ingest failed for message ${email.id} (${connection.address}): ${err.message}`);
      }
    }

    await prisma.mailboxConnection.update({
      where: { id: connection.id },
      data: { lastCheckedAt: new Date(), lastMessageAt: latest, lastError: null, lastErrorAt: null },
    }).catch(() => {});

    if (emails.length > 0) {
      logger.info(`Mailbox ${connection.address}: ${emails.length} message(s) → ${results.matchedReplies} replies, ${results.created} new tickets, ${results.skipped} skipped`);
    }
    return results;
  }

  async processEmail(connection, email, senderCreates = new Map()) {
    const loopReason = looksLikeLoopMail(email, connection.address);
    if (loopReason) {
      logger.debug(`Mailbox ingest skipping message (${loopReason}): ${email.subject}`);
      return 'skipped';
    }

    // Dedupe: has this exact message already been ingested?
    if (email.internetMessageId) {
      const seen = await prisma.ticketThreadEntry.findFirst({
        where: { emailMessageId: email.internetMessageId, workspaceId: connection.workspaceId },
        select: { id: true },
      });
      if (seen) return 'skipped';
    }

    const match = await this.matchEmailToTicket(connection.workspaceId, email);
    if (match?.skip) return 'skipped';
    if (match?.ticket) {
      await this.ingestReply(match.ticket, email, match.via);
      return 'reply';
    }

    // Throttle runaway senders (loops the header checks didn't catch)
    const senderKey = String(email.from).toLowerCase();
    const count = senderCreates.get(senderKey) || 0;
    if (count >= MAX_CREATES_PER_SENDER_PER_CYCLE) {
      logger.warn(`Mailbox ingest: sender ${senderKey} exceeded per-cycle create cap — skipping "${email.subject}"`);
      return 'skipped';
    }
    senderCreates.set(senderKey, count + 1);

    await this.createTicketFromEmail(connection, email);
    return 'created';
  }

  async matchEmailToTicket(workspaceId, email) {
    // 1. Threading headers ↔ our stored Message-IDs
    const refs = referencedMessageIds(email);
    if (refs.length > 0) {
      const entry = await prisma.ticketThreadEntry.findFirst({
        where: { workspaceId, emailMessageId: { in: refs } },
        select: { ticketId: true },
        orderBy: { id: 'desc' },
      });
      if (entry) {
        const ticket = await prisma.ticket.findUnique({ where: { id: entry.ticketId } });
        if (ticket) return { ticket, via: 'threading_headers' };
      }
    }

    const subject = String(email.subject || '');

    // 2. TP-born ref in subject
    const tpMatch = subject.match(/\bTP-(\d{3,})\b/i);
    if (tpMatch) {
      const ticket = await prisma.ticket.findFirst({
        where: { workspaceId, nativeNumber: Number(tpMatch[1]), origin: TICKET_ORIGIN.TICKETPULSE },
      });
      if (ticket) return { ticket, via: 'tp_ref' };
    }

    // 3. FreshService ref → FS receives this mail itself; do not double-ingest
    const fsMatch = subject.match(/(?:\[?#|Ticket\s*#?)(\d{4,})\]?/i);
    if (fsMatch) {
      const fsTicket = await prisma.ticket.findFirst({
        where: { workspaceId, freshserviceTicketId: BigInt(fsMatch[1]), origin: TICKET_ORIGIN.FRESHSERVICE },
        select: { id: true },
      });
      if (fsTicket) return { skip: true, reason: 'freshservice_ref' };
    }

    // 4. Sender + recency against open TP-born tickets
    const recent = await prisma.ticket.findFirst({
      where: {
        workspaceId,
        origin: TICKET_ORIGIN.TICKETPULSE,
        status: { in: ['Open', 'Pending'] },
        updatedAt: { gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
        requester: { is: { email: { equals: String(email.from), mode: 'insensitive' } } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (recent) return { ticket: recent, via: 'sender_recency' };

    return null;
  }

  async ingestReply(ticket, email, via) {
    const now = new Date();
    // Attachment capture lands with the Blob workstream — for now, be honest.
    const attachmentNotice = email.hasAttachments
      ? '\n\n[This email had attachments — they were not imported. View the original in the mailbox.]'
      : '';
    const entry = await prisma.ticketThreadEntry.create({
      data: {
        ticketId: ticket.id,
        workspaceId: ticket.workspaceId,
        externalEntryId: `graph-${email.id}`,
        source: 'email_inbound',
        eventType: 'reply',
        actorName: email.fromName || email.from,
        actorEmail: email.from,
        authorType: 'requester',
        incoming: true,
        isPrivate: false,
        visibility: 'public',
        bodyHtml: email.bodyHtml,
        bodyText: (email.bodyText || email.bodyPreview || '') + attachmentNotice || null,
        content: (email.bodyText || email.bodyPreview || '') + attachmentNotice || null,
        occurredAt: email.receivedAt || now,
        emailMessageId: email.internetMessageId,
        // Requester replies belong on the FS fallback copy too
        mirrorState: ticket.origin === TICKET_ORIGIN.TICKETPULSE ? 'pending' : null,
      },
    });

    await prisma.ticket.update({ where: { id: ticket.id }, data: { updatedAt: now } });
    await ticketActivityRepository.create({
      ticketId: ticket.id,
      activityType: 'requester_reply',
      performedBy: email.fromName || email.from,
      performedAt: now,
      details: { via, emailMessageId: email.internetMessageId, source: 'email_inbound' },
    }).catch(() => {});

    if (ticket.origin === TICKET_ORIGIN.TICKETPULSE) {
      await mirrorService.enqueueThreadEntry(ticket.workspaceId, ticket.id, entry.id);
    }

    // Workflow trigger: "Requester replied" (drives the seeded reopen workflow).
    try {
      const { default: lifecycle } = await import('./ticketLifecycleNotificationService.js');
      await lifecycle.emitTicketEvent('ticket.reply_received', ticket.id, {
        source: 'email_inbound',
        dedupeStamp: `reply:${entry.id}`,
        extra: { entryId: entry.id, from: email.from, via },
      });
    } catch (err) {
      logger.warn(`reply_received workflow dispatch failed (non-fatal): ${err.message}`);
    }

    try {
      sseManager.broadcast('ticket-change', {
        action: 'reply',
        workspaceId: ticket.workspaceId,
        ticketId: ticket.id,
        origin: ticket.origin,
        displayRef: ticketDisplayRef(ticket),
        incoming: true,
        entryId: entry.id,
      }, ticket.workspaceId);
    } catch { /* non-fatal */ }

    logger.info(`Inbound email matched ${ticketDisplayRef(ticket)} via ${via} (from ${email.from})`);
    return entry;
  }

  async createTicketFromEmail(connection, email) {
    const subject = String(email.subject || '').trim() || '(no subject)';
    const attachmentNotice = email.hasAttachments
      ? '<p><i>[This email had attachments — they were not imported. View the original in the mailbox.]</i></p>'
      : '';
    const ticket = await ticketService.createTicket(connection.workspaceId, {
      subject: subject.length >= 3 ? subject.slice(0, 500) : `Email: ${subject}`,
      description: email.bodyHtml ? email.bodyHtml + attachmentNotice : (attachmentNotice || null),
      priority: 2,
      requesterEmail: email.from,
      requesterName: email.fromName || null,
      runAiTriage: true,
    }, SYSTEM_ACTOR);

    // Remember the originating message id so follow-ups thread to this ticket.
    if (email.internetMessageId) {
      await prisma.ticketThreadEntry.create({
        data: {
          ticketId: ticket.id,
          workspaceId: connection.workspaceId,
          externalEntryId: `graph-${email.id}`,
          source: 'email_inbound',
          eventType: 'original_email',
          actorName: email.fromName || email.from,
          actorEmail: email.from,
          authorType: 'requester',
          incoming: true,
          isPrivate: false,
          visibility: 'public',
          bodyText: email.bodyPreview || null,
          content: email.bodyPreview || null,
          occurredAt: email.receivedAt || new Date(),
          emailMessageId: email.internetMessageId,
          title: 'Original email',
        },
      }).catch(() => {});
    }

    logger.info(`Inbound email created ${ticket.displayRef} (from ${email.from}: "${subject}")`);
    return ticket;
  }
}

export default new MailboxIngestService();
