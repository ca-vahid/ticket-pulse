import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ValidationError } from '../utils/errors.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import settingsRepository from './settingsRepository.js';
import {
  GROUP_MIN_ROWS, KIND_TICKET_LOOKBACK_HOURS, alertKindKey, groupHeldRows, isAttentionKind, kindLabel, kindTicketFor,
} from '../utils/heldAlertGroups.js';
import { noteAtCount } from './ticketGrouping/rules.js';

/**
 * Mailbox hold queue (MEGA 09-01 Phase RL, RL-4).
 *
 * Inbound mail the ingest decision table (mailboxIngestService) cannot safely
 * thread OR create from is parked here for a human: a reply whose
 * In-Reply-To/References point at mail Ticket Pulse never sent
 * (`unknown_reference`), an agent's reply with no identifiable external
 * requester (`agent_reply_no_requester`), a sender the ladder could not
 * attribute (`ambiguous_sender`), or any unmatched mail on a mailbox whose
 * policy is `replies_only` (`policy_replies_only`).
 *
 * Lifecycle: held → attached | created | discarded. Attach re-runs the
 * ordinary reply ingest (the row IS a reply, so `ticket.reply_received`
 * fires and `ticket.created` never does); Create runs the ordinary
 * new-ticket path with an optional forced requester (the address chooser
 * for `agent_reply_no_requester`). The mapped Graph email is stored on the
 * row (emailPayload + bodyHtml) so both re-hydrate the exact object the
 * ingest pipeline saw.
 *
 * Contract (the ingest service codes against these signatures):
 *   holdMessage(connection, email, { reason, bestGuessTicketId?, candidates?, decision? }) → { id }
 *   isKnownMessageId(workspaceId, ids[]) → boolean
 *   list(workspaceId, { status }) → rows
 *   attach(id, ticketId, actor) → { held, entry }
 *   createTicket(id, { requesterEmail?, actor }) → { held, ticket }
 *   discard(id, actor) → held
 */

export const HOLD_REASONS = Object.freeze([
  'unknown_reference',
  'agent_reply_no_requester',
  'ambiguous_sender',
  'policy_replies_only',
  'ambiguous_ticket', // two or more FreshService tickets match the sender + subject (23 Sep 2026)
  'sender_burst', // helpdesk mailbox: more new mail from one sender in a cycle than the cap; never dropped
  'ingest_error', // helpdesk mailbox: creating the ticket or the reply failed; a person decides, nothing is lost
]);

export const HOLD_STATUSES = Object.freeze(['held', 'attached', 'created', 'discarded']);

export const NEW_TICKET_POLICIES = Object.freeze(['create', 'replies_only', 'hold_unmatched']);

/**
 * Repeat alerts in a burst (QA 10-26 #3), per workspace:
 *   off     every extra mail is held on its own (the behaviour before)
 *   shadow  still held, but the row says which ticket it would have joined (default)
 *   on      a mail whose alert kind already has a ticket from the same device in
 *           the last 24 hours is counted on that ticket instead of held. A new
 *           kind, and a broken-sounding kind whose ticket is closed, stay held.
 */
export const BURST_FOLD_MODES = Object.freeze(['off', 'shadow', 'on']);
export const DEFAULT_BURST_FOLD_MODE = 'shadow';
export const burstFoldKey = (workspaceId) => `mailbox_burst_fold_ws${Number(workspaceId)}`;
const BULK_MAX = 500;
const GROUP_TICKET_LOOKBACK_HOURS = 7 * 24;

const SNIPPET_MAX = 500;
const SYSTEM_ACTOR = { email: 'mailbox@ticketpulse.internal', name: 'Ticket Pulse Mail', role: 'system', technicianId: null };
const FOLD_ACTOR = { email: 'mailbox@ticketpulse.internal', name: 'Ticket Pulse burst grouping', role: 'system', technicianId: null };

function normalizeAddressList(list) {
  return [...new Set(
    (Array.isArray(list) ? list : [])
      .map((s) => String(s || '').trim().toLowerCase())
      .filter((s) => s.includes('@')),
  )];
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** ≤500-char preview for the review card. */
export function snippetFor(email) {
  const raw = email?.bodyPreview || email?.bodyText || stripHtml(email?.bodyHtml) || '';
  return String(raw).replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX) || null;
}

/** Stable per-connection key even when Graph hands us no RFC Message-ID. */
export function heldMessageKey(email) {
  const mid = String(email?.internetMessageId || '').trim();
  if (mid) return mid.slice(0, 255);
  return `graph:${String(email?.id || '').trim() || 'unknown'}`.slice(0, 255);
}

function actorLabel(actor) {
  return String(actor?.email || actor?.name || 'system').slice(0, 255);
}

/**
 * The email object stored on the row: everything the ingest pipeline reads
 * (graphMailClient.mapGraphMessageForIngest shape) minus the HTML body,
 * which has its own column. Dates are ISO strings in JSON; rehydrate() puts
 * them back.
 */
function serializeEmail(email) {
  if (!email || typeof email !== 'object') return null;
  const rest = { ...email };
  delete rest.bodyHtml; // own column
  const out = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined || typeof value === 'function') continue;
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

