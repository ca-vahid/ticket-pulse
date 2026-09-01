import prisma from './prisma.js';
import logger from '../utils/logger.js';
import graphMailClient from '../integrations/graphMailClient.js';
import ticketService from './ticketService.js';
import statusService from './statusService.js';
import ticketActivityRepository from './ticketActivityRepository.js';
import mirrorService from './mirrorService.js';
import { TICKET_ORIGIN, TICKET_SOURCE, ticketDisplayRef } from '../utils/ticketOrigin.js';
import { sseManager } from '../routes/sse.routes.js';

const TICK_MS = Number(process.env.MAILBOX_INGEST_TICK_MS || 30 * 1000);
const FIRST_LOOKBACK_MS = 15 * 60 * 1000; // fresh connections look back 15 minutes
const MAX_CREATES_PER_SENDER_PER_CYCLE = 3;
// Poller demotion (MB-2d): a mailbox with a live Graph subscription gets its
// mail pushed within seconds, so the poller only runs as a delta/catch-up
// reconciliation every 5 min by default (clamped 1–15 min). Connections
// without a subscription keep their own pollIntervalSec cadence.
export const CATCHUP_INTERVAL_MS = Math.min(
  15 * 60 * 1000,
  Math.max(60 * 1000, Number(process.env.MAILBOX_CATCHUP_INTERVAL_MS) || 5 * 60 * 1000),
);

/**
 * True when the connection's Graph subscription is live: an id, status
 * 'active' and an expiry still in the future. Anything else (renewing,
 * error, expired, never created) means the poller is the only inbound lane.
 */
export function hasActiveSubscription(connection, now = Date.now()) {
  if (!connection?.subscriptionId || connection.notificationStatus !== 'active') return false;
  const expires = connection.subscriptionExpiresAt ? new Date(connection.subscriptionExpiresAt).getTime() : 0;
  return Number.isFinite(expires) && expires > now;
}

