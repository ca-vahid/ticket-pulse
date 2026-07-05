import prisma from './prisma.js';
import logger from '../utils/logger.js';
import settingsRepository from './settingsRepository.js';
import ticketActivityRepository from './ticketActivityRepository.js';
import attachmentService from './attachmentService.js';
import { createFreshServiceClient } from '../integrations/freshservice.js';
import { TICKET_ORIGIN, ticketDisplayRef } from '../utils/ticketOrigin.js';
import { sseManager } from '../routes/sse.routes.js';

// TP status labels → FreshService status codes
export const FS_STATUS_CODES = { Open: 2, Pending: 3, Resolved: 4, Closed: 5 };

const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 5 * 60 * 1000; // 5m, doubling, capped at 6h
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const DRAIN_INTERVAL_MS = Number(process.env.NATIVE_TICKET_MIRROR_INTERVAL_MS || 60 * 1000);
const MIRROR_MARKER = '[Ticket Pulse mirror]';

function backoffMs(attempts) {
  return Math.min(BASE_BACKOFF_MS * (2 ** Math.max(0, attempts - 1)), MAX_BACKOFF_MS);
}

function textToHtml(text) {
  if (!text) return '';
  return `<p>${String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br/>')}</p>`;
}

/**
 * FreshService fallback mirror for TP-born tickets.
 *
 * Ticket Pulse stays the source of truth; this service pushes best-effort
 * copies (ticket, field changes, conversation entries) into FreshService via a
 * DB outbox so the org can retreat to FS during a Ticket Pulse outage. Echo
 * suppression is inherent: every FS→TP ingest path drops origin='ticketpulse'
 * rows, so our own writes can never boomerang back.
 */
class MirrorService {
  constructor() {
    this._timer = null;
    this._draining = false;
    this._clients = new Map(); // workspaceId → client (per-process; shared rate limiter underneath)
  }

  isEnabled() {
    return process.env.NATIVE_TICKET_MIRROR_ENABLED !== 'false';
  }