function rehydrateEmail(row) {
  const payload = row?.emailPayload && typeof row.emailPayload === 'object' ? { ...row.emailPayload } : {};
  const email = {
    id: payload.id || null,
    subject: payload.subject ?? row.subject ?? '',
    from: payload.from ?? row.fromEmail ?? '',
    fromName: payload.fromName ?? row.fromName ?? '',
    to: Array.isArray(payload.to) ? payload.to : (Array.isArray(row.toEmails) ? row.toEmails : []),
    cc: Array.isArray(payload.cc) ? payload.cc : (Array.isArray(row.ccEmails) ? row.ccEmails : []),
    bodyPreview: payload.bodyPreview ?? row.snippet ?? '',
    bodyText: payload.bodyText ?? null,
    conversationId: payload.conversationId ?? null,
    internetMessageId: payload.internetMessageId ?? (row.internetMessageId?.startsWith('graph:') ? null : row.internetMessageId),
    hasAttachments: payload.hasAttachments === true,
    inReplyTo: payload.inReplyTo ?? null,
    references: payload.references ?? null,
    autoSubmitted: payload.autoSubmitted ?? null,
    precedence: payload.precedence ?? null,
    deliveredTo: payload.deliveredTo ?? null,
    xOriginalTo: payload.xOriginalTo ?? null,
    ...payload,
    bodyHtml: row.bodyHtml ?? null,
    receivedAt: payload.receivedAt ? new Date(payload.receivedAt) : (row.receivedAt ? new Date(row.receivedAt) : null),
  };
  return email;
}

function presentHeld(row) {
  if (!row) return row;
  const { connection, bestGuessTicket, resolvedTicket, ...rest } = row;
  const hasBody = Boolean(rest.bodyHtml);
  delete rest.bodyHtml; // never ship the raw body / payload to the list
  delete rest.emailPayload;
  return {
    ...rest,
    hasBody,
    connectionAddress: connection?.address || null,
    bestGuessTicket: bestGuessTicket ? {
      id: bestGuessTicket.id,
      displayRef: ticketDisplayRef(bestGuessTicket),
      subject: bestGuessTicket.subject,
      status: bestGuessTicket.status,
    } : null,
    resolvedTicket: resolvedTicket ? {
      id: resolvedTicket.id,
      displayRef: ticketDisplayRef(resolvedTicket),
      subject: resolvedTicket.subject,
    } : null,
  };
}

const TICKET_SUMMARY_SELECT = { id: true, nativeNumber: true, freshserviceTicketId: true, origin: true, subject: true, status: true };

class MailboxHoldService {
  /**
   * A mail the ingest deliberately ignored (loop mail, the mailbox's own mail, "FreshService has it").
   * Until 12 Oct 2026 a skip left only a debug log line, so nobody could see what was ignored or why.
   * Stored beside held mail with status 'skipped': never in the hold queue, never in its digest,
   * and it can still be turned into a ticket from the row. Idempotent; never throws.
   */
  async recordSkipped(connection, email, reason) {
    if (!connection?.id || !connection?.workspaceId) return null;
    try {
      const key = heldMessageKey(email);
      const existing = await prisma.mailboxHeldMessage.findFirst({ where: { connectionId: connection.id, internetMessageId: key }, select: { id: true } });
      if (existing) return { id: existing.id, duplicate: true };
      const row = await prisma.mailboxHeldMessage.create({
        data: {
          workspaceId: connection.workspaceId,
          connectionId: connection.id,
          internetMessageId: key,
          fromEmail: String(email?.from || '').trim().toLowerCase().slice(0, 255) || null,
          fromName: String(email?.fromName || '').trim().slice(0, 255) || null,
          toEmails: normalizeAddressList(email?.to),
          ccEmails: normalizeAddressList(email?.cc),
          subject: String(email?.subject || '').trim() || null,
          snippet: snippetFor(email),
          bodyHtml: email?.bodyHtml || null,
          emailPayload: serializeEmail(email),
          receivedAt: email?.receivedAt ? new Date(email.receivedAt) : new Date(),
          reason: String(reason || 'skipped').slice(0, 40),
          status: 'skipped',
        },
        select: { id: true },
      });
      return { id: row.id, duplicate: false };
    } catch (err) {
      logger.warn(`mailboxHoldService: skipped mail not recorded (${err.message})`);
      return null;
    }
  }

