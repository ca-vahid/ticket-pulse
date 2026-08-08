import prisma from './prisma.js';
import logger from '../utils/logger.js';
import settingsRepository from './settingsRepository.js';
import ticketActivityRepository from './ticketActivityRepository.js';
import attachmentService from './attachmentService.js';
import { createFreshServiceClient } from '../integrations/freshservice.js';
import { TICKET_ORIGIN, ticketDisplayRef } from '../utils/ticketOrigin.js';
import { cleanDisplayName } from '../utils/textEncoding.js';
import ticketTypeService from './ticketTypeService.js';
import statusService from './statusService.js';
import { sseManager } from '../routes/sse.routes.js';

// TP status labels → FreshService status codes (canonical labels only —
// custom labels resolve through their BASE via _fsStatusCode below).
export const FS_STATUS_CODES = { Open: 2, Pending: 3, Resolved: 4, Closed: 5 };

const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 5 * 60 * 1000; // 5m, doubling, capped at 6h
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const DRAIN_INTERVAL_MS = Number(process.env.NATIVE_TICKET_MIRROR_INTERVAL_MS || 60 * 1000);
// A 'processing' row idle this long means its owning process died mid-job —
// eligible to be reclaimed by the next drain.
const STALE_PROCESSING_MS = 10 * 60 * 1000;
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
    this._interactiveClients = new Map(); // workspaceId → high-priority client for user-facing calls
    // Tickets whose mirror jobs are executing right now. Two concurrent drains
    // (double-clicked "Mirror now", or manual + the 60s worker) used to both
    // pass _mirrorCreate's freshserviceTicketId===null check before either
    // wrote it back — producing two FS tickets for one TP ticket (QA 07-08,
    // TP-1006 → FS #231932 + #231933).
    this._inFlightTickets = new Set();
    // FS departments per workspace, cached: FS made department_id REQUIRED on
    // ticket create (QA 07-28, TP-1058 dead-lettered on "department_id …
    // missing_field"), so every mirror create resolves one.
    this._departmentsCache = new Map(); // workspaceId → { list, fetchedAt }
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
   * Push an edited note's new body onto its already-mirrored FS conversation
   * (FR 08-07 #8). The entry still exists locally — its `mirror-<id>` external
   * id tells the job which FS conversation to update.
   */
  async enqueueThreadEntryUpdate(workspaceId, ticketId, threadEntryId) {
    return this._enqueue(workspaceId, ticketId, 'thread_entry_update', threadEntryId);
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

  /**
   * Mirror a ticket-LEVEL attachment (uploaded via the rail, not on a reply)
   * to the FS fallback copy as a private note carrying the file (WS-A.5).
   * Thread-entry attachments already ride their entry's mirror job.
   */
  async enqueueAttachment(workspaceId, ticketId, attachmentId) {
    return this._enqueue(workspaceId, ticketId, 'attachment', null, { attachmentId });
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
    if (this._inFlightTickets.has(ticketId)) {
      // A drain (previous click, or the background worker) already owns this
      // ticket — report progress instead of racing it.
      const remaining = await prisma.mirrorJob.count({
        where: { ticketId, workspaceId, status: { in: ['pending', 'failed', 'processing'] } },
      });
      return { processed: 0, remaining, inProgress: true };
    }
    const jobs = await prisma.mirrorJob.findMany({
      where: {
        ticketId,
        workspaceId,
        OR: [
          { status: { in: ['pending', 'failed'] } },
          // Crash recovery: a process that died mid-job leaves 'processing'.
          { status: 'processing', updatedAt: { lt: new Date(Date.now() - STALE_PROCESSING_MS) } },
        ],
      },
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
      where: { ticketId, workspaceId, status: { in: ['pending', 'failed', 'processing'] } },
    });
    return { processed, remaining };
  }

  async drain({ limit = 50 } = {}) {
    if (this._draining || !this.isEnabled()) return { skipped: true };
    this._draining = true;
    try {
      const due = await prisma.mirrorJob.findMany({
        where: {
          OR: [
            { status: { in: ['pending', 'failed'] }, nextAttemptAt: { lte: new Date() } },
            { status: 'processing', updatedAt: { lt: new Date(Date.now() - STALE_PROCESSING_MS) } },
          ],
        },
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

  /**
   * High-priority client for calls a user is actively waiting on (field
   * write-backs, replies, on-open thread refresh). The background mirror
   * client runs at priority 'low' on the shared limiter, which put
   * interactive writes behind entire sync sweeps — multi-minute hangs the
   * hosting front-end killed at ~230s (QA: "network error" after 4 min).
   * 'high' jumps the queue; queueTimeoutMs turns a still-congested queue
   * into a fast, honest FS_QUEUE_TIMEOUT (nothing sent) instead of a hang.
   */
  async getInteractiveClient(workspaceId) {
    if (this._interactiveClients.has(workspaceId)) return this._interactiveClients.get(workspaceId);
    const fsConfig = await settingsRepository.getFreshServiceConfigForWorkspace(workspaceId);
    if (!fsConfig?.domain || !fsConfig?.apiKey) return null;
    const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey, {
      priority: 'high',
      source: 'interactive-ui',
      queueTimeoutMs: 15000,
    });
    this._interactiveClients.set(workspaceId, client);
    return client;
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
    // Per-ticket in-flight lock (this process) + atomic DB claim (any process):
    // exactly one drain may execute a given job. The claim flips the row to
    // 'processing'; a competing drain's updateMany matches 0 rows and skips.
    if (this._inFlightTickets.has(job.ticketId)) return false;
    const claimed = await prisma.mirrorJob.updateMany({
      where: { id: job.id, status: { in: ['pending', 'failed', 'processing'] }, updatedAt: job.updatedAt },
      data: { status: 'processing' },
    });
    if (claimed.count === 0) return false; // someone else claimed it since we read it
    this._inFlightTickets.add(job.ticketId);
    try {
      return await this._executeJob(job);
    } finally {
      this._inFlightTickets.delete(job.ticketId);
    }
  }

  async _executeJob(job) {
    try {
      const client = await this._getClient(job.workspaceId);
      if (!client) {
        await this._markFailed(job, 'FreshService is not configured for this workspace');
        return false;
      }

      if (job.kind === 'create_ticket') await this._mirrorCreate(job, client);
      else if (job.kind === 'update_fields') await this._mirrorFields(job, client);
      else if (job.kind === 'thread_entry') await this._mirrorThreadEntry(job, client);
      else if (job.kind === 'thread_entry_update') await this._mirrorThreadEntryUpdate(job, client);
      else if (job.kind === 'delete_thread_entry') await this._mirrorThreadEntryDelete(job, client);
      else if (job.kind === 'delete_ticket') await this._mirrorDelete(job, client);
      else if (job.kind === 'attachment') await this._mirrorAttachment(job, client);
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

  /**
   * Build the Ticket Pulse skill custom fields for FreshService, resolving the
   * category/subcategory NAMES to the lookup-field record ids FS expects
   * (sending the name makes FS store "none"). Returns null when there's no
   * category or the names can't be resolved (so we don't overwrite with junk).
   */
  async _skillCustomFields(client, ticket) {
    const skill = ticket.internalCategory?.name || ticket.tpSkill || null;
    const subskill = ticket.internalSubcategory?.name || ticket.tpSubskill || null;
    const categoryField = ticket.workspace?.tpSkillCustomField;
    const subcategoryField = ticket.workspace?.tpSubskillCustomField;
    if (!skill || !categoryField) return null;
    try {
      const { resolveTpSkillLookupIds } = await import('./freshServiceActionService.js');
      const { categoryDisplayId, subcategoryDisplayId } = await resolveTpSkillLookupIds(client, {
        skill,
        subskill,
        workspaceId: ticket.workspace?.freshserviceWorkspaceId ? String(ticket.workspace.freshserviceWorkspaceId) : null,
      });
      if (!categoryDisplayId) {
        logger.warn(`Mirror: could not resolve FS lookup id for category "${skill}" — skipping category custom fields`);
        return null;
      }
      const fields = { [categoryField]: categoryDisplayId };
      if (subcategoryField && subcategoryDisplayId) fields[subcategoryField] = subcategoryDisplayId;
      return fields;
    } catch (err) {
      logger.warn(`Mirror: skill lookup resolution failed (non-fatal): ${err.message}`);
      return null;
    }
  }

  /**
   * Resolve the FS department id for a ticket. FreshService made
   * department_id a REQUIRED create field (QA 07-28: TP-1058's create job
   * dead-lettered 8 times on "department_id … missing_field"), so we match the
   * ticket's department name — else the requester's Entra office/department —
   * against the FS department list, falling back to "Non-BGC Email" and then
   * the first department. Cached 10 min per workspace.
   *
   * Public since QA 08-05 #6 (Cambio #236253): ticketService's status-change
   * retry reuses this as step 3 of its department ladder when neither the FS
   * ticket nor its FS requester carries a department. Never throws — returns
   * undefined when resolution is impossible.
   */
  async resolveDepartmentId(client, ticket) {
    try {
      const wsId = ticket.workspaceId;
      let entry = this._departmentsCache.get(wsId);
      if (!entry || Date.now() - entry.fetchedAt > 10 * 60 * 1000) {
        entry = { list: await client.listDepartments(), fetchedAt: Date.now() };
        this._departmentsCache.set(wsId, entry);
      }
      const departments = entry.list || [];
      if (!departments.length) return undefined;
      const byName = (name) => {
        const target = String(name || '').trim().toLowerCase();
        if (!target) return null;
        return departments.find((d) => String(d.name || '').toLowerCase() === target) || null;
      };
      const candidates = [
        ticket.department,
        ticket.requester?.entraOfficeLocation,
        ticket.requester?.entraDepartment,
        'Non-BGC Email',
      ];
      for (const candidate of candidates) {
        const match = byName(candidate);
        if (match?.id) return Number(match.id);
      }
      return departments[0]?.id ? Number(departments[0].id) : undefined;
    } catch (err) {
      logger.warn(`Mirror: department resolution failed (non-fatal): ${err.message}`);
      return undefined;
    }
  }

  /** Old private name — kept delegating for compatibility with existing callers. */
  _resolveDepartmentId(client, ticket) {
    return this.resolveDepartmentId(client, ticket);
  }

  /**
   * FS status code for a TP ticket (Phase 8c): canonical labels map directly;
   * custom labels ("Needs Rework") map through their BASE status in the
   * workspace registry (Pending-base → 3). Unknown/unmappable labels return
   * null — callers omit the field rather than silently shipping Open(2).
   */
  async _fsStatusCode(ticket) {
    if (FS_STATUS_CODES[ticket.status] !== undefined) return FS_STATUS_CODES[ticket.status];
    try {
      const base = await statusService.resolveBaseStatus(ticket.workspaceId, ticket.status);
      return FS_STATUS_CODES[base] ?? null;
    } catch {
      return null;
    }
  }

  async _mirrorCreate(job, client) {
    const ticket = await this._loadTicket(job.ticketId);
    if (ticket.freshserviceTicketId) return; // already mirrored (idempotent)

    if (!ticket.requester?.email) throw new Error('Requester email is required to mirror a ticket');
    const ref = ticketDisplayRef(ticket);

    const basePayload = {
      email: ticket.requester.email,
      subject: `${ticket.subject || '(no subject)'}`,
      description: ticket.description || textToHtml(ticket.descriptionText) || textToHtml(ticket.subject),
      // FS requires a status on create — base-mapped, Open only as the final
      // fallback for labels with no resolvable base.
      status: (await this._fsStatusCode(ticket)) ?? FS_STATUS_CODES.Open,
      priority: ticket.priority || 2,
      source: 2, // portal
      workspace_id: ticket.workspace?.freshserviceWorkspaceId ? Number(ticket.workspace.freshserviceWorkspaceId) : undefined,
      group_id: ticket.groupId ? Number(ticket.groupId) : undefined,
      responder_id: ticket.assignedTech?.freshserviceId ? Number(ticket.assignedTech.freshserviceId) : undefined,
      department_id: await this.resolveDepartmentId(client, ticket),
    };
    // Ticket type rides along only when the registry maps it to an FS choice
    // for this workspace — TP-native-only types (fsTypeValue null) stay
    // TP-side; sending an unknown value would render inconsistently in FS.
    if (ticket.ticketType) {
      const typeDef = await ticketTypeService.resolveType(ticket.workspaceId, ticket.ticketType);
      if (typeDef?.fsTypeValue) basePayload.type = typeDef.fsTypeValue;
    }
    // The Ticket Pulse category fields (lf_ticket_pulse_*) are LOOKUP fields that
    // FreshService validates strictly on CREATE ("should be of type Number") but
    // accepts on UPDATE — and they need the record ID, not the category name. So
    // create WITHOUT them, then set the resolved ids via a follow-up update.
    const fsTicket = await client.createTicket({ ...basePayload });
    if (!fsTicket?.id) throw new Error('FreshService did not return a ticket id');

    // Persist the FS id IMMEDIATELY — before any other await. A failure between
    // createTicket and this write used to leave freshserviceTicketId null, so
    // the retry called createTicket again and produced a second FS ticket
    // (QA 07-08: TP-1006 ended up with two orphan copies).
    await prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        freshserviceTicketId: BigInt(fsTicket.id),
        mirrorState: 'mirrored',
        mirroredAt: new Date(),
        mirrorError: null,
      },
    });

    const customFields = await this._skillCustomFields(client, ticket);
    if (customFields) {
      await client.updateTicket(fsTicket.id, { custom_fields: customFields })
        .catch((err) => logger.warn(`Mirror: TP category fields not set on ${ref} (non-fatal): ${err.message}`));
    }

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

    // Push any tasks that were added before this FS copy existed — their
    // write-back was skipped for lack of a freshserviceTicketId (QA 07-20 #14).
    import('./ticketTaskService.js')
      .then(({ default: taskService }) => taskService.backfillMirrorTasks(ticket.id, ticket.workspaceId))
      .catch((err) => logger.warn(`Mirror task backfill failed for ${ref} (non-fatal): ${err.message}`));

    this._broadcast(ticket, 'mirror');
    logger.info(`Mirrored ${ref} → FreshService #${fsTicket.id}`);
  }

  async _mirrorFields(job, client) {
    const ticket = await this._loadTicket(job.ticketId);
    if (!ticket.freshserviceTicketId) {
      // The create job either hasn't run or failed — keep ordering, retry later.
      throw new Error('Awaiting FreshService copy (create_ticket has not completed)');
    }

    const customFields = await this._skillCustomFields(client, ticket);
    await client.updateTicket(Number(ticket.freshserviceTicketId), {
      subject: ticket.subject || undefined,
      status: (await this._fsStatusCode(ticket)) ?? undefined,
      priority: ticket.priority || undefined,
      group_id: ticket.groupId ? Number(ticket.groupId) : undefined,
      responder_id: ticket.assignedTech?.freshserviceId ? Number(ticket.assignedTech.freshserviceId) : null,
      custom_fields: customFields || undefined,
    });

    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { mirrorState: 'mirrored', mirroredAt: new Date(), mirrorError: null },
    });
    this._broadcast(ticket, 'mirror');
  }

  /** Mirror-prefixed FS body for a thread entry (create AND edit reuse this). */
  _threadEntryMirrorBody(ticket, entry) {
    const label = entry.isPrivate ? 'internal note' : 'reply to requester';
    return `<p><b>${MIRROR_MARKER}</b> ${entry.actorName || 'Ticket Pulse'} · ${label} · ${ticketDisplayRef(ticket)}</p>`
      + (entry.bodyHtml || textToHtml(entry.bodyText || entry.content || ''));
  }

  async _mirrorThreadEntry(job, client) {
    const ticket = await this._loadTicket(job.ticketId);
    if (!ticket.freshserviceTicketId) {
      throw new Error('Awaiting FreshService copy (create_ticket has not completed)');
    }
    const entry = await prisma.ticketThreadEntry.findUnique({ where: { id: job.threadEntryId } });
    if (!entry) return; // deleted — nothing to mirror
    if (entry.mirrorState === 'mirrored') return; // idempotent

    const body = this._threadEntryMirrorBody(ticket, entry);

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

  /**
   * WS-A.5: ticket-level attachment → private note with the file on the FS
   * copy. Size-capped (FS rejects very large uploads); a missing blob or an
   * oversize file resolves the job with a warning instead of dead-lettering.
   */
  async _mirrorAttachment(job, client) {
    const FS_ATTACHMENT_CAP_BYTES = 15 * 1024 * 1024; // FreshService per-request cap
    const ticket = await this._loadTicket(job.ticketId);
    if (!ticket.freshserviceTicketId) {
      throw new Error('Awaiting FreshService copy (create_ticket has not completed)');
    }
    const row = await prisma.ticketAttachment.findFirst({
      where: { id: Number(job.payload?.attachmentId), ticketId: job.ticketId },
    });
    if (!row) return; // deleted before the mirror ran — nothing to do
    if (row.sizeBytes > FS_ATTACHMENT_CAP_BYTES) {
      logger.warn(`Mirror: attachment "${row.fileName}" (${row.sizeBytes}B) exceeds the FS cap — skipped`);
      return;
    }
    const buffers = await attachmentService.buffersForThreadEntry(row.threadEntryId ?? -1);
    let files = buffers;
    if (!files.length) {
      // Ticket-level rows have no threadEntryId — fetch the single blob.
      try {
        const buffer = await attachmentService._container().getBlockBlobClient(row.blobName).downloadToBuffer();
        files = [{ filename: row.fileName, buffer, contentType: row.contentType }];
      } catch (err) {
        logger.warn(`Mirror: attachment blob fetch failed for "${row.fileName}": ${err.message} — skipped`);
        return;
      }
    }
    const body = `<p><b>${MIRROR_MARKER}</b> attachment uploaded in Ticket Pulse · ${ticketDisplayRef(ticket)}</p><p>${String(row.fileName).replace(/</g, '&lt;')}</p>`;
    await client.addNote(Number(ticket.freshserviceTicketId), body, { isPrivate: true, attachments: files });
    logger.info(`Mirror: attachment "${row.fileName}" pushed to FS copy of ticket ${job.ticketId}`);
  }

  /**
   * Push an edited note's current body onto its mirrored FS conversation
   * (FR 08-07 #8). Only entries that already mirrored (`mirror-<id>`) qualify —
   * a still-pending entry's create job will carry the edited body anyway.
   */
  async _mirrorThreadEntryUpdate(job, client) {
    const ticket = await this._loadTicket(job.ticketId);
    const entry = await prisma.ticketThreadEntry.findUnique({ where: { id: job.threadEntryId } });
    if (!entry) return; // deleted since the edit — nothing to update
    const ext = typeof entry.externalEntryId === 'string' ? entry.externalEntryId : '';
    if (!ext.startsWith('mirror-')) return; // never mirrored — local edit only
    const fsConversationId = ext.slice('mirror-'.length);
    const body = this._threadEntryMirrorBody(ticket, entry);
    await client.updateConversation(Number(fsConversationId), { body });
    logger.info(`Mirror: updated FS conversation ${fsConversationId} for edited note ${entry.id} (ticket ${job.ticketId})`);
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
   * Pull FS-side deltas on TP-born mirrored tickets back into Ticket Pulse:
   * conversation entries added in FS (skipping our own mirror notes) are
   * imported, and status/assignee drift is logged as a conflict — TP stays the
   * source of truth, so drift is surfaced, never auto-applied.
   *
   * activeOnly (default) scopes to open tickets so the periodic sweep stays
   * cheap on the FS rate limit; the full scan remains for post-outage recovery.
   * Read-only against FreshService — safe to run even when the OUTBOUND mirror
   * is disabled (dev).
   */
  async reconcile(workspaceId, { since = null, activeOnly = true, limit = 30 } = {}) {
    const client = await this._getClient(workspaceId);
    if (!client) return { skipped: true, reason: 'freshservice_not_configured' };

    // activeOnly = Open/Pending-BASE names from the workspace registry
    // (Phase 8b): a TP-born ticket parked in a custom open status must keep
    // reconciling against its FS mirror copy.
    const activeNames = activeOnly
      ? await statusService.statusNamesForBase(workspaceId, ['Open', 'Pending'])
      : null;
    const tickets = await prisma.ticket.findMany({
      where: {
        workspaceId,
        origin: TICKET_ORIGIN.TICKETPULSE,
        freshserviceTicketId: { not: null },
        ...(activeNames ? { status: { in: activeNames } } : {}),
        ...(since ? { mirroredAt: { gte: new Date(since) } } : {}),
      },
      include: { assignedTech: { select: { freshserviceId: true, name: true } } },
      orderBy: activeOnly ? { lastRealActivityAt: 'desc' } : { id: 'asc' },
      take: activeOnly ? limit : 500,
    });

    let imported = 0;
    let conflicts = 0;
    for (const ticket of tickets) {
      try {
        const result = await this._reconcileTicketAgainstFs(ticket, client);
        imported += result.imported;
        conflicts += result.conflicts;
      } catch (err) {
        logger.warn(`Reconciliation failed for ticket ${ticket.id} (non-fatal): ${err.message}`);
      }
    }

    if (tickets.length > 0) {
      logger.info(`Mirror reconciliation for workspace ${workspaceId}: ${tickets.length} tickets checked, ${imported} entries imported, ${conflicts} conflicts`);
    }
    return { checked: tickets.length, imported, conflicts };
  }

  /** Reconcile ONE TP-born ticket right now (used when a ticket page opens). */
  async reconcileTicket(ticketId, workspaceId) {
    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId, origin: TICKET_ORIGIN.TICKETPULSE, freshserviceTicketId: { not: null } },
      include: { assignedTech: { select: { freshserviceId: true, name: true } } },
    });
    if (!ticket) return { skipped: true };
    const client = await this._getClient(workspaceId);
    if (!client) return { skipped: true, reason: 'freshservice_not_configured' };
    return this._reconcileTicketAgainstFs(ticket, client);
  }

  async _reconcileTicketAgainstFs(ticket, client) {
    const workspaceId = ticket.workspaceId;
    const fsId = Number(ticket.freshserviceTicketId);
    let imported = 0;
    let conflicts = 0;

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
      // Per-message To/Cc (QA 08-05 #3): FS conversation objects carry
      // to_emails/cc_emails — keep them in rawPayload (the same shape the
      // regular FS conversation sync stores) so the UI can show recipients.
      const recipients = {};
      if (Array.isArray(conv.to_emails) && conv.to_emails.length) recipients.to_emails = conv.to_emails;
      if (Array.isArray(conv.cc_emails) && conv.cc_emails.length) recipients.cc_emails = conv.cc_emails;
      await prisma.ticketThreadEntry.create({
        data: {
          ticketId: ticket.id,
          workspaceId,
          externalEntryId,
          source: 'freshservice_reconciliation',
          eventType: conv.private ? 'note' : 'reply',
          // RFC 2047 encoded-words + mojibake repair for display names
          // (FR 08-05 item 2) — same treatment as parseRfc822Address.
          actorName: cleanDisplayName(conv.user_name || conv.from_email) || 'FreshService user',
          actorEmail: conv.from_email || null,
          authorType: conv.incoming ? 'requester' : 'agent',
          incoming: conv.incoming === true,
          isPrivate: conv.private === true,
          visibility: conv.private ? 'private' : 'public',
          bodyHtml: conv.body || null,
          bodyText: conv.body_text || null,
          content: conv.body_text || null,
          occurredAt: conv.created_at ? new Date(conv.created_at) : new Date(),
          ...(Object.keys(recipients).length ? { rawPayload: recipients } : {}),
        },
      });
      imported += 1;

      // Requester replies that arrived via FS behave like any other reply:
      // fire the workflow event (stable per-conversation stamp) + live update.
      if (conv.incoming === true && conv.private !== true) {
        import('./ticketLifecycleNotificationService.js')
          .then(({ emitTicketEvent }) => emitTicketEvent('ticket.reply_received', ticket.id, {
            source: 'freshservice_reconciliation',
            dedupeStamp: externalEntryId,
            extra: { externalEntryId, fromEmail: conv.from_email || null },
          }))
          .catch(() => {});
      }
      this._broadcast(ticket, 'reply');
    }

    if (fsTicket && typeof fsTicket === 'object' && fsTicket.id) {
      const fsStatusCode = Number(fsTicket.status);
      const ourStatusCode = await this._fsStatusCode(ticket);
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

    return { imported, conflicts };
  }

  // -------------------------------------------------- periodic reconcile

  /**
   * Periodic inbound reconcile (QA 07-06 #4: requester replies made in FS
   * never appeared in TP conversations because reconcile was never scheduled).
   * Independent of the OUTBOUND mirror flag — it's read-only against FS.
   */
  startReconcile() {
    if (this._reconcileTimer) return;
    if (process.env.NATIVE_TICKET_RECONCILE_ENABLED === 'false') return;
    const intervalMs = Number(process.env.NATIVE_TICKET_RECONCILE_INTERVAL_MS) || 3 * 60 * 1000;
    this._reconcileTimer = setInterval(() => {
      this._reconcileAllWorkspaces().catch((err) => logger.warn(`Mirror reconcile sweep failed (non-fatal): ${err.message}`));
    }, intervalMs);
    this._reconcileTimer.unref?.();
    logger.info(`Mirror inbound-reconcile worker started (every ${Math.round(intervalMs / 1000)}s)`);
  }

  stopReconcile() {
    if (this._reconcileTimer) clearInterval(this._reconcileTimer);
    this._reconcileTimer = null;
  }

  async _reconcileAllWorkspaces() {
    // Only workspaces that actually have TP-born mirrored tickets. This
    // candidate scan is cross-workspace (no registry to resolve against), so
    // it excludes the KNOWN-dead labels instead of listing open ones — a
    // workspace whose only mirrored tickets sit in custom statuses still
    // becomes a candidate; reconcile() then applies the workspace's own
    // registry-resolved open scope (Phase 8b).
    const rows = await prisma.ticket.groupBy({
      by: ['workspaceId'],
      where: {
        origin: TICKET_ORIGIN.TICKETPULSE,
        freshserviceTicketId: { not: null },
        status: { notIn: ['Deleted', 'Spam'] },
      },
    });
    for (const row of rows) {
      await this.reconcile(row.workspaceId, { activeOnly: true, limit: 30 }).catch(() => {});
    }
  }
}

export default new MirrorService();