  start() {
    if (this._timer || !this.isEnabled()) return;
    this._timer = setInterval(() => {
      this.drain().catch((err) => logger.warn(`Mirror drain failed (non-fatal): ${err.message}`));
    }, DRAIN_INTERVAL_MS);
    this._timer.unref?.();
    logger.info(`FreshService mirror worker started (every ${Math.round(DRAIN_INTERVAL_MS / 1000)}s)`);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  // ---------------------------------------------------------------- enqueue

  async enqueueTicketCreate(ticket) {
    return this._enqueue(ticket.workspaceId, ticket.id, 'create_ticket');
  }

  /** Idempotent snapshot push — one pending update job per ticket is enough. */
  async enqueueFieldSync(workspaceId, ticketId) {
    const existing = await prisma.mirrorJob.findFirst({
      where: { ticketId, kind: 'update_fields', status: 'pending' },
      select: { id: true },
    });
    if (existing) return existing;
    return this._enqueue(workspaceId, ticketId, 'update_fields');
  }

  async enqueueThreadEntry(workspaceId, ticketId, threadEntryId) {
    return this._enqueue(workspaceId, ticketId, 'thread_entry', threadEntryId);
  }

  /**
   * Delete a mirrored note/reply from the FS fallback copy. The local thread
   * entry is already gone, so the FS conversation id rides in `payload`.
   */
  async enqueueThreadEntryDelete(workspaceId, ticketId, fsConversationId) {
    return this._enqueue(workspaceId, ticketId, 'delete_thread_entry', null, { fsConversationId });
  }

  async enqueueDelete(workspaceId, ticketId) {
    const existing = await prisma.mirrorJob.findFirst({
      where: { ticketId, kind: 'delete_ticket', status: 'pending' },
      select: { id: true },
    });
    if (existing) return existing;
    return this._enqueue(workspaceId, ticketId, 'delete_ticket');
  }

  async _enqueue(workspaceId, ticketId, kind, threadEntryId = null, payload = null) {
    try {
      return await prisma.mirrorJob.create({
        data: { workspaceId, ticketId, kind, threadEntryId, payload },
      });
    } catch (err) {
      logger.warn(`Mirror enqueue failed for ticket ${ticketId} (${kind}): ${err.message}`);
      return null;
    }
  }

  // ------------------------------------------------------------------ drain

  /**
   * Process this one ticket's pending/failed mirror jobs right now (a manual
   * "Mirror now" from the UI), ignoring the per-job backoff so a user retry is
   * immediate. Returns how many jobs were processed and how many remain open.
   */
  async drainForTicket(ticketId, workspaceId) {
    if (!this.isEnabled()) return { skipped: true, reason: 'disabled' };
    const jobs = await prisma.mirrorJob.findMany({
      where: { ticketId, workspaceId, status: { in: ['pending', 'failed'] } },
      orderBy: { id: 'asc' },
    });
    if (jobs.length === 0) return { processed: 0, remaining: 0 };
    let processed = 0;
    for (const job of jobs) {
      const ok = await this._processJob(job);
      if (!ok) break; // preserve per-ticket ordering; stop on the first failure
      processed += 1;
    }
    const remaining = await prisma.mirrorJob.count({
      where: { ticketId, workspaceId, status: { in: ['pending', 'failed'] } },
    });
    return { processed, remaining };
  }

  async drain({ limit = 50 } = {}) {
    if (this._draining || !this.isEnabled()) return { skipped: true };
    this._draining = true;
    try {
      const due = await prisma.mirrorJob.findMany({
        where: { status: { in: ['pending', 'failed'] }, nextAttemptAt: { lte: new Date() } },
        orderBy: [{ ticketId: 'asc' }, { id: 'asc' }],
        take: limit,
      });
      if (due.length === 0) return { processed: 0 };

      let processed = 0;
      const blockedTickets = new Set();
      for (const job of due) {
        if (blockedTickets.has(job.ticketId)) continue; // keep per-ticket ordering
        const ok = await this._processJob(job);
        processed += 1;
        if (!ok) blockedTickets.add(job.ticketId);
      }
      return { processed };
    } finally {
      this._draining = false;
    }
  }

  /** Public accessor — FS-born reply/note writes reuse the mirror's client. */
  async getClient(workspaceId) {
    return this._getClient(workspaceId);
  }

  async _getClient(workspaceId) {
    if (this._clients.has(workspaceId)) return this._clients.get(workspaceId);
    const fsConfig = await settingsRepository.getFreshServiceConfigForWorkspace(workspaceId);
    if (!fsConfig?.domain || !fsConfig?.apiKey) return null;
    const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey, {
      priority: 'low',
      source: 'native-ticket-mirror',
    });
    this._clients.set(workspaceId, client);
    return client;
  }

  async _processJob(job) {
    try {
      const client = await this._getClient(job.workspaceId);
      if (!client) {
        await this._markFailed(job, 'FreshService is not configured for this workspace');
        return false;
      }

      if (job.kind === 'create_ticket') await this._mirrorCreate(job, client);
      else if (job.kind === 'update_fields') await this._mirrorFields(job, client);
      else if (job.kind === 'thread_entry') await this._mirrorThreadEntry(job, client);
      else if (job.kind === 'delete_thread_entry') await this._mirrorThreadEntryDelete(job, client);
      else if (job.kind === 'delete_ticket') await this._mirrorDelete(job, client);
      else throw new Error(`Unknown mirror job kind: ${job.kind}`);

      await prisma.mirrorJob.update({
        where: { id: job.id },
        data: { status: 'done', lastError: null, attempts: job.attempts + 1 },
      });
      return true;
    } catch (err) {
      await this._markFailed(job, err.message || String(err));
      return false;
    }
  }