  /**
   * Park an inbound email. Idempotent on (connectionId, internetMessageId):
   * a second hold for the same mail (poller + webhook, retries) returns the
   * existing row untouched — including its status, so a resolved row is
   * never re-opened by a late duplicate.
   */
  async holdMessage(connection, email, { reason, bestGuessTicketId = null, candidates = null, decision = null } = {}) {
    if (!connection?.id || !connection?.workspaceId) throw new ValidationError('A mailbox connection is required to hold a message');
    const holdReason = HOLD_REASONS.includes(reason) ? reason : 'unknown_reference';
    if (reason && holdReason !== reason) {
      logger.warn(`mailboxHoldService: unknown hold reason "${reason}" stored as unknown_reference`);
    }
    const key = heldMessageKey(email);
    const existing = await prisma.mailboxHeldMessage.findFirst({
      where: { connectionId: connection.id, internetMessageId: key },
      select: { id: true, status: true },
    });
    if (existing) return { id: existing.id, status: existing.status, duplicate: true };

    const to = normalizeAddressList(email?.to);
    const cc = normalizeAddressList(email?.cc);
    const data = {
      workspaceId: connection.workspaceId,
      connectionId: connection.id,
      internetMessageId: key,
      fromEmail: String(email?.from || '').trim().toLowerCase().slice(0, 255) || null,
      fromName: String(email?.fromName || '').trim().slice(0, 255) || null,
      toEmails: to,
      ccEmails: cc,
      subject: String(email?.subject || '').trim() || null,
      snippet: snippetFor(email),
      bodyHtml: email?.bodyHtml || null,
      emailPayload: serializeEmail(email),
      receivedAt: email?.receivedAt ? new Date(email.receivedAt) : new Date(),
      reason: holdReason,
      bestGuessTicketId: Number.isInteger(Number(bestGuessTicketId)) && Number(bestGuessTicketId) > 0 ? Number(bestGuessTicketId) : null,
      candidates: Array.isArray(candidates) ? normalizeAddressList(candidates) : (candidates ?? null),
      decision: decision ?? null,
      status: 'held',
    };
    try {
      const row = await prisma.mailboxHeldMessage.create({ data, select: { id: true, status: true } });
      logger.info(`Mailbox ingest HELD "${data.subject || '(no subject)'}" from ${data.fromEmail} (${holdReason}) as held #${row.id}`);
      const fold = holdReason === 'sender_burst' ? await this._burstFold(connection, row.id, data) : null;
      return { id: row.id, status: fold?.status || row.status, duplicate: false, ...(fold ? { fold: fold.fold } : {}) };
    } catch (err) {
      // Lost the race against a concurrent hold of the same message.
      if (err?.code === 'P2002') {
        const again = await prisma.mailboxHeldMessage.findFirst({
          where: { connectionId: connection.id, internetMessageId: key },
          select: { id: true, status: true },
        });
        if (again) return { id: again.id, status: again.status, duplicate: true };
      }
      throw err;
    }
  }

  /**
   * Does Ticket Pulse know ANY of these RFC Message-IDs? Checks every place
   * an id we sent or received lives: thread entries (inbound mail + our
   * replies), notification deliveries (workflow/ack mail — RL-5 message_id
   * and the legacy provider_message_id) and the hold queue itself. The
   * ingest decision table uses "every referenced id is unknown" as the
   * agent-initiated-intake signal.
   */
  async isKnownMessageId(workspaceId, ids) {
    const wanted = [...new Set((Array.isArray(ids) ? ids : [ids])
      .map((v) => String(v || '').trim())
      .filter(Boolean))];
    if (!wanted.length || !workspaceId) return false;
    const wsId = Number(workspaceId);
    const [entry, delivery, held] = await Promise.all([
      prisma.ticketThreadEntry.findFirst({
        where: { workspaceId: wsId, emailMessageId: { in: wanted } },
        select: { id: true },
      }),
      prisma.notificationDelivery.findFirst({
        where: {
          workspaceId: wsId,
          OR: [{ messageId: { in: wanted } }, { providerMessageId: { in: wanted } }],
        },
        select: { id: true },
      }),
      prisma.mailboxHeldMessage.findFirst({
        where: { workspaceId: wsId, internetMessageId: { in: wanted } },
        select: { id: true },
      }),
    ]);
    return Boolean(entry || delivery || held);
  }