/** Poll cadence for a connection: catch-up interval when webhooks are live, else its own. */
export function effectivePollIntervalMs(connection, now = Date.now()) {
  if (hasActiveSubscription(connection, now)) return CATCHUP_INTERVAL_MS;
  return Math.max(15, Number(connection?.pollIntervalSec) || 60) * 1000;
}

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
 * Normalized To/Cc for an ingested Graph email (QA 08-05 #3 — Cc visibility).
 * Returns {to_emails, cc_emails} — the SAME rawPayload key shape FreshService
 * conversations use, so one UI path renders recipients for every origin — or
 * null when the message carries neither.
 */
export function emailRecipients(email) {
  const norm = (list) => [...new Set(
    (Array.isArray(list) ? list : [])
      .map((s) => String(s || '').trim().toLowerCase())
      .filter((s) => s.includes('@')),
  )];
  const to = norm(email?.to);
  const cc = norm(email?.cc);
  if (!to.length && !cc.length) return null;
  return { to_emails: to, cc_emails: cc };
}

/** Split a recipient header value / list item into bare lowercase addresses. */
function extractAddresses(raw) {
  if (raw === null || raw === undefined) return [];
  const parts = Array.isArray(raw) ? raw : String(raw).split(/[,;]/);
  const out = [];
  for (const part of parts) {
    const s = String(part || '').trim();
    if (!s) continue;
    const angle = s.match(/<([^<>]+)>/);
    const address = (angle ? angle[1] : s).trim().toLowerCase();
    if (address.includes('@')) out.push(address);
  }
  return out;
}

const PLUS_TAG_RE = /^([^@\s<>+]+)\+tp(\d+)@([^@\s<>]+)$/i;

/**
 * Plus-address reply token (MB-1c, ingest rung 1.5). Outbound Graph sends
 * carry `Reply-To: <mailboxLocal>+tp<n>@<domain>`; Exchange Online delivers
 * plus addresses to the base mailbox, so the tag comes back on the reply's
 * To (or Cc / Delivered-To / X-Original-To after a relay hop).
 *
 * Rules: every candidate recipient is normalized to a bare lowercase address;
 * only `<local>+tp<digits>@<domain>` shapes count; when the connection's
 * mailbox address is known the base `<local>@<domain>` MUST equal it (a tag
 * on some other mailbox's address is not ours); returns distinct native TP
 * numbers in encounter order (To before Cc before envelope headers).
 */
export function plusAddressTicketNumbers(email, mailboxAddress = null) {
  const base = String(mailboxAddress || '').trim().toLowerCase();
  const candidates = [
    ...extractAddresses(email?.to),
    ...extractAddresses(email?.cc),
    ...extractAddresses(email?.deliveredTo),
    ...extractAddresses(email?.xOriginalTo),
  ];
  const numbers = [];
  for (const address of candidates) {
    const m = address.match(PLUS_TAG_RE);
    if (!m) continue;
    if (base && `${m[1]}@${m[3]}`.toLowerCase() !== base) continue;
    const n = Number(m[2]);
    if (Number.isInteger(n) && n > 0 && !numbers.includes(n)) numbers.push(n);
  }
  return numbers;
}

// Mirrors ticketService's emailListSchema (`.max(10)`) — the "Also for" cap
// the manual Cc editor enforces; inbound merges never exceed it.
export const MAX_CC_EMAILS = 10;
const EMAIL_SHAPE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * Inbound Cc merge (MB-1d), pure part. Unions the reply's Cc — and To other
 * than the mailbox itself — into the ticket's existing ccEmails. Same
 * normalization as the manual editor (trim, lowercase, dedupe, ≤10):
 * existing entries keep their order and are never removed; the mailbox
 * address (and any `mailbox+tag@` variant), every `exclude` address
 * (requester, known agents), malformed addresses and duplicates are
 * skipped; new entries append until the cap. Returns the previous/next
 * lists plus what was added/dropped so the caller can audit + persist.
 */
export function mergeInboundCc(existing, email, { mailboxAddress = null, exclude = [] } = {}) {
  const previous = [...new Set(
    (Array.isArray(existing) ? existing : []).map((e) => String(e || '').trim().toLowerCase()).filter(Boolean),
  )];
  const base = String(mailboxAddress || '').trim().toLowerCase();
  const [baseLocal, baseDomain] = base.split('@');
  const isMailbox = (address) => {
    if (!base) return false;
    if (address === base) return true;
    const m = address.match(/^([^@+]+)\+[^@]*@(.+)$/);
    return Boolean(m) && m[1] === baseLocal && m[2] === baseDomain;
  };
  const skip = new Set([
    ...previous,
    ...(Array.isArray(exclude) ? exclude : []).map((e) => String(e || '').trim().toLowerCase()).filter(Boolean),
  ]);
  const candidates = [];
  for (const address of [...extractAddresses(email?.to), ...extractAddresses(email?.cc)]) {
    if (!EMAIL_SHAPE.test(address) || skip.has(address) || isMailbox(address) || candidates.includes(address)) continue;
    candidates.push(address);
  }
  const room = Math.max(0, MAX_CC_EMAILS - previous.length);
  const added = candidates.slice(0, room);
  return { previous, next: [...previous, ...added], added, dropped: candidates.slice(room) };
}

/**
 * Email → ticket ingestion for native ticketing.
 *
 * Matching ladder (per inbound message):
 *  1. In-Reply-To / References ↔ stored thread-entry emailMessageIds
 *  1.5 `<mailbox>+tp<n>@` plus-address tag on To/Cc/Delivered-To (our Reply-To)
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
    // Connection ids whose next poll must run NOW regardless of cadence
    // (lifecycle `missed`/`subscriptionRemoved`, a failed webhook fetch).
    this._catchUpRequested = new Set();
  }

  /** Force the next tick to reconcile this connection (delta or inbox fetch). */
  requestCatchUp(connectionId) {
    if (connectionId) this._catchUpRequested.add(Number(connectionId));
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
        if (this._catchUpRequested.has(c.id)) return true;
        const last = c.lastCheckedAt ? new Date(c.lastCheckedAt).getTime() : 0;
        return now - last >= effectivePollIntervalMs(c, now);
      });
      for (const connection of due) {
        this._catchUpRequested.delete(connection.id);
        await this.pollConnection(connection).catch((err) => {
          logger.warn(`Mailbox poll failed for ${connection.address} (non-fatal): ${err.message}`);
        });
      }
      return { polled: due.length };
    } finally {
      this._running = false;
    }
  }

  /**
   * One reconciliation pass. With a delta cursor (MB-2: bootstrapped by the
   * subscription manager) the pass is a cheap delta round — ids only, then
   * fetch-by-id for anything not already ingested. Without one it is the
   * original "inbox since lastMessageAt" fetch. Both feed the same per-message
   * pipeline (ingestSingleMessage) the webhook worker uses.
   */
  async pollConnection(connection) {
    if (connection.deltaLink) {
      try {
        return await this._pollDelta(connection);
      } catch (err) {
        if (!err?.deltaReset) throw err;
        // Token expired/invalid: drop it, fall back to the inbox fetch for this
        // pass; the subscription manager bootstraps a fresh cursor on its tick.
        logger.warn(`Mailbox ${connection.address}: delta cursor rejected by Graph — resetting to inbox fetch`);
        await prisma.mailboxConnection.update({
          where: { id: connection.id }, data: { deltaLink: null },
        }).catch(() => {});
        connection = { ...connection, deltaLink: null };
      }
    }
    return this._pollInbox(connection);
  }

  async _pollInbox(connection) {
    const since = connection.lastMessageAt
      ? new Date(connection.lastMessageAt)
      : new Date(Date.now() - FIRST_LOOKBACK_MS);

    let emails;
    try {
      emails = await graphMailClient.getInboxMessagesForIngest(connection.address, since, 25);
    } catch (err) {
      await this._recordPollError(connection, err);
      throw err;
    }

    const { results, latest } = await this._ingestBatch(connection, emails, since);

    await prisma.mailboxConnection.update({
      where: { id: connection.id },
      data: { lastCheckedAt: new Date(), lastMessageAt: latest, lastError: null, lastErrorAt: null },
    }).catch(() => {});

    if (emails.length > 0) {
      logger.info(`Mailbox ${connection.address}: ${emails.length} message(s) → ${results.matchedReplies} replies, ${results.created} new tickets, ${results.skipped} skipped`);
    }
    return results;
  }

  async _pollDelta(connection) {
    let round;
    try {
      round = await graphMailClient.getInboxDeltaChanges(connection.address, connection.deltaLink);
    } catch (err) {
      if (!err?.deltaReset) await this._recordPollError(connection, err);
      throw err;
    }

    // Delta is collection-level: it also reports read/unread flips and
    // removals for old mail. Skip removals and anything already ingested
    // BEFORE spending a Graph GET on it.
    const emails = [];
    for (const item of round.items) {
      if (item.removed || !item.id) continue;
      if (item.internetMessageId && await this._alreadyIngested(connection, item.internetMessageId)) continue;
      try {
        const email = await graphMailClient.getMessageForIngest(connection.address, item.id);
        if (email) emails.push(email);
      } catch (err) {
        logger.warn(`Mailbox ${connection.address}: delta fetch-by-id failed for ${item.id} (non-fatal): ${err.message}`);
      }
    }
    emails.sort((a, b) => (a.receivedAt?.getTime() || 0) - (b.receivedAt?.getTime() || 0));

    const since = connection.lastMessageAt ? new Date(connection.lastMessageAt) : new Date(0);
    const { results, latest } = await this._ingestBatch(connection, emails, since);

    await prisma.mailboxConnection.update({
      where: { id: connection.id },
      data: {
        lastCheckedAt: new Date(),
        lastMessageAt: latest,
        lastError: null,
        lastErrorAt: null,
        ...(round.deltaLink ? { deltaLink: round.deltaLink } : {}),
      },
    }).catch(() => {});

    if (emails.length > 0) {
      logger.info(`Mailbox ${connection.address} (delta): ${emails.length} message(s) → ${results.matchedReplies} replies, ${results.created} new tickets, ${results.skipped} skipped`);
    }
    return { ...results, delta: true, changes: round.items.length };
  }

  async _ingestBatch(connection, emails, since) {
    const senderCreates = new Map();
    let latest = since;
    const results = { matchedReplies: 0, created: 0, skipped: 0 };
    for (const email of emails) {
      if (email.receivedAt > latest) latest = email.receivedAt;
      try {
        const outcome = await this.ingestSingleMessage(connection, email, senderCreates);
        if (outcome === 'reply') results.matchedReplies += 1;
        else if (outcome === 'created') results.created += 1;
        else results.skipped += 1;
      } catch (err) {
        results.skipped += 1;
        logger.warn(`Mailbox ingest failed for message ${email.id} (${connection.address}): ${err.message}`);
      }
    }
    return { results, latest };
  }

  async _recordPollError(connection, err) {
    await prisma.mailboxConnection.update({
      where: { id: connection.id },
      data: { lastCheckedAt: new Date(), lastError: String(err.message).slice(0, 2000), lastErrorAt: new Date() },
    }).catch(() => {});
  }

  /** Dedupe probe shared by the delta lane and the webhook worker. */
  async _alreadyIngested(connection, internetMessageId) {
    if (!internetMessageId) return false;
    const seen = await prisma.ticketThreadEntry.findFirst({
      where: { emailMessageId: internetMessageId, workspaceId: connection.workspaceId },
      select: { id: true },
    });
    return Boolean(seen);
  }

  /** Back-compat alias — the pipeline entry point is ingestSingleMessage. */
  async processEmail(connection, email, senderCreates = new Map()) {
    return this.ingestSingleMessage(connection, email, senderCreates);
  }

  /**
   * THE per-message pipeline (poller, delta lane and webhook worker all end
   * here): loop guards → dedupe by internetMessageId → matching ladder →
   * reply ingest or new ticket. Returns 'reply' | 'created' | 'skipped'.
   */
  async ingestSingleMessage(connection, email, senderCreates = new Map()) {
    const loopReason = looksLikeLoopMail(email, connection.address);
    if (loopReason) {
      logger.debug(`Mailbox ingest skipping message (${loopReason}): ${email.subject}`);
      return 'skipped';
    }

    // Dedupe: has this exact message already been ingested?
    if (await this._alreadyIngested(connection, email.internetMessageId)) return 'skipped';

    const match = await this.matchEmailToTicket(connection.workspaceId, email, connection.address);
    if (match?.skip) return 'skipped';
    if (match?.ticket) {
      await this.ingestReply(connection, match.ticket, email, match.via);
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

  async matchEmailToTicket(workspaceId, email, mailboxAddress = null) {
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

    // 1b. Workflow/lifecycle emails (ticket.created acks — the highest-volume
    // lane) have NO thread entry: their outbound Message-ID lives only in
    // notification_deliveries.provider_message_id (Graph lane). Match the
    // same angle-bracketed ids there (plus the bare form, in case a lane
    // stores the id without brackets) — one query, ticket_id links directly.
    if (refs.length > 0) {
      const bare = refs.map((r) => r.replace(/^<|>$/g, ''));
      const delivery = await prisma.notificationDelivery.findFirst({
        where: { workspaceId, providerMessageId: { in: [...new Set([...refs, ...bare])] } },
        select: { ticketId: true },
        orderBy: { id: 'desc' },
      });
      if (delivery?.ticketId) {
        const ticket = await prisma.ticket.findUnique({ where: { id: delivery.ticketId } });
        if (ticket) return { ticket, via: 'notification_delivery' };
      }
    }

    // 1.5 Plus-address tag on the recipient (`mailbox+tp1042@…`, our Reply-To)
    for (const nativeNumber of plusAddressTicketNumbers(email, mailboxAddress)) {
      const ticket = await prisma.ticket.findFirst({
        where: { workspaceId, nativeNumber, origin: TICKET_ORIGIN.TICKETPULSE },
      });
      if (ticket) return { ticket, via: 'plus_address' };
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

    // 4. Sender + recency against open TP-born tickets (open = Open/Pending-
    // BASE names from the workspace registry, so a reply still threads onto a
    // ticket parked in a custom open status — Phase 8b)
    const recent = await prisma.ticket.findFirst({
      where: {
        workspaceId,
        origin: TICKET_ORIGIN.TICKETPULSE,
        status: { in: await statusService.statusNamesForBase(workspaceId, ['Open', 'Pending']) },
        updatedAt: { gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
        requester: { is: { email: { equals: String(email.from), mode: 'insensitive' } } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (recent) return { ticket: recent, via: 'sender_recency' };

    return null;
  }

  /**
   * Pull the email's file attachments into Blob storage, linked to the ticket
   * (and thread entry when given). Returns a notice string for anything that
   * could not be captured.
   */
  async _captureAttachments(connection, email, ticket, threadEntryId = null) {
    if (!email.hasAttachments) return '';
    try {
      const { default: attachmentService } = await import('./attachmentService.js');
      if (!attachmentService.isConfigured()) {
        return '\n\n[This email had attachments — attachment storage is not configured, view the original in the mailbox.]';
      }
      const { files, skipped } = await graphMailClient.getMessageAttachments(connection.address, email.id);
      for (const file of files) {
        await attachmentService.upload({
          workspaceId: ticket.workspaceId,
          ticketId: ticket.id,
          threadEntryId,
          fileName: file.name,
          contentType: file.contentType,
          buffer: file.buffer,
          uploadedBy: email.from,
          source: 'email',
        }).catch((err) => {
          skipped.push({ name: file.name, reason: err.message });
        });
      }
      if (skipped.length > 0) {
        return `\n\n[${skipped.length} attachment(s) could not be imported: ${skipped.map((s) => s.name).join(', ')}]`;
      }
      return '';
    } catch (err) {
      logger.warn(`Email attachment capture failed (non-fatal): ${err.message}`);
      return '\n\n[This email had attachments — they could not be imported. View the original in the mailbox.]';
    }
  }

  async ingestReply(connection, ticket, email, via) {
    const now = new Date();
    const recipients = emailRecipients(email);
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
        bodyText: email.bodyText || email.bodyPreview || null,
        content: email.bodyText || email.bodyPreview || null,
        occurredAt: email.receivedAt || now,
        emailMessageId: email.internetMessageId,
        // Requester replies belong on the FS fallback copy too
        mirrorState: ticket.origin === TICKET_ORIGIN.TICKETPULSE ? 'pending' : null,
        // Who else the sender addressed (QA 08-05 #3) — FS conversation shape.
        ...(recipients ? { rawPayload: recipients } : {}),
      },
    });

    const attachmentNotice = await this._captureAttachments(connection, email, ticket, entry.id);
    if (attachmentNotice) {
      await prisma.ticketThreadEntry.update({
        where: { id: entry.id },
        data: {
          bodyText: (entry.bodyText || '') + attachmentNotice,
          content: (entry.content || '') + attachmentNotice,
        },
      }).catch(() => {});
    }

    // Inbound Cc merge (MB-1d): whoever the requester looped in mid-thread
    // keeps receiving agent replies. TP-born only — FS-born ccEmails are
    // FreshService-owned. Non-fatal: a merge failure never loses the reply.
    const ccMerge = ticket.origin === TICKET_ORIGIN.TICKETPULSE
      ? await this._mergeReplyCc(connection, ticket, email).catch((err) => {
        logger.warn(`Inbound Cc merge failed for ${ticketDisplayRef(ticket)} (non-fatal): ${err.message}`);
        return null;
      })
      : null;
    const ccAdded = Boolean(ccMerge?.added?.length);

    await prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        updatedAt: now,
        lastRealActivityAt: now,
        // The FS fallback copy carries ccEmails as cc_emails — same mirror
        // churn the manual "Also for" editor triggers.
        ...(ccAdded ? { ccEmails: ccMerge.next, mirrorState: 'pending' } : {}),
      },
    });
    await ticketActivityRepository.create({
      ticketId: ticket.id,
      activityType: 'requester_reply',
      performedBy: email.fromName || email.from,
      performedAt: now,
      details: { via, emailMessageId: email.internetMessageId, source: 'email_inbound' },
    }).catch(() => {});
    if (ccAdded) {
      // Same audit shape the manual Cc editor writes (ticketService
      // updateTicket → _audit 'cc_changed' {from, to}) so the activity
      // timeline renders "additional requesters changed" for both paths.
      await ticketActivityRepository.create({
        ticketId: ticket.id,
        activityType: 'cc_changed',
        performedBy: SYSTEM_ACTOR.name,
        performedAt: now,
        details: {
          source: 'email_inbound',
          actorEmail: SYSTEM_ACTOR.email,
          from: ccMerge.previous,
          to: ccMerge.next,
          added: ccMerge.added,
          ...(ccMerge.dropped.length ? { droppedOverCap: ccMerge.dropped } : {}),
          via: 'inbound_reply',
          replyFrom: email.from,
          entryId: entry.id,
        },
      }).catch(() => {});
    }

    if (ticket.origin === TICKET_ORIGIN.TICKETPULSE) {
      await mirrorService.enqueueThreadEntry(ticket.workspaceId, ticket.id, entry.id);
      if (ccAdded) await mirrorService.enqueueFieldSync?.(ticket.workspaceId, ticket.id)?.catch?.(() => {});
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

    // Category/group watchers who opted into requester replies (fire-and-forget).
    try {
      const { default: watcherNotificationService } = await import('./watcherNotificationService.js');
      watcherNotificationService.notify('requester_reply', ticket.id, {
        entryPreview: entry.bodyText || entry.content || null,
      }).catch(() => {});
    } catch { /* non-fatal */ }

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

  /**
   * Resolve the exclusions for the inbound Cc merge (MB-1d) and run it:
   * the mailbox itself (handled inside mergeInboundCc), the ticket's
   * requester (they are the To of every reply) and known agent addresses in
   * the workspace (agents read the thread in-app; cc'ing them would echo
   * every reply back into the mailbox). Returns null when nothing changes.
   */
  async _mergeReplyCc(connection, ticket, email) {
    const probe = mergeInboundCc(ticket.ccEmails, email, { mailboxAddress: connection.address });
    if (probe.added.length === 0 && probe.dropped.length === 0) return null;

    const exclude = [];
    let requesterEmail = ticket.requester?.email || null;
    if (!requesterEmail && ticket.requesterId) {
      const requester = await prisma.requester.findUnique({ where: { id: ticket.requesterId }, select: { email: true } });
      requesterEmail = requester?.email || null;
    }
    if (requesterEmail) exclude.push(requesterEmail);

    const candidates = [...probe.added, ...probe.dropped];
    const agents = await prisma.technician.findMany({
      where: { workspaceId: ticket.workspaceId, email: { in: candidates, mode: 'insensitive' } },
      select: { email: true },
    });
    for (const agent of agents) if (agent?.email) exclude.push(agent.email);

    const merged = mergeInboundCc(ticket.ccEmails, email, { mailboxAddress: connection.address, exclude });
    return merged.added.length ? merged : null;
  }

  async createTicketFromEmail(connection, email) {
    const subject = String(email.subject || '').trim() || '(no subject)';
    const ticket = await ticketService.createTicket(connection.workspaceId, {
      subject: subject.length >= 3 ? subject.slice(0, 500) : `Email: ${subject}`,
      description: email.bodyHtml || null,
      priority: 2,
      requesterEmail: email.from,
      requesterName: email.fromName || null,
      runAiTriage: true,
      // Mailbox→group routing: AP@ lands in the AP group, AR@ in AR, etc.
      ...(connection.defaultGroupId ? { groupId: connection.defaultGroupId.toString() } : {}),
      // Internal (TP-native) group routing — a mailbox can default into an internal group.
      ...(connection.defaultInternalGroupId ? { internalGroupId: connection.defaultInternalGroupId } : {}),
      ...(connection.defaultTicketType ? { ticketType: connection.defaultTicketType } : {}),
    }, SYSTEM_ACTOR, { sourceChannel: TICKET_SOURCE.EMAIL });

    // Persist who the email was addressed to (QA 08-05 #3): graphMailClient
    // already fetched to/cc — store them on the ticket row (same columns FS
    // sync fills) instead of discarding them. Non-fatal on failure.
    const recipients = emailRecipients(email);
    if (recipients) {
      await prisma.ticket.update({
        where: { id: ticket.id },
        data: { toEmails: recipients.to_emails, ccEmails: recipients.cc_emails },
      }).catch((err) => {
        logger.warn(`Email recipients not persisted for ${ticket.displayRef} (non-fatal): ${err.message}`);
      });
    }

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
          ...(recipients ? { rawPayload: recipients } : {}),
        },
      }).catch(() => {});
    }

    const attachmentNotice = await this._captureAttachments(connection, email, { id: ticket.id, workspaceId: connection.workspaceId });
    if (attachmentNotice) {
      logger.warn(`Attachment capture notice for ${ticket.displayRef}: ${attachmentNotice.trim()}`);
    }

    logger.info(`Inbound email created ${ticket.displayRef} (from ${email.from}: "${subject}")`);
    return ticket;
  }
}

export default new MailboxIngestService();
