import prisma from './prisma.js';
import logger from '../utils/logger.js';
import graphMailClient from '../integrations/graphMailClient.js';
import ticketService from './ticketService.js';
import statusService from './statusService.js';
import ticketActivityRepository from './ticketActivityRepository.js';
import mirrorService from './mirrorService.js';
import { TICKET_ORIGIN, TICKET_SOURCE, ticketDisplayRef } from '../utils/ticketOrigin.js';
import { sseManager } from '../routes/sse.routes.js';
import agentIntake from './agentIntakeService.js';
import { PARSER_VERSION, textToHtml } from '../utils/forwardedMailParser.js';

// In-memory memory of messages handed to the hold queue (RL-4) so the delta
// poller does not re-fetch them every catch-up round; bounded, process-local
// (the hold service itself is idempotent on connection + Message-ID).
const HELD_CACHE_MAX = 5000;

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
 *  4. Sender + recency heuristic against open TP-born tickets — NEVER
 *     evaluated against an agent sender (FW-2): for an agent forward it runs
 *     against the quoted original sender, for an agent Cc reply against the
 *     external recipient, otherwise it is skipped.
 *  0. (after the ladder, Mega 09-01 RL-3) reply evidence + the agent-intake
 *     decision table (agentIntakeService.classifyIntake):
 *       forward / agent_cc / fresh → createTicketFromEmail(intake)
 *       external_reply_unknown     → hold queue (unless newTicketPolicy=create)
 *       agent_no_requester         → hold queue (agent_reply_no_requester)
 *       ambiguous_sender           → hold queue
 *  Every decision is logged with its rule + reason.
 */
class MailboxIngestService {
  constructor() {
    this._timer = null;
    this._running = false;
    // Connection ids whose next poll must run NOW regardless of cadence
    // (lifecycle `missed`/`subscriptionRemoved`, a failed webhook fetch).
    this._catchUpRequested = new Set();
    this._heldMessageIds = new Set();
  }