  async list(workspaceId, { status = 'held', limit = 200 } = {}) {
    const where = { workspaceId: Number(workspaceId) };
    if (status && status !== 'all') {
      where.status = HOLD_STATUSES.includes(status) ? status : 'held';
    }
    const rows = await prisma.mailboxHeldMessage.findMany({
      where,
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(Number(limit) || 200, 1), 500),
      include: {
        connection: { select: { address: true } },
      },
    });
    // Hydrate the best-guess / resolved tickets in one query each (no relation
    // on the model — the ids are hints, not FKs, so a deleted ticket never
    // orphans a held row).
    const ticketIds = [...new Set(rows.flatMap((r) => [r.bestGuessTicketId, r.resolvedTicketId]).filter(Boolean))];
    const tickets = ticketIds.length
      ? await prisma.ticket.findMany({ where: { id: { in: ticketIds }, workspaceId: Number(workspaceId) }, select: TICKET_SUMMARY_SELECT })
      : [];
    const byId = new Map(tickets.map((t) => [t.id, t]));
    return rows.map((row) => presentHeld({
      ...row,
      bestGuessTicket: row.bestGuessTicketId ? byId.get(row.bestGuessTicketId) || null : null,
      resolvedTicket: row.resolvedTicketId ? byId.get(row.resolvedTicketId) || null : null,
    }));
  }

  /**
   * One held message with what a person needs to decide (17 Oct 2026, the
   * Tickets popup): the list row plus the email itself — sanitized HTML (the
   * page shows it in a sandboxed frame) and plain text — and a fuller look at
   * the best-guess ticket (requester, when it was opened, last activity).
   */
  async get(id, workspaceId) {
    const row = await prisma.mailboxHeldMessage.findFirst({
      where: { id: Number(id), workspaceId: Number(workspaceId) },
      include: { connection: { select: { address: true } } },
    });
    if (!row) throw new ValidationError('Held message not found');
    const ids = [row.bestGuessTicketId, row.resolvedTicketId].filter(Boolean);
    const tickets = ids.length
      ? await prisma.ticket.findMany({
        where: { id: { in: ids }, workspaceId: Number(workspaceId) },
        select: { ...TICKET_SUMMARY_SELECT, createdAt: true, updatedAt: true, requester: { select: { name: true, email: true } }, assignedTech: { select: { name: true } } },
      })
      : [];
    const byId = new Map(tickets.map((t) => [t.id, t]));
    const best = row.bestGuessTicketId ? byId.get(row.bestGuessTicketId) || null : null;
    const payload = row.emailPayload && typeof row.emailPayload === 'object' ? row.emailPayload : {};
    const { default: sanitizeHtml } = await import('sanitize-html');
    const { EMAIL_SANITIZE_OPTIONS } = await import('./notificationWorkflowSignatureService.js');
    const bodyHtml = row.bodyHtml ? sanitizeHtml(row.bodyHtml, EMAIL_SANITIZE_OPTIONS) : null;
    const presented = presentHeld({
      ...row,
      bestGuessTicket: best,
      resolvedTicket: row.resolvedTicketId ? byId.get(row.resolvedTicketId) || null : null,
    });
    return {
      ...presented,
      bodyHtml,
      bodyText: typeof payload.bodyText === 'string' ? payload.bodyText.slice(0, 50000) : (presented.snippet || null),
      hasAttachments: payload.hasAttachments === true,
      bestGuessTicket: presented.bestGuessTicket && best ? {
        ...presented.bestGuessTicket,
        createdAt: best.createdAt,
        updatedAt: best.updatedAt,
        requesterName: best.requester?.name || null,
        requesterEmail: best.requester?.email || null,
        assigneeName: best.assignedTech?.name || null,
      } : presented.bestGuessTicket,
    };
  }

  async count(workspaceId, status = 'held') {
    return prisma.mailboxHeldMessage.count({ where: { workspaceId: Number(workspaceId), status } });
  }

  // ---- alert bursts grouped by device (QA 10-26 #3) --------------------------

  async getBurstFoldMode(workspaceId) {
    const raw = await Promise.resolve().then(() => settingsRepository.get(burstFoldKey(workspaceId))).catch(() => null);
    const mode = String(raw || '').trim().toLowerCase();
    return BURST_FOLD_MODES.includes(mode) ? mode : DEFAULT_BURST_FOLD_MODE;
  }

  async setBurstFoldMode(workspaceId, mode) {
    const next = String(mode || '').trim().toLowerCase();
    if (!BURST_FOLD_MODES.includes(next)) throw new ValidationError(`mode must be one of ${BURST_FOLD_MODES.join(', ')}`);
    await settingsRepository.set(burstFoldKey(workspaceId), next);
    return next;
  }

  /** Tickets the given senders opened in the last `hours`, newest first, with displayRef + requesterEmail. Never throws. */
  async _recentSenderTickets(workspaceId, senders, hours) {
    const list = [...new Set((senders || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean))].slice(0, 50);
    if (!list.length) return [];
    const rows = await Promise.resolve().then(() => prisma.ticket.findMany({
      where: {
        workspaceId: Number(workspaceId),
        createdAt: { gte: new Date(Date.now() - hours * 60 * 60 * 1000) },
        status: { notIn: ['Deleted', 'Spam'] },
        OR: list.map((email) => ({ requester: { is: { email: { equals: email, mode: 'insensitive' } } } })),
      },
      select: { ...TICKET_SUMMARY_SELECT, createdAt: true, occurrenceCount: true, requester: { select: { email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 300,
    })).then((r) => (Array.isArray(r) ? r : [])).catch((err) => {
      logger.warn(`mailboxHoldService: recent sender tickets lookup failed (non-fatal): ${err.message}`);
      return [];
    });
    return rows.map((t) => ({ ...t, displayRef: ticketDisplayRef(t), requesterEmail: t.requester?.email || null }));
  }

  /**
   * The held queue as the review screens show it: one group per device that
   * sent three or more held mails (alert kinds inside, broken-sounding and new
   * kinds first), and every other row as before.
   */
  async listGroups(workspaceId, { limit = 500 } = {}) {
    const rows = await this.list(workspaceId, { status: 'held', limit });
    const senders = [...new Set(rows.map((r) => r.fromEmail).filter(Boolean))];
    const counts = senders.map((s) => [s, rows.filter((r) => r.fromEmail === s).length]);
    const busy = counts.filter(([, n]) => n >= GROUP_MIN_ROWS).map(([s]) => s);
    const tickets = busy.length ? await this._recentSenderTickets(workspaceId, busy, GROUP_TICKET_LOOKBACK_HOURS) : [];
    const { groups, singles } = groupHeldRows(rows, { tickets });
    return { groups, singles, total: rows.length, mode: await this.getBurstFoldMode(workspaceId) };
  }

  /** occurrence_count / last_occurrence_* on the ticket the alerts were counted on (the AlertOccurrenceStrip reads them). */
  async _countOccurrences(ticketId, added, { lastAt, summary }) {
    const n = Math.max(0, Number(added) || 0);
    if (!n) return null;
    const current = await prisma.ticket.findUnique({ where: { id: Number(ticketId) }, select: { occurrenceCount: true, lastOccurrenceAt: true } });
    if (!current) return null;
    const count = (current.occurrenceCount > 0 ? current.occurrenceCount : 1) + n;
    const latest = current.lastOccurrenceAt && lastAt && new Date(current.lastOccurrenceAt) > new Date(lastAt) ? current.lastOccurrenceAt : (lastAt || new Date());
    await prisma.ticket.update({
      where: { id: Number(ticketId) },
      data: { occurrenceCount: count, lastOccurrenceAt: latest, lastOccurrenceSummary: String(summary || '').slice(0, 290) || null },
    });
    return count;
  }

  /**
   * A sender_burst row just written: does its alert kind already have a ticket
   * from the same device in the last 24 hours? Shadow records the answer on the
   * row (and makes that ticket the best guess); On counts the mail on the
   * ticket and files the row as attached. A first occurrence never gets here
   * (it became a ticket under the cap), a new kind finds no ticket, and a
   * broken-sounding kind whose ticket is closed stays held. Never throws.
   */
  async _burstFold(connection, rowId, data) {
    try {
      const mode = await this.getBurstFoldMode(connection.workspaceId);
      if (mode === 'off' || !data?.fromEmail) return null;
      const kindKey = alertKindKey(data.subject);
      if (!kindKey || kindKey.length < 8) return null;
      const attention = isAttentionKind(data.subject);
      const tickets = await this._recentSenderTickets(connection.workspaceId, [data.fromEmail], KIND_TICKET_LOOKBACK_HOURS);
      const target = kindTicketFor({ kindKey, attention, tickets });
      if (!target) return null;
      const fold = { mode, ticketId: target.id, displayRef: target.displayRef, kind: kindLabel([data.subject]) };
      const decision = { ...(data.decision || {}), details: { ...(data.decision?.details || {}), fold } };
      if (mode === 'shadow') {
        await prisma.mailboxHeldMessage.update({ where: { id: rowId }, data: { decision, bestGuessTicketId: target.id } });
        logger.info(`Burst grouping (shadow): held #${rowId} would have been counted on ${target.displayRef}`);
        return { status: 'held', fold };
      }
      await prisma.mailboxHeldMessage.update({
        where: { id: rowId },
        data: {
          decision, bestGuessTicketId: target.id, status: 'attached', resolvedTicketId: target.id,
          resolvedBy: FOLD_ACTOR.name, resolvedAt: new Date(),
        },
      });
      const count = await this._countOccurrences(target.id, 1, { lastAt: data.receivedAt, summary: data.subject }).catch(() => null);
      if (count && noteAtCount(count)) {
        const { default: ticketService } = await import('./ticketService.js');
        await ticketService.addPrivateNote(target.id, connection.workspaceId, {
          bodyText: `This alert has now arrived ${count} times from ${data.fromEmail}. The repeats came in a burst, so Ticket Pulse counted them here instead of holding each one for review. Each email is kept under Settings, Ticket Mailboxes, Unmatched replies (attached).`,
        }, FOLD_ACTOR, [], { systemNote: true }).catch((err) => logger.warn(`Burst grouping note on ${target.displayRef} failed (non-fatal): ${err.message}`));
      }
      logger.info(`Burst grouping: held #${rowId} counted on ${target.displayRef}${count ? ` (seen ${count} times)` : ''}`);
      return { status: 'attached', fold };
    } catch (err) {
      logger.warn(`Burst grouping skipped for held #${rowId} (non-fatal): ${err.message}`);
      return null;
    }
  }

  /**
   * One decision for many held mails ("attach all to TP-x", "discard all").
   * Attach of a single mail is the ordinary reply attach; attach of several
   * writes ONE internal note on the ticket listing what arrived (kinds and
   * counts) and counts them there — sixty alerts never become sixty replies,
   * sixty FreshService notes or sixty "reply received" workflow runs. The
   * emails themselves stay on their rows (status attached).
   */
  async bulk(workspaceId, ids, action, { ticketId = null, actor } = {}) {
    if (!['attach', 'discard'].includes(action)) throw new ValidationError('action must be attach or discard');
    const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!wanted.length) throw new ValidationError('ids are required');
    if (wanted.length > BULK_MAX) throw new ValidationError(`At most ${BULK_MAX} emails at a time`);
    const rows = await prisma.mailboxHeldMessage.findMany({
      where: { id: { in: wanted }, workspaceId: Number(workspaceId), status: 'held' },
      select: { id: true, subject: true, fromEmail: true, receivedAt: true },
      orderBy: { receivedAt: 'asc' },
    });
    if (!rows.length) throw new ValidationError('These emails were already dealt with');
    const rowIds = rows.map((r) => r.id);
    const stamp = { resolvedBy: actorLabel(actor), resolvedAt: new Date() };

    if (action === 'discard') {
      const res = await prisma.mailboxHeldMessage.updateMany({ where: { id: { in: rowIds }, status: 'held' }, data: { status: 'discarded', ...stamp } });
      logger.info(`Held messages discarded in bulk by ${actorLabel(actor)}: ${res.count}`);
      return { action, count: res.count };
    }

    const ticket = await prisma.ticket.findFirst({ where: { id: Number(ticketId), workspaceId: Number(workspaceId) }, select: TICKET_SUMMARY_SELECT });
    if (!ticket) throw new ValidationError('Ticket not found in this workspace');
    if (String(ticket.status) === 'Deleted') throw new ValidationError('That ticket was deleted');
    const ref = ticketDisplayRef(ticket);
    if (rows.length === 1) {
      const one = await this.attach(rows[0].id, ticket.id, actor, { workspaceId });
      return { action, count: 1, ticket: one.ticket };
    }

    const tz = await this._workspaceTimeZone(workspaceId);
    const kinds = new Map();
    for (const r of rows) {
      const key = alertKindKey(r.subject);
      if (!kinds.has(key)) kinds.set(key, []);
      kinds.get(key).push(r.subject);
    }
    const senders = [...new Set(rows.map((r) => r.fromEmail).filter(Boolean))];
    const lines = [...kinds.values()].sort((a, b) => b.length - a.length).slice(0, 20).map((subs) => `- ${subs.length} × ${kindLabel(subs)}`);
    const text = [
      `${rows.length} held emails from ${senders.slice(0, 3).join(', ') || 'one sender'} were added here from Unmatched replies by ${actor?.name || actorLabel(actor)}.`,
      `They arrived between ${formatWhen(rows[0].receivedAt, tz)} and ${formatWhen(rows[rows.length - 1].receivedAt, tz)}.`,
      '',
      ...lines,
      ...(kinds.size > 20 ? [`- and ${kinds.size - 20} more kinds`] : []),
    ].join('\n');
    const { default: ticketService } = await import('./ticketService.js');
    await ticketService.addPrivateNote(ticket.id, Number(workspaceId), { bodyText: text }, actor || SYSTEM_ACTOR, [], { systemNote: true });
    const res = await prisma.mailboxHeldMessage.updateMany({
      where: { id: { in: rowIds }, status: 'held' },
      data: { status: 'attached', resolvedTicketId: ticket.id, ...stamp },
    });
    const last = rows[rows.length - 1];
    await this._countOccurrences(ticket.id, res.count, { lastAt: last.receivedAt, summary: last.subject })
      .catch((err) => logger.warn(`Bulk attach: occurrence count on ${ref} failed (non-fatal): ${err.message}`));
    logger.info(`Held messages attached in bulk to ${ref} by ${actorLabel(actor)}: ${res.count}`);
    return { action, count: res.count, ticket: { id: ticket.id, displayRef: ref } };
  }

  async _workspaceTimeZone(workspaceId) {
    const ws = await Promise.resolve().then(() => prisma.workspace.findUnique({ where: { id: Number(workspaceId) }, select: { name: true, defaultTimezone: true } })).catch(() => null);
    return ws?.defaultTimezone || 'America/Vancouver';
  }

  async _requireHeld(id, workspaceId) {
    const row = await prisma.mailboxHeldMessage.findFirst({
      where: { id: Number(id), ...(workspaceId ? { workspaceId: Number(workspaceId) } : {}) },
      include: { connection: true },
    });
    if (!row) throw new ValidationError('Held message not found');
    if (row.status !== 'held') throw new ValidationError(`This message was already ${row.status}`);
    if (!row.connection) throw new ValidationError('The mailbox this message arrived on is no longer connected');
    return row;
  }

  async _resolve(id, { status, actor, ticketId = null }) {
    return prisma.mailboxHeldMessage.update({
      where: { id: Number(id) },
      data: {
        status,
        resolvedBy: actorLabel(actor),
        resolvedAt: new Date(),
        resolvedTicketId: ticketId ? Number(ticketId) : null,
      },
    });
  }

  /**
   * Attach the held mail to an existing ticket as a reply: runs the ordinary
   * reply ingest (thread entry + Cc merge + attachments + FS mirror + SSE +
   * `ticket.reply_received`). `ticket.created` never fires here — attach is
   * a reply, not a create.
   */
  async attach(id, ticketId, actor, { workspaceId = null } = {}) {
    const held = await this._requireHeld(id, workspaceId);
    const ticket = await prisma.ticket.findFirst({
      where: { id: Number(ticketId), workspaceId: held.workspaceId },
      include: { requester: { select: { id: true, email: true, name: true } } },
    });
    if (!ticket) throw new ValidationError('Ticket not found in this workspace');
    if (String(ticket.status) === 'Deleted') throw new ValidationError('That ticket was deleted');

    const { default: mailboxIngestService } = await import('./mailboxIngestService.js');
    const email = rehydrateEmail(held);
    const entry = await mailboxIngestService.ingestReply(held.connection, ticket, email, 'held_reply_attach');
    const updated = await this._resolve(held.id, { status: 'attached', actor, ticketId: ticket.id });
    logger.info(`Held message #${held.id} attached to ${ticketDisplayRef(ticket)} by ${actorLabel(actor)}`);
    return { held: presentHeld(updated), entry, ticket: { id: ticket.id, displayRef: ticketDisplayRef(ticket) } };
  }

  /**
   * Create a new ticket from the held mail through the ordinary new-ticket
   * path. `requesterEmail` (the "Create ticket for <address>" chooser) is
   * passed as `forcedRequester`; the ingest service otherwise takes the
   * sender. Tagged `createdVia: 'held_reply'` for workflow conditions.
   */
  async createTicket(id, { requesterEmail = null, actor, workspaceId = null } = {}) {
    const held = await this._requireHeld(id, workspaceId);
    const forcedRequester = String(requesterEmail || '').trim().toLowerCase() || null;
    if (forcedRequester && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(forcedRequester)) {
      throw new ValidationError('requesterEmail must be a valid email address');
    }

    const { default: mailboxIngestService } = await import('./mailboxIngestService.js');
    const email = rehydrateEmail(held);
    const ticket = await mailboxIngestService.createTicketFromEmail(held.connection, email, {
      kind: 'fresh',
      forcedRequester,
      createdVia: 'held_reply',
      heldMessageId: held.id,
      resolvedBy: actorLabel(actor),
    });
    const updated = await this._resolve(held.id, { status: 'created', actor, ticketId: ticket?.id || null });
    logger.info(`Held message #${held.id} became ${ticket?.displayRef || ticketDisplayRef(ticket || {})} by ${actorLabel(actor)}${forcedRequester ? ` (requester ${forcedRequester})` : ''}`);
    return { held: presentHeld(updated), ticket };
  }

  async discard(id, actor, { workspaceId = null } = {}) {
    const held = await this._requireHeld(id, workspaceId);
    const updated = await this._resolve(held.id, { status: 'discarded', actor });
    logger.info(`Held message #${held.id} discarded by ${actorLabel(actor)}`);
    return presentHeld(updated);
  }

  /**
   * Workspace admins for the daily digest: workspace_access rows with role
   * admin, else the global admin_emails setting / ADMIN_EMAILS env.
   */
  async _digestRecipients(workspaceId) {
    const { reportRecipients } = await import('./reportRecipients.js');
    return reportRecipients(workspaceId);
  }

  /**
   * Daily digest (RL-4): one email per workspace whose hold queue is
   * non-empty, to that workspace's admins. Rides the scheduler's 08:00 job.
   * Never throws.
   */
  async sendDailyDigests({ appUrl = process.env.FRONTEND_URL || process.env.APP_URL || '' } = {}) {
    const sent = [];
    try {
      const grouped = await prisma.mailboxHeldMessage.groupBy({
        by: ['workspaceId'],
        where: { status: 'held' },
        _count: { _all: true },
      });
      if (!grouped.length) return { sent };
      const { sendTransactionalEmail } = await import('./transactionalEmailService.js');
      for (const group of grouped) {
        const workspaceId = group.workspaceId;
        const count = group._count._all;
        const to = await this._digestRecipients(workspaceId);
        if (!to.length) {
          logger.warn(`Mailbox hold digest: workspace ${workspaceId} has ${count} held message(s) but no admin recipients`);
          continue;
        }
        // Grouped per device (QA 10-26 #3): 103 flat lines from two NAS units
        // became two paragraphs. Plain e-mail style, every colour explicit.
        const { groups, singles } = await this.listGroups(workspaceId);
        const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true, defaultTimezone: true } }).catch(() => null);
        const link = appUrl ? `${String(appUrl).replace(/\/$/, '')}/settings#ticket-mailboxes` : 'Settings → Ticket Mailboxes → Unmatched replies';
        const { subject, html } = buildHoldDigest({
          workspaceName: workspace?.name || `Workspace ${workspaceId}`,
          count,
          groups,
          singles,
          link,
          linkIsUrl: Boolean(appUrl),
          timeZone: workspace?.defaultTimezone || 'America/Vancouver',
        });
        const result = await sendTransactionalEmail({
          workspaceId,
          to,
          subject,
          html,
          label: 'mailbox-hold-digest',
        });
        sent.push({ workspaceId, count, recipients: to.length, sent: result.sent === true, via: result.via || null });
      }
    } catch (err) {
      logger.warn(`Mailbox hold digest failed (non-fatal): ${err.message}`);
    }
    return { sent };
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** "Fri 23 Oct, 08:52" in the workspace's time zone (the digest used to print the server's UTC). */
export function formatWhen(value, timeZone = 'America/Vancouver') {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map((p) => [p.type, p.value]));
    return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`;
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** "Fri 23 Oct, 08:53 to 09:52", or two full stamps across midnight. */
export function formatSpan(from, to, timeZone = 'America/Vancouver') {
  const a = formatWhen(from, timeZone);
  const b = formatWhen(to, timeZone);
  if (!a || a === b) return a || b;
  const [dayA, timeA] = a.split(', ');
  const [dayB, timeB] = b.split(', ');
  return dayA === dayB ? `${dayA}, ${timeA} to ${timeB}` : `${a} to ${b}`;
}

const REASON_WORDS = {
  unknown_reference: 'answers mail Ticket Pulse never saw',
  agent_reply_no_requester: 'agent mail, no requester',
  ambiguous_sender: 'sender unclear',
  policy_replies_only: 'mailbox takes replies only',
  ambiguous_ticket: 'two tickets match',
  sender_burst: 'burst from one sender',
  ingest_error: 'could not be filed',
};

const FONT = "font-family:Calibri,'Segoe UI',Arial,sans-serif;";
const P = `${FONT}font-size:14px;line-height:20px;color:#1f2937;margin:0 0 12px;`;
const LI = `${FONT}font-size:14px;line-height:20px;color:#1f2937;margin:0 0 4px;`;
const MUTED = 'color:#6b7280;';
const RED = 'color:#b91c1c;font-weight:bold;';
const KINDS_SHOWN = 6;
const SINGLES_SHOWN = 15;