  async _markFailed(job, message) {
    const attempts = job.attempts + 1;
    const dead = attempts >= MAX_ATTEMPTS;
    logger.warn(`Mirror job ${job.id} (${job.kind}, ticket ${job.ticketId}) failed${dead ? ' permanently' : ''}: ${message}`);
    await prisma.mirrorJob.update({
      where: { id: job.id },
      data: {
        status: dead ? 'dead' : 'failed',
        attempts,
        lastError: String(message).slice(0, 2000),
        nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
      },
    }).catch(() => {});
    await prisma.ticket.update({
      where: { id: job.ticketId },
      data: dead
        ? { mirrorState: 'error', mirrorError: String(message).slice(0, 2000) }
        : { mirrorError: String(message).slice(0, 2000) },
    }).catch(() => {});
  }

  async _loadTicket(ticketId) {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        workspace: true,
        requester: true,
        assignedTech: { select: { id: true, name: true, freshserviceId: true } },
        internalCategory: { select: { name: true } },
        internalSubcategory: { select: { name: true } },
      },
    });
    if (!ticket) throw new Error(`Ticket ${ticketId} not found`);
    if (ticket.origin !== TICKET_ORIGIN.TICKETPULSE) throw new Error('Only TP-born tickets are mirrored');
    return ticket;
  }

  _customFields(ticket) {
    const fields = {};
    const skill = ticket.internalCategory?.name || ticket.tpSkill || null;
    const subskill = ticket.internalSubcategory?.name || ticket.tpSubskill || null;
    if (skill && ticket.workspace?.tpSkillCustomField) fields[ticket.workspace.tpSkillCustomField] = skill;
    if (subskill && ticket.workspace?.tpSubskillCustomField) fields[ticket.workspace.tpSubskillCustomField] = subskill;
    return Object.keys(fields).length ? fields : null;
  }

  async _mirrorCreate(job, client) {
    const ticket = await this._loadTicket(job.ticketId);
    if (ticket.freshserviceTicketId) return; // already mirrored (idempotent)

    if (!ticket.requester?.email) throw new Error('Requester email is required to mirror a ticket');
    const ref = ticketDisplayRef(ticket);

    const fsTicket = await client.createTicket({
      email: ticket.requester.email,
      subject: `${ticket.subject || '(no subject)'}`,
      description: ticket.description || textToHtml(ticket.descriptionText) || textToHtml(ticket.subject),
      status: FS_STATUS_CODES[ticket.status] || FS_STATUS_CODES.Open,
      priority: ticket.priority || 2,
      source: 2, // portal
      workspace_id: ticket.workspace?.freshserviceWorkspaceId ? Number(ticket.workspace.freshserviceWorkspaceId) : undefined,
      group_id: ticket.groupId ? Number(ticket.groupId) : undefined,
      responder_id: ticket.assignedTech?.freshserviceId ? Number(ticket.assignedTech.freshserviceId) : undefined,
      custom_fields: this._customFields(ticket) || undefined,
    });
    if (!fsTicket?.id) throw new Error('FreshService did not return a ticket id');

    await prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        freshserviceTicketId: BigInt(fsTicket.id),
        mirrorState: 'mirrored',
        mirroredAt: new Date(),
        mirrorError: null,
      },
    });

    // Backfill the requester's FS id the first time FS tells us who they are.
    if (!ticket.requester.freshserviceId && fsTicket.requester_id) {
      await prisma.requester.update({
        where: { id: ticket.requester.id },
        data: { freshserviceId: BigInt(fsTicket.requester_id) },
      }).catch(() => { /* another row may already own that FS id — harmless */ });
    }

    await client.addNote(
      fsTicket.id,
      `<p><b>${MIRROR_MARKER}</b> This is the fallback copy of <b>${ref}</b>, which lives in Ticket Pulse. `
      + 'Ticket Pulse is the source of truth — work it there unless Ticket Pulse is down.</p>',
      { isPrivate: true },
    ).catch((err) => logger.warn(`Mirror intro note failed for ${ref} (non-fatal): ${err.message}`));

    this._broadcast(ticket, 'mirror');
    logger.info(`Mirrored ${ref} → FreshService #${fsTicket.id}`);
  }

  async _mirrorFields(job, client) {
    const ticket = await this._loadTicket(job.ticketId);
    if (!ticket.freshserviceTicketId) {
      // The create job either hasn't run or failed — keep ordering, retry later.
      throw new Error('Awaiting FreshService copy (create_ticket has not completed)');
    }

    await client.updateTicket(Number(ticket.freshserviceTicketId), {
      subject: ticket.subject || undefined,
      status: FS_STATUS_CODES[ticket.status] || undefined,
      priority: ticket.priority || undefined,
      group_id: ticket.groupId ? Number(ticket.groupId) : undefined,
      responder_id: ticket.assignedTech?.freshserviceId ? Number(ticket.assignedTech.freshserviceId) : null,
      custom_fields: this._customFields(ticket) || undefined,
    });

    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { mirrorState: 'mirrored', mirroredAt: new Date(), mirrorError: null },
    });
    this._broadcast(ticket, 'mirror');
  }

  async _mirrorThreadEntry(job, client) {
    const ticket = await this._loadTicket(job.ticketId);
    if (!ticket.freshserviceTicketId) {
      throw new Error('Awaiting FreshService copy (create_ticket has not completed)');
    }
    const entry = await prisma.ticketThreadEntry.findUnique({ where: { id: job.threadEntryId } });
    if (!entry) return; // deleted — nothing to mirror
    if (entry.mirrorState === 'mirrored') return; // idempotent

    const label = entry.isPrivate ? 'internal note' : 'reply to requester';
    const body = `<p><b>${MIRROR_MARKER}</b> ${entry.actorName || 'Ticket Pulse'} · ${label} · ${ticketDisplayRef(ticket)}</p>`
      + (entry.bodyHtml || textToHtml(entry.bodyText || entry.content || ''));

    // Re-attach any files staged on this entry so the FS copy carries them too.
    const attachments = await attachmentService.buffersForThreadEntry(entry.id);

    // Public replies mirror as PUBLIC NOTES (portal-visible, no requester email —
    // Ticket Pulse already emailed them). Internal notes mirror privately.
    const result = await client.addNote(Number(ticket.freshserviceTicketId), body, {
      isPrivate: entry.isPrivate === true,
      attachments,
    });

    await prisma.ticketThreadEntry.update({
      where: { id: entry.id },
      data: {
        mirrorState: 'mirrored',
        mirroredAt: new Date(),
        externalEntryId: result?.conversation?.id ? `mirror-${result.conversation.id}` : entry.externalEntryId,
      },
    });
  }

  async _mirrorThreadEntryDelete(job, client) {
    const fsConversationId = job.payload?.fsConversationId;
    if (!fsConversationId) return; // note was never mirrored — nothing to delete
    await client.deleteConversation(Number(fsConversationId));
    logger.info(`Mirror: deleted FS conversation ${fsConversationId} for ticket ${job.ticketId}`);
  }

  async _mirrorDelete(job, client) {
    const ticket = await this._loadTicket(job.ticketId);
    if (!ticket.freshserviceTicketId) return; // never mirrored — nothing to delete
    await client.deleteTicket(Number(ticket.freshserviceTicketId));
    logger.info(`Mirror: trashed FS copy #${ticket.freshserviceTicketId} for deleted TP ticket ${ticket.id}`);
  }

  _broadcast(ticket, action) {
    try {
      sseManager.broadcast('ticket-change', {
        action,
        workspaceId: ticket.workspaceId,
        ticketId: ticket.id,
        origin: ticket.origin,
        displayRef: ticketDisplayRef(ticket),
      }, ticket.workspaceId);
    } catch { /* non-fatal */ }
  }

  // ------------------------------------------------------------- reconcile

  /**
   * Post-outage recovery: pull FS-side deltas on TP-born mirrored tickets back
   * into Ticket Pulse. Imports conversation entries added in FS (skipping our
   * own mirror notes) and logs conflicts for status/assignee drift — TP stays
   * the source of truth, so drift is surfaced, never auto-applied.
   */
  async reconcile(workspaceId, { since = null } = {}) {
    const client = await this._getClient(workspaceId);
    if (!client) return { skipped: true, reason: 'freshservice_not_configured' };

    const tickets = await prisma.ticket.findMany({
      where: {
        workspaceId,
        origin: TICKET_ORIGIN.TICKETPULSE,
        freshserviceTicketId: { not: null },
        ...(since ? { mirroredAt: { gte: new Date(since) } } : {}),
      },
      include: { assignedTech: { select: { freshserviceId: true, name: true } } },
      orderBy: { id: 'asc' },
      take: 500,
    });

    let imported = 0;
    let conflicts = 0;
    for (const ticket of tickets) {
      const fsId = Number(ticket.freshserviceTicketId);
      try {
        const [fsTicket, conversations] = await Promise.all([
          client.fetchTicketSafe ? client.fetchTicketSafe(fsId) : null,
          client.fetchTicketConversations(fsId),
        ]);

        for (const conv of conversations || []) {
          if (!conv?.id) continue;
          const bodyText = String(conv.body_text || conv.body || '');
          if (bodyText.includes(MIRROR_MARKER) || String(conv.body || '').includes(MIRROR_MARKER)) continue;
          const externalEntryId = `fs-conv-${conv.id}`;
          const exists = await prisma.ticketThreadEntry.findFirst({
            where: { ticketId: ticket.id, externalEntryId },
            select: { id: true },
          });
          if (exists) continue;
          await prisma.ticketThreadEntry.create({
            data: {
              ticketId: ticket.id,
              workspaceId,
              externalEntryId,
              source: 'freshservice_reconciliation',
              eventType: conv.private ? 'note' : 'reply',
              actorName: conv.user_name || conv.from_email || 'FreshService user',
              actorEmail: conv.from_email || null,
              authorType: conv.incoming ? 'requester' : 'agent',
              incoming: conv.incoming === true,
              isPrivate: conv.private === true,
              visibility: conv.private ? 'private' : 'public',
              bodyHtml: conv.body || null,
              bodyText: conv.body_text || null,
              content: conv.body_text || null,
              occurredAt: conv.created_at ? new Date(conv.created_at) : new Date(),
            },
          });
          imported += 1;
        }

        if (fsTicket && typeof fsTicket === 'object' && fsTicket.id) {
          const fsStatusCode = Number(fsTicket.status);
          const ourStatusCode = FS_STATUS_CODES[ticket.status] || null;
          const fsResponder = fsTicket.responder_id ? Number(fsTicket.responder_id) : null;
          const ourResponder = ticket.assignedTech?.freshserviceId ? Number(ticket.assignedTech.freshserviceId) : null;
          const drift = [];
          if (ourStatusCode && fsStatusCode && fsStatusCode !== ourStatusCode) drift.push(`status (FS ${fsStatusCode} vs TP ${ourStatusCode})`);
          if (fsResponder !== ourResponder) drift.push(`assignee (FS ${fsResponder || 'none'} vs TP ${ourResponder || 'none'})`);
          if (drift.length) {
            conflicts += 1;
            logger.warn(`Mirror conflict on ${ticketDisplayRef(ticket)}: FS copy drifted — ${drift.join(', ')}`);
            await ticketActivityRepository.create({
              ticketId: ticket.id,
              activityType: 'mirror_conflict',
              performedBy: 'Mirror reconciliation',
              performedAt: new Date(),
              details: { drift, freshserviceTicketId: fsId, note: 'FS copy was edited out-of-band; Ticket Pulse remains source of truth' },
            }).catch(() => {});
          }
        }
      } catch (err) {
        logger.warn(`Reconciliation failed for ticket ${ticket.id} (non-fatal): ${err.message}`);
      }
    }

    logger.info(`Mirror reconciliation for workspace ${workspaceId}: ${tickets.length} tickets checked, ${imported} entries imported, ${conflicts} conflicts`);
    return { checked: tickets.length, imported, conflicts };
  }
}

export default new MirrorService();