  _rememberHeld(internetMessageId) {
    if (!internetMessageId) return;
    if (this._heldMessageIds.size >= HELD_CACHE_MAX) this._heldMessageIds.clear();
    this._heldMessageIds.add(internetMessageId);
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
    const results = { matchedReplies: 0, created: 0, held: 0, skipped: 0 };
    for (const email of emails) {
      if (email.receivedAt > latest) latest = email.receivedAt;
      try {
        const outcome = await this.ingestSingleMessage(connection, email, senderCreates);
        if (outcome === 'reply') results.matchedReplies += 1;
        else if (outcome === 'created') results.created += 1;
        else if (outcome === 'held') results.held += 1;
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
    if (this._heldMessageIds.has(internetMessageId)) return true;
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
   * here): loop guards → dedupe by internetMessageId → agent-sender detection
   * (+ forward parse) → matching ladder → reply ingest, or the RL-3 decision
   * table → new ticket / hold. Returns 'reply' | 'created' | 'held' | 'skipped'.
   */
  async ingestSingleMessage(connection, email, senderCreates = new Map()) {
    const loopReason = looksLikeLoopMail(email, connection.address);
    if (loopReason) {
      logger.debug(`Mailbox ingest skipping message (${loopReason}): ${email.subject}`);
      return 'skipped';
    }

    // Dedupe: has this exact message already been ingested (or held)?
    if (await this._alreadyIngested(connection, email.internetMessageId)) return 'skipped';

    // Agent sender? Parse the body ONCE (forward header block / quoted From)
    // BEFORE the ladder so rung 4 never runs against the agent (FW-2).
    const agent = await agentIntake.resolveAgentSender(connection.workspaceId, email.from);
    const ctx = agent ? await agentIntake.prepareAgentContext(connection, email, agent) : null;

    const match = await this.matchEmailToTicket(connection.workspaceId, email, connection.address, {
      subject: ctx ? ctx.subjectForMatch : undefined,
      recencySender: ctx ? ctx.recencySender : email.from,
    });
    if (match?.skip) {
      logger.info(`Mailbox ingest decision: skip (${match.reason}) for "${email.subject}" from ${email.from}`);
      return 'skipped';
    }
    if (match?.ticket) {
      await this.ingestReply(connection, match.ticket, email, match.via, { agent, ctx });
      return 'reply';
    }

    // Rung 0 (RL-3): reply evidence. Last matching attempt on TP-refs found
    // in the body head (token-stripped subjects, quoted acks) before the
    // decision table runs.
    const reply = agentIntake.looksLikeReply(email);
    for (const nativeNumber of reply.bodyRefs.tp) {
      const ticket = await prisma.ticket.findFirst({
        where: { workspaceId: connection.workspaceId, nativeNumber, origin: TICKET_ORIGIN.TICKETPULSE },
      });
      if (ticket) {
        await this.ingestReply(connection, ticket, email, 'body_ref', { agent, ctx });
        return 'reply';
      }
    }

    const intake = await agentIntake.classifyIntake(connection, email, { knownReferenceFound: false, agent, ctx });
    const policy = agentIntake.newTicketPolicy(connection);
    logger.info(`Mailbox ingest decision: ${intake.kind} (rule ${intake.decision.rule}) for "${email.subject}" from ${email.from} → ${connection.address}`, {
      workspaceId: connection.workspaceId, connectionId: connection.id, internetMessageId: email.internetMessageId, policy, ...intake.decision.details,
    });

    switch (intake.kind) {
    case 'forward':
    case 'agent_cc':
    case 'fresh':
      break; // → create below
    case 'external_reply_unknown':
      if (policy === 'create') {
        logger.info(`Mailbox ingest: policy=create — creating despite reply evidence (${intake.decision.rule}) for "${email.subject}"`);
        break;
      }
      return this._holdOrFallback(connection, email, intake, 'unknown_reference', senderCreates);
    case 'agent_no_requester':
      return this._holdOrFallback(connection, email, intake, 'agent_reply_no_requester', senderCreates);
    case 'ambiguous_sender':
      return this._holdOrFallback(connection, email, intake, 'ambiguous_sender', senderCreates);
    default:
      break;
    }

    return this._createWithCap(connection, email, intake, senderCreates);
  }

  /** Per-sender create cap (loops the header checks didn't catch), then create. */
  async _createWithCap(connection, email, intake, senderCreates) {
    const senderKey = String(email.from).toLowerCase();
    const count = senderCreates.get(senderKey) || 0;
    if (count >= MAX_CREATES_PER_SENDER_PER_CYCLE) {
      logger.warn(`Mailbox ingest: sender ${senderKey} exceeded per-cycle create cap — skipping "${email.subject}"`);
      return 'skipped';
    }
    senderCreates.set(senderKey, count + 1);

    await this.createTicketFromEmail(connection, email, intake);
    return 'created';
  }

  /**
   * Hand the message to the hold queue (RL-4, built in parallel — contract:
   * mailboxHoldService.holdMessage(connection, email, {reason, bestGuessTicketId,
   * candidates, decision}) → {id}, idempotent on connection + Message-ID).
   * When the service is missing or throws: create ONLY when the mailbox
   * policy is 'create', otherwise remember the id and skip (the delta poller
   * will re-see it once the queue exists).
   */
  async _holdOrFallback(connection, email, intake, reason, senderCreates) {
    const policy = agentIntake.newTicketPolicy(connection);
    let bestGuessTicketId = intake.bestGuessTicketId ?? null;
    if (bestGuessTicketId === null && !intake.agent && email.from) {
      // Sender + recency with no status / 3-day cap — a hint for the reviewer only.
      const guess = await prisma.ticket.findFirst({
        where: {
          workspaceId: connection.workspaceId,
          origin: TICKET_ORIGIN.TICKETPULSE,
          requester: { is: { email: { equals: String(email.from), mode: 'insensitive' } } },
        },
        orderBy: { updatedAt: 'desc' },
        select: { id: true },
      }).catch(() => null);
      bestGuessTicketId = guess?.id ?? null;
    }
    try {
      const { default: holdService } = await import('./mailboxHoldService.js');
      if (typeof holdService?.holdMessage !== 'function') throw new Error('mailboxHoldService.holdMessage not available');
      const held = await holdService.holdMessage(connection, email, {
        reason,
        bestGuessTicketId,
        candidates: intake.candidates || [],
        decision: intake.decision,
      });
      this._rememberHeld(email.internetMessageId);
      logger.info(`Mailbox ingest held "${email.subject}" from ${email.from} (${reason}, rule ${intake.decision.rule}, hold ${held?.id ?? '?'})`);
      return 'held';
    } catch (err) {
      logger.warn(`Mailbox ingest: hold queue unavailable (${err.message}) — ${policy === 'create' ? 'creating (policy=create)' : 'skipping'} "${email.subject}" from ${email.from} [${reason}]`);
      if (policy === 'create') {
        return this._createWithCap(connection, email, { ...intake, kind: 'fresh', decision: { rule: `${intake.decision.rule}:hold_unavailable`, details: intake.decision.details } }, senderCreates);
      }
      this._rememberHeld(email.internetMessageId);
      return 'skipped';
    }
  }

  /**
   * @param {object} [options]
   * @param {string} [options.subject] subject to use for rungs 2/3 (prefix-stripped for agent mail)
   * @param {string|null} [options.recencySender] address for rung 4; null/'' skips rung 4 entirely
   */
  async matchEmailToTicket(workspaceId, email, mailboxAddress = null, { subject: subjectOverride, recencySender } = {}) {
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
    // notification_deliveries — provider_message_id (Graph lane) and, since
    // RL-5, message_id (the RFC Message-ID the SendGrid lane generates).
    // Match the same angle-bracketed ids there (plus the bare form, in case
    // a lane stores the id without brackets). One OR query; before the RL-5
    // column exists the Prisma client rejects `messageId` and we fall back
    // to the provider_message_id-only shape.
    if (refs.length > 0) {
      const bare = refs.map((r) => r.replace(/^<|>$/g, ''));
      const ids = [...new Set([...refs, ...bare])];
      const delivery = await this._findDeliveryByMessageIds(workspaceId, ids);
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

    const subject = String(subjectOverride !== undefined && subjectOverride !== null ? subjectOverride : (email.subject || ''));

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
    // ticket parked in a custom open status — Phase 8b). The address is the
    // caller's choice: the sender for requester mail, the quoted original
    // sender / external recipient for agent mail, never the agent (FW-2).
    const sender = recencySender === undefined ? String(email.from || '') : String(recencySender || '');
    if (!sender) return null;
    const recent = await prisma.ticket.findFirst({
      where: {
        workspaceId,
        origin: TICKET_ORIGIN.TICKETPULSE,
        status: { in: await statusService.statusNamesForBase(workspaceId, ['Open', 'Pending']) },
        updatedAt: { gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
        requester: { is: { email: { equals: sender, mode: 'insensitive' } } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (recent) return { ticket: recent, via: 'sender_recency' };

    return null;
  }

  /** Rung 1b lookup — OR over provider_message_id + message_id, falling back pre-RL-5. */
  async _findDeliveryByMessageIds(workspaceId, ids) {
    const select = { select: { ticketId: true }, orderBy: { id: 'desc' } };
    try {
      return await prisma.notificationDelivery.findFirst({
        where: { workspaceId, OR: [{ providerMessageId: { in: ids } }, { messageId: { in: ids } }] },
        ...select,
      });
    } catch (err) {
      logger.debug(`rung 1b: message_id column unavailable (${err.message?.split('\n')[0]}) — provider_message_id only`);
      return prisma.notificationDelivery.findFirst({
        where: { workspaceId, providerMessageId: { in: ids } },
        ...select,
      });
    }
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

  /**
   * A matched inbound message becomes a thread entry. Three shapes:
   *  • requester reply (default)      — authorType requester, incoming.
   *  • agent forward onto a ticket    — authorType agent (the forwarder),
   *    incoming (the content is the requester's), rawPayload.forwarded.
   *  • agent reply from Outlook with the mailbox in Cc — authorType agent,
   *    NOT incoming (already delivered by Outlook → deliveryState external,
   *    never re-sent), no reply_received event.
   */
  async ingestReply(connection, ticket, email, via, { agent = null, ctx = null } = {}) {
    const now = new Date();
    const recipients = emailRecipients(email);
    const isForward = Boolean(agent && ctx?.parsed?.isForward && ctx?.originalOk);
    const isAgentReply = Boolean(agent && !isForward);
    const forwardedMeta = isForward ? this._forwardedMeta(agent, email, ctx.parsed, { sliced: false }) : null;
    const rawPayload = {
      ...(recipients || {}),
      ...(isAgentReply ? { deliveryState: 'external', agentIntake: { kind: 'agent_reply_email', technicianId: agent.id, via } } : {}),
      ...(forwardedMeta ? { forwarded: forwardedMeta } : {}),
    };
    const entry = await prisma.ticketThreadEntry.create({
      data: {
        ticketId: ticket.id,
        workspaceId: ticket.workspaceId,
        externalEntryId: `graph-${email.id}`,
        source: 'email_inbound',
        eventType: 'reply',
        actorName: agent ? agent.name : (email.fromName || email.from),
        actorEmail: agent ? agent.email : email.from,
        authorType: agent ? 'agent' : 'requester',
        incoming: !isAgentReply,
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
        ...(Object.keys(rawPayload).length ? { rawPayload } : {}),
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
      activityType: isAgentReply ? 'agent_reply' : 'requester_reply',
      performedBy: agent ? agent.name : (email.fromName || email.from),
      performedAt: now,
      details: {
        via,
        emailMessageId: email.internetMessageId,
        source: 'email_inbound',
        entryId: entry.id,
        ...(isAgentReply ? { deliveryState: 'external', technicianId: agent.id, actorEmail: agent.email } : {}),
        ...(isForward ? {
          forwardedBy: agent.email, forwardedByTechnicianId: agent.id, originalFrom: forwardedMeta.originalFrom, originalDate: forwardedMeta.originalDate,
        } : {}),
      },
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

    // Workflow trigger: "Requester replied" (drives the seeded reopen
    // workflow). An agent's own Outlook reply is not a requester reply.
    if (!isAgentReply) {
      try {
        const { default: lifecycle } = await import('./ticketLifecycleNotificationService.js');
        await lifecycle.emitTicketEvent('ticket.reply_received', ticket.id, {
          source: 'email_inbound',
          dedupeStamp: `reply:${entry.id}`,
          extra: { entryId: entry.id, from: isForward ? forwardedMeta.originalFrom : email.from, via, ...(isForward ? { forwardedBy: agent.email } : {}) },
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
    }

    try {
      sseManager.broadcast('ticket-change', {
        action: 'reply',
        workspaceId: ticket.workspaceId,
        ticketId: ticket.id,
        origin: ticket.origin,
        displayRef: ticketDisplayRef(ticket),
        incoming: !isAgentReply,
        entryId: entry.id,
      }, ticket.workspaceId);
    } catch { /* non-fatal */ }

    logger.info(`Inbound email matched ${ticketDisplayRef(ticket)} via ${via} (from ${email.from}${agent ? `, agent ${agent.id}${isForward ? ' forward' : ' reply'}` : ''})`);
    return entry;
  }

  /** rawPayload.forwarded — the FW-3 data contract (no migration). */
  _forwardedMeta(agent, email, parsed, { sliced }) {
    const emails = (list) => (Array.isArray(list) ? list : []).map((a) => a?.email).filter(Boolean);
    return {
      kind: 'forward',
      byEmail: agent.email,
      byName: agent.name,
      byTechnicianId: agent.id,
      receivedAt: email.receivedAt instanceof Date ? email.receivedAt.toISOString() : (email.receivedAt || null),
      originalFrom: parsed.original.email,
      originalFromName: parsed.original.name || null,
      originalDate: parsed.original.date instanceof Date ? parsed.original.date.toISOString() : null,
      originalDateRaw: parsed.original.dateRaw || null,
      originalSubject: parsed.original.subject || null,
      originalTo: emails(parsed.original.to),
      originalCc: emails(parsed.original.cc),
      client: parsed.client,
      sliced,
      parser: PARSER_VERSION,
    };
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

  /**
   * New TP-born ticket from an unmatched message. `intake` (from
   * agentIntakeService.classifyIntake) picks the shape:
   *   forward  → requester = the quoted original sender (FW-3)
   *   agent_cc → requester = the external recipient, agent's words = first
   *              public agent reply (RL-3 rule 2)
   *   fresh / anything else → the sender is the requester (today's behaviour)
   */
  async createTicketFromEmail(connection, email, intake = null) {
    if (intake?.kind === 'forward') return this._createFromForward(connection, email, intake);
    if (intake?.kind === 'agent_cc') return this._createFromAgentCc(connection, email, intake);
    return this._createFresh(connection, email, intake);
  }

  _routingDefaults(connection) {
    return {
      // Mailbox→group routing: AP@ lands in the AP group, AR@ in AR, etc.
      ...(connection.defaultGroupId ? { groupId: connection.defaultGroupId.toString() } : {}),
      // Internal (TP-native) group routing — a mailbox can default into an internal group.
      ...(connection.defaultInternalGroupId ? { internalGroupId: connection.defaultInternalGroupId } : {}),
      ...(connection.defaultTicketType ? { ticketType: connection.defaultTicketType } : {}),
    };
  }

  _subjectFor(raw) {
    const subject = String(raw || '').trim() || '(no subject)';
    return subject.length >= 3 ? subject.slice(0, 500) : `Email: ${subject}`;
  }

  /**
   * Today's behaviour: the sender is the requester. The hold queue's "Create
   * ticket (for <address>)" action reuses this path with
   * `{ kind:'fresh', forcedRequester, createdVia:'held_reply', heldMessageId, resolvedBy }`:
   * forcedRequester wins over email.from, createdVia defaults to 'email'.
   */
  async _createFresh(connection, email, intake = null) {
    const subject = String(email.subject || '').trim() || '(no subject)';
    const forcedRequester = String(intake?.forcedRequester || '').trim().toLowerCase() || null;
    const createdVia = intake?.createdVia || 'email';
    const ticket = await ticketService.createTicket(connection.workspaceId, {
      subject: this._subjectFor(subject),
      description: email.bodyHtml || null,
      priority: 2,
      requesterEmail: forcedRequester || email.from,
      requesterName: forcedRequester ? null : (email.fromName || null),
      runAiTriage: true,
      ...this._routingDefaults(connection),
    }, SYSTEM_ACTOR, { sourceChannel: TICKET_SOURCE.EMAIL, createdVia });
    const heldReply = intake?.heldMessageId
      ? { heldMessageId: intake.heldMessageId, resolvedBy: intake.resolvedBy || null, ...(forcedRequester ? { forcedRequester } : {}) }
      : null;

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
          ...(recipients || heldReply ? { rawPayload: { ...(recipients || {}), ...(heldReply ? { heldReply } : {}) } } : {}),
        },
      }).catch(() => {});
    }

    // An agent's forward we could not parse (no header block, or the quoted
    // sender is the agent/mailbox/invalid): today's behaviour + a system
    // note + `forwarded_intake_unparsed` so the requester swap is one click.
    if (intake?.agent && intake?.decision?.rule === 'agent_forward_unparsed') {
      await this._noteUnparsedForward(connection, ticket, email, intake);
    }

    const attachmentNotice = await this._captureAttachments(connection, email, { id: ticket.id, workspaceId: connection.workspaceId });
    if (attachmentNotice) {
      logger.warn(`Attachment capture notice for ${ticket.displayRef}: ${attachmentNotice.trim()}`);
    }

    logger.info(`Inbound email created ${ticket.displayRef} (from ${email.from}: "${subject}"${intake?.decision?.rule ? `, rule ${intake.decision.rule}` : ''}${heldReply ? `, from held #${heldReply.heldMessageId} by ${heldReply.resolvedBy || '?'}${forcedRequester ? ` for ${forcedRequester}` : ''}` : ''})`);
    return ticket;
  }

  async _noteUnparsedForward(connection, ticket, email, intake) {
    const now = new Date();
    const reason = intake.decision?.details?.reason || 'no_header_block';
    const text = `Forwarded by ${intake.agent.name} (${intake.agent.email}) — Ticket Pulse could not identify the original sender (${reason.replace(/_/g, ' ')}), so the agent is the requester. Change the requester if this was forwarded on someone's behalf.`;
    const note = await prisma.ticketThreadEntry.create({
      data: {
        ticketId: ticket.id,
        workspaceId: connection.workspaceId,
        source: 'email_inbound',
        eventType: 'note',
        actorName: SYSTEM_ACTOR.name,
        actorEmail: SYSTEM_ACTOR.email,
        authorType: 'system',
        incoming: false,
        isPrivate: true,
        visibility: 'private',
        bodyText: text,
        content: text,
        occurredAt: now,
        title: 'Forwarded email — sender not identified',
        rawPayload: { agentIntake: { kind: 'forward_unparsed', technicianId: intake.agent.id, reason, client: intake.decision?.details?.client || null } },
      },
    }).catch(() => null);
    await ticketActivityRepository.create({
      ticketId: ticket.id,
      activityType: 'forwarded_intake_unparsed',
      performedBy: SYSTEM_ACTOR.name,
      performedAt: now,
      details: {
        source: 'email_inbound',
        actorEmail: SYSTEM_ACTOR.email,
        byEmail: intake.agent.email,
        byName: intake.agent.name,
        byTechnicianId: intake.agent.id,
        reason,
        parser: PARSER_VERSION,
        ...(note?.id ? { noteEntryId: note.id } : {}),
      },
    }).catch(() => {});
  }

  /** FW-3: an agent forwarded a requester's mail — the requester is the quoted sender. */
  async _createFromForward(connection, email, intake) {
    const { agent, parsed } = intake;
    const original = parsed.original;
    const subject = this._subjectFor(original.subject || agentIntake.stripSubject(email.subject));
    const sliced = Boolean(parsed.originalHtml || parsed.originalText);
    const description = parsed.originalHtml
      || (parsed.originalText ? textToHtml(parsed.originalText) : null)
      || email.bodyHtml
      || null;

    const ticket = await ticketService.createTicket(connection.workspaceId, {
      subject,
      description,
      priority: 2,
      requesterEmail: original.email,
      requesterName: original.name || null,
      runAiTriage: true,
      // ccEmails deliberately stays [] — agents are never Cc'd (d7).
      ...this._routingDefaults(connection),
    }, SYSTEM_ACTOR, { sourceChannel: TICKET_SOURCE.EMAIL, createdVia: 'forward' });

    const recipients = emailRecipients(email);
    if (recipients?.to_emails?.length) {
      await prisma.ticket.update({
        where: { id: ticket.id },
        data: { toEmails: recipients.to_emails },
      }).catch((err) => {
        logger.warn(`Email recipients not persisted for ${ticket.displayRef} (non-fatal): ${err.message}`);
      });
    }

    const forwarded = this._forwardedMeta(agent, email, parsed, { sliced });
    const originalRecipients = {
      ...(forwarded.originalTo.length ? { to_emails: forwarded.originalTo } : {}),
      ...(forwarded.originalCc.length ? { cc_emails: forwarded.originalCc } : {}),
    };
    const originalText = (parsed.originalText || '').slice(0, 4000) || email.bodyPreview || null;

    // The original email: actor = the requester, occurredAt = when they
    // wrote it; the forward's Message-ID stays here for dedupe / rung 1.
    const originalEntry = await prisma.ticketThreadEntry.create({
      data: {
        ticketId: ticket.id,
        workspaceId: connection.workspaceId,
        externalEntryId: `graph-${email.id}`,
        source: 'email_inbound',
        eventType: 'original_email',
        actorName: original.name || original.email,
        actorEmail: original.email,
        authorType: 'requester',
        incoming: true,
        isPrivate: false,
        visibility: 'public',
        bodyText: originalText,
        content: originalText,
        occurredAt: original.date || email.receivedAt || new Date(),
        ...(email.internetMessageId ? { emailMessageId: email.internetMessageId } : {}),
        title: 'Original email',
        rawPayload: { ...originalRecipients, forwarded },
      },
    }).catch((err) => {
      logger.warn(`Original-email entry not written for ${ticket.displayRef} (non-fatal): ${err.message}`);
      return null;
    });

    // The agent's covering note (private, agent-authored) when they wrote one.
    let noteEntry = null;
    const noteText = String(parsed.noteText || '').trim();
    if (noteText) {
      noteEntry = await prisma.ticketThreadEntry.create({
        data: {
          ticketId: ticket.id,
          workspaceId: connection.workspaceId,
          source: 'email_inbound',
          eventType: 'note',
          actorName: agent.name,
          actorEmail: agent.email,
          authorType: 'agent',
          incoming: false,
          isPrivate: true,
          visibility: 'private',
          bodyHtml: parsed.noteHtml || null,
          bodyText: noteText,
          content: noteText,
          occurredAt: email.receivedAt || new Date(),
          mirrorState: 'pending',
          title: 'Forwarding note',
          rawPayload: { forwarded, agentIntake: { kind: 'forward_note', technicianId: agent.id } },
        },
      }).catch((err) => {
        logger.warn(`Forwarding-note entry not written for ${ticket.displayRef} (non-fatal): ${err.message}`);
        return null;
      });
      if (noteEntry) await Promise.resolve(mirrorService.enqueueThreadEntry(connection.workspaceId, ticket.id, noteEntry.id)).catch(() => {});
    }

    await ticketActivityRepository.create({
      ticketId: ticket.id,
      activityType: 'forwarded_intake',
      performedBy: SYSTEM_ACTOR.name,
      performedAt: new Date(),
      details: {
        source: 'email_inbound',
        actorEmail: SYSTEM_ACTOR.email,
        byEmail: agent.email,
        byName: agent.name,
        byTechnicianId: agent.id,
        originalFrom: forwarded.originalFrom,
        originalFromName: forwarded.originalFromName,
        originalDate: forwarded.originalDate,
        originalSubject: forwarded.originalSubject,
        client: forwarded.client,
        sliced,
        parser: PARSER_VERSION,
        emailMessageId: email.internetMessageId,
        ...(originalEntry?.id ? { entryId: originalEntry.id } : {}),
        ...(noteEntry?.id ? { noteEntryId: noteEntry.id } : {}),
      },
    }).catch(() => {});

    const attachmentNotice = await this._captureAttachments(connection, email, { id: ticket.id, workspaceId: connection.workspaceId }, originalEntry?.id || null);
    if (attachmentNotice) {
      logger.warn(`Attachment capture notice for ${ticket.displayRef}: ${attachmentNotice.trim()}`);
    }

    logger.info(`Inbound forward created ${ticket.displayRef} for ${original.email} (forwarded by ${agent.email}, client ${parsed.client}, sliced ${sliced}: "${subject}")`);
    return ticket;
  }

  /**
   * RL-3 rule 2: an agent replied to (or wrote) a requester with the mailbox
   * in Cc. The requester is the external recipient, the quoted original (when
   * the parser found one) is the description, the agent's own words become
   * the first public agent reply — already delivered by Outlook, so it is
   * marked deliveryState:'external' and never re-sent. The agent is assigned
   * ("I'm on it"); the requester ack is suppressed.
   */
  async _createFromAgentCc(connection, email, intake) {
    const { agent, parsed, requester, quotedOriginal } = intake;
    const now = new Date();
    const subject = this._subjectFor(agentIntake.stripSubject(email.subject) || quotedOriginal?.subject || '');
    const description = quotedOriginal
      ? (quotedOriginal.html || (quotedOriginal.text ? textToHtml(quotedOriginal.text) : null))
      : (email.bodyHtml || (email.bodyText ? textToHtml(email.bodyText) : null));
    const agentHtml = parsed.hasHeaderBlock
      ? (parsed.noteHtml || (parsed.noteText ? textToHtml(parsed.noteText) : null))
      : email.bodyHtml;
    const agentText = parsed.hasHeaderBlock
      ? (parsed.noteText || null)
      : (email.bodyText || email.bodyPreview || null);
    const assign = agentIntake.agentCcIntakeEnabled(connection);
    const otherExternals = (intake.externals || []).filter((e) => e !== requester.email).slice(0, MAX_CC_EMAILS);

    const ticket = await ticketService.createTicket(connection.workspaceId, {
      subject,
      description: description || null,
      priority: 2,
      requesterEmail: requester.email,
      requesterName: requester.name || null,
      // The agent is on it: assign at creation (existing assign path — episode
      // + 'assigned' audit by SYSTEM_ACTOR); AI still classifies, never reassigns.
      ...(assign ? { assignedTechId: agent.id, runAiTriage: false, aiClassifyOnly: true } : { runAiTriage: true }),
      // The agent already replied — no "we received your request" ack.
      notifyRequester: true, // team 'Ticket arrived' still fires…
      suppressRequesterAck: true, // …but the requester already got the agent's reply — no second ack
      ...(otherExternals.length ? { ccEmails: otherExternals } : {}),
      ...this._routingDefaults(connection),
    }, SYSTEM_ACTOR, { sourceChannel: TICKET_SOURCE.EMAIL, createdVia: 'agent_cc' });

    const recipients = emailRecipients(email);
    if (recipients?.to_emails?.length) {
      await prisma.ticket.update({
        where: { id: ticket.id },
        data: { toEmails: recipients.to_emails },
      }).catch((err) => {
        logger.warn(`Email recipients not persisted for ${ticket.displayRef} (non-fatal): ${err.message}`);
      });
    }

    // The requester's original words (quoted by the agent) — no Message-ID
    // here: the mail's id belongs to the agent's reply below.
    let originalEntry = null;
    if (quotedOriginal) {
      const originalText = (quotedOriginal.text || '').slice(0, 4000) || null;
      originalEntry = await prisma.ticketThreadEntry.create({
        data: {
          ticketId: ticket.id,
          workspaceId: connection.workspaceId,
          source: 'email_inbound',
          eventType: 'original_email',
          actorName: requester.name || requester.email,
          actorEmail: requester.email,
          authorType: 'requester',
          incoming: true,
          isPrivate: false,
          visibility: 'public',
          bodyText: originalText,
          content: originalText,
          occurredAt: quotedOriginal.date || email.receivedAt || now,
          title: 'Original email (quoted by agent)',
          rawPayload: {
            agentIntake: { kind: 'agent_cc_original', technicianId: agent.id, quotedFrom: parsed.original.email, originalDateRaw: quotedOriginal.dateRaw || null, client: parsed.client, parser: PARSER_VERSION },
          },
        },
      }).catch((err) => {
        logger.warn(`Quoted-original entry not written for ${ticket.displayRef} (non-fatal): ${err.message}`);
        return null;
      });
    }

    // The agent's reply — FIRST PUBLIC AGENT REPLY, delivered by Outlook.
    const agentEntry = await prisma.ticketThreadEntry.create({
      data: {
        ticketId: ticket.id,
        workspaceId: connection.workspaceId,
        externalEntryId: `graph-${email.id}`,
        source: 'email_inbound',
        eventType: 'reply',
        actorName: agent.name,
        actorEmail: agent.email,
        authorType: 'agent',
        incoming: false,
        isPrivate: false,
        visibility: 'public',
        bodyHtml: agentHtml || null,
        bodyText: agentText,
        content: agentText,
        occurredAt: email.receivedAt || now,
        ...(email.internetMessageId ? { emailMessageId: email.internetMessageId } : {}),
        mirrorState: 'pending',
        rawPayload: {
          ...(recipients || {}),
          deliveryState: 'external',
          agentIntake: { kind: 'agent_cc', technicianId: agent.id, requester: requester.email, hasQuotedOriginal: Boolean(quotedOriginal), client: parsed.client, parser: PARSER_VERSION },
        },
      },
    }).catch((err) => {
      logger.warn(`Agent-reply entry not written for ${ticket.displayRef} (non-fatal): ${err.message}`);
      return null;
    });
    if (agentEntry) await Promise.resolve(mirrorService.enqueueThreadEntry(connection.workspaceId, ticket.id, agentEntry.id)).catch(() => {});

    await ticketActivityRepository.create({
      ticketId: ticket.id,
      activityType: 'agent_cc_intake',
      performedBy: SYSTEM_ACTOR.name,
      performedAt: now,
      details: {
        source: 'email_inbound',
        actorEmail: SYSTEM_ACTOR.email,
        byEmail: agent.email,
        byName: agent.name,
        byTechnicianId: agent.id,
        requester: requester.email,
        viaQuotedFrom: Boolean(intake.decision?.details?.viaQuotedFrom),
        assigned: assign,
        requesterAckSuppressed: true,
        externals: intake.externals || [],
        client: parsed.client,
        parser: PARSER_VERSION,
        emailMessageId: email.internetMessageId,
        ...(agentEntry?.id ? { entryId: agentEntry.id } : {}),
        ...(originalEntry?.id ? { originalEntryId: originalEntry.id } : {}),
      },
    }).catch(() => {});

    const attachmentNotice = await this._captureAttachments(connection, email, { id: ticket.id, workspaceId: connection.workspaceId }, agentEntry?.id || null);
    if (attachmentNotice) {
      logger.warn(`Attachment capture notice for ${ticket.displayRef}: ${attachmentNotice.trim()}`);
    }

    logger.info(`Agent-Cc intake created ${ticket.displayRef} for ${requester.email} (agent ${agent.email}${assign ? ', assigned' : ''}, quoted original ${Boolean(quotedOriginal)}: "${subject}")`);
    return ticket;
  }
}

export default new MailboxIngestService();
