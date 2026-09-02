import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ValidationError } from '../utils/errors.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';

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
]);

export const HOLD_STATUSES = Object.freeze(['held', 'attached', 'created', 'discarded']);

export const NEW_TICKET_POLICIES = Object.freeze(['create', 'replies_only', 'hold_unmatched']);

const SNIPPET_MAX = 500;
const SYSTEM_ACTOR = { email: 'mailbox@ticketpulse.internal', name: 'Ticket Pulse Mail', role: 'system', technicianId: null };

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
      return { id: row.id, status: row.status, duplicate: false };
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

  async count(workspaceId, status = 'held') {
    return prisma.mailboxHeldMessage.count({ where: { workspaceId: Number(workspaceId), status } });
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
    const access = await prisma.workspaceAccess.findMany({
      where: { workspaceId, role: 'admin' },
      select: { email: true },
    }).catch(() => []);
    const emails = [...new Set(access.map((a) => String(a.email || '').trim().toLowerCase()).filter(Boolean))];
    if (emails.length) return emails;
    let raw = null;
    try {
      const { default: settingsRepository } = await import('./settingsRepository.js');
      raw = await settingsRepository.get('admin_emails');
    } catch { /* fall through */ }
    const source = raw && String(raw).trim() ? String(raw) : (process.env.ADMIN_EMAILS || '');
    return source.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
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
        const rows = await this.list(workspaceId, { status: 'held', limit: 15 });
        const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } }).catch(() => null);
        const items = rows.map((r) => {
          const when = r.receivedAt ? new Date(r.receivedAt).toLocaleString('en-CA', { hour12: false }) : '';
          const guess = r.bestGuessTicket ? ` · best guess ${r.bestGuessTicket.displayRef}` : '';
          return `<li><strong>${escapeHtml(r.subject || '(no subject)')}</strong> — ${escapeHtml(r.fromEmail || 'unknown sender')} · ${escapeHtml(r.reason)}${guess}${when ? ` · ${escapeHtml(when)}` : ''}</li>`;
        }).join('');
        const link = appUrl ? `${String(appUrl).replace(/\/$/, '')}/settings#ticket-mailboxes` : 'Settings → Ticket Mailboxes → Unmatched replies';
        const html = `
          <p><strong>${escapeHtml(workspace?.name || `Workspace ${workspaceId}`)}</strong> has <strong>${count}</strong> unmatched ${count === 1 ? 'reply' : 'replies'} waiting for review.</p>
          <p>These emails looked like replies to a conversation Ticket Pulse does not know, or came from an agent with no identifiable requester, so they were held instead of becoming new tickets. Each one needs a decision: attach to a ticket, create a ticket, or discard.</p>
          <ul>${items}</ul>
          ${count > rows.length ? `<p>…and ${count - rows.length} more.</p>` : ''}
          <p>Review them at ${appUrl ? `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>` : escapeHtml(link)}.</p>`;
        const result = await sendTransactionalEmail({
          workspaceId,
          to,
          subject: `Ticket Pulse: ${count} unmatched ${count === 1 ? 'reply' : 'replies'} waiting for review`,
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

export { rehydrateEmail, presentHeld, SYSTEM_ACTOR as HOLD_SYSTEM_ACTOR };
export default new MailboxHoldService();