/**
 * The daily hold digest (pure, so a test can read it): a plain e-mail, no
 * card, no gradient, explicit colours, Outlook-safe. One paragraph per device
 * that sent an alert burst, its alert kinds as bullets (broken-sounding and
 * new kinds first, marked), then the other held emails one per line.
 */
export function buildHoldDigest({ workspaceName, count, groups = [], singles = [], link, linkIsUrl = false, timeZone = 'America/Vancouver' }) {
  const inGroups = groups.reduce((n, g) => n + g.count, 0);
  const noun = count === 1 ? 'email' : 'emails';
  const parts = [];
  parts.push(`<p style="${P}"><strong>${escapeHtml(workspaceName)}</strong> has <strong>${count}</strong> held ${noun} waiting for review.</p>`);
  if (groups.length) {
    parts.push(`<p style="${P}">${inGroups} of them are alert bursts from ${groups.length === 1 ? 'one device' : `${groups.length} devices`}: the device mailed more alerts at once than the mailbox opens tickets for, so the extra ones were held. They are grouped by device below. On the review page you can add a device's alerts to its ticket, or discard them, in one click.</p>`);
    for (const g of groups) {
      const kinds = g.kinds.length;
      parts.push(`<p style="${P}margin-bottom:4px;"><strong>${escapeHtml(g.device)}</strong>: ${g.count} alerts, ${kinds} ${kinds === 1 ? 'kind' : 'kinds'}, ${escapeHtml(formatSpan(g.firstAt, g.lastAt, timeZone))}<br><span style="${MUTED}">${escapeHtml(g.sender)}</span></p>`);
      const items = g.kinds.slice(0, KINDS_SHOWN).map((k) => {
        const flag = k.attention ? `<span style="${RED}">Needs a look:</span> ` : '';
        const where = k.ticket ? `ticket ${escapeHtml(k.ticket.displayRef)} (${escapeHtml(k.ticket.status)})` : '<strong>no ticket yet</strong>';
        return `<li style="${LI}">${flag}${k.count} × ${escapeHtml(k.label)} <span style="${MUTED}">· ${where} · newest ${escapeHtml(formatWhen(k.newestAt, timeZone))}</span></li>`;
      });
      if (kinds > KINDS_SHOWN) items.push(`<li style="${LI}${MUTED}">and ${kinds - KINDS_SHOWN} more kinds</li>`);
      parts.push(`<ul style="margin:0 0 14px 20px;padding:0;">${items.join('')}</ul>`);
    }
  } else {
    parts.push(`<p style="${P}">These emails looked like replies to a conversation Ticket Pulse does not know, or came from an agent with no identifiable requester, so they were held instead of becoming new tickets. Each one needs a decision: attach to a ticket, create a ticket, or discard.</p>`);
  }
  if (singles.length) {
    if (groups.length) parts.push(`<p style="${P}margin-bottom:4px;"><strong>Other held emails</strong> (${singles.length})</p>`);
    const items = singles.slice(0, SINGLES_SHOWN).map((r) => {
      const guess = r.bestGuessTicket ? ` · best guess ${escapeHtml(r.bestGuessTicket.displayRef)}` : '';
      return `<li style="${LI}"><strong>${escapeHtml(r.subject || '(no subject)')}</strong> <span style="${MUTED}">· ${escapeHtml(r.fromEmail || 'unknown sender')} · ${escapeHtml(REASON_WORDS[r.reason] || r.reason)}${guess} · ${escapeHtml(formatWhen(r.receivedAt, timeZone))}</span></li>`;
    });
    if (singles.length > SINGLES_SHOWN) items.push(`<li style="${LI}${MUTED}">and ${singles.length - SINGLES_SHOWN} more</li>`);
    parts.push(`<ul style="margin:0 0 14px 20px;padding:0;">${items.join('')}</ul>`);
  }
  const shown = inGroups + singles.length;
  if (count > shown) parts.push(`<p style="${P}${MUTED}">${count - shown} more are not listed here.</p>`);
  parts.push(`<p style="${P}">Review them at ${linkIsUrl ? `<a href="${escapeHtml(link)}" style="color:#1d4ed8;">${escapeHtml(link)}</a>` : escapeHtml(link)}.</p>`);
  const subject = groups.length
    ? `Ticket Pulse: ${count} held ${noun} waiting for review (alert bursts from ${groups.length === 1 ? groups[0].device : `${groups.length} devices`})`
    : `Ticket Pulse: ${count} unmatched ${count === 1 ? 'reply' : 'replies'} waiting for review`;
  return { subject, html: parts.join('\n') };
}

export { rehydrateEmail, presentHeld, SYSTEM_ACTOR as HOLD_SYSTEM_ACTOR };
export default new MailboxHoldService();
