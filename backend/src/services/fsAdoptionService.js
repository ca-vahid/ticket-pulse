/**
 * Adoption of FreshService-born tickets (FreshService exit A3, 25 Nov 2026).
 *
 * An adopted ticket becomes a Ticket Pulse ticket for good:
 *   - `origin` → 'ticketpulse' and a TP number is assigned, so it reads TP-n;
 *   - `mirrorState` → 'adopted' — the marker every FreshService path checks:
 *     an adopted ticket's FS id is a TOMBSTONE, never a live copy;
 *   - `freshserviceTicketId` is KEPT (it is unique and sync finds rows by it,
 *     so a still-connected sync never re-imports the FS ticket as a duplicate);
 *   - an `adopted_from_freshservice` history row records the old FS number;
 *   - its FreshService files are pre-stored while FreshService still answers.
 *
 * Callers: the switch-off flow (`adoptWorkspace`, reason 'switch_off'), a
 * requester reply to imported history in an Off workspace ('requester_reply',
 * mailboxIngestService), an agent's "Adopt to edit" or any write a person
 * makes to imported history in an Off workspace ('agent'), and the same write
 * from an API key or integration ('api_write') — ticketService adopts on the
 * write instead of refusing it.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { TICKET_ORIGIN, ticketDisplayRef } from '../utils/ticketOrigin.js';
import { fsGate } from './fsModeService.js';
import { reconcileSlot } from '../utils/fsBackgroundPace.js';
import { actorKindOf } from '../utils/actorKind.js';

export const ADOPTED_MIRROR_STATE = 'adopted';
export const ADOPTION_ACTIVITY = 'adopted_from_freshservice';
// 'api_write': an API key / personal key / integration wrote to an imported
// ticket in an Off workspace (adopted on the write, never refused).
export const ADOPTION_REASONS = Object.freeze(['switch_off', 'requester_reply', 'agent', 'api_write']);

/** Statuses that never count as "open" whatever the workspace calls them. */
const TERMINAL_LABELS = ['Closed', 'Resolved', 'closed', 'resolved', 'Deleted', 'Spam', 'deleted', 'spam', '4', '5'];
const SAMPLE_SIZE = 20;

/**
 * The adoption reason for a write by this actor: an API key, a personal key or
 * an integration → 'api_write'; a person (or a workflow acting for one) → 'agent'.
 */
export function adoptionReasonFor(actor) {
  if (!actor || typeof actor !== 'object') return 'agent';
  if (actor.via?.kind === 'personal_key' || actor.apiKeyId || actor.apiKey) return 'api_write';
  const role = String(actor.role || '').toLowerCase();
  if (role === 'api' || role === 'integration') return 'api_write';
  return actorKindOf(actor) === 'api' ? 'api_write' : 'agent';
}

const BACKGROUND_ROLES = new Set(['automation', 'workflow', 'system']);
const BACKGROUND_KINDS = new Set(['system', 'workflow', 'ai', 'auto_help', 'reconcile', 'mirror', 'freshservice_sync']);

/**
 * A background writer: Ticket Pulse itself, a workflow or an automation
 * (auto-close, grouping, park wake, alert correlation, noise close, owner-away
 * reroute …). Such writes never adopt imported history: they skip it. People,
 * API keys, personal keys and integrations are not background writers.
 */
export function isBackgroundWriter(actor) {
  if (!actor || typeof actor !== 'object') return true;
  if (adoptionReasonFor(actor) === 'api_write') return false;
  if (BACKGROUND_ROLES.has(String(actor.role || '').toLowerCase())) return true;
  if (BACKGROUND_ROLES.has(String(actor.kind || '').toLowerCase())) return true;
  return BACKGROUND_KINDS.has(actorKindOf(actor));
}

/** True for a ticket adopted from FreshService (its FS id is a tombstone). */
export function isAdoptedTicket(ticket) {
  return ticket?.mirrorState === ADOPTED_MIRROR_STATE;
}

async function terminalStatusNames(workspaceId) {
  const names = new Set(TERMINAL_LABELS);
  try {
    const { default: statusService } = await import('./statusService.js');
    const rows = await statusService.listStatuses(workspaceId, { includeInactive: true });
    for (const s of rows || []) {
      if (s?.name && ['Resolved', 'Closed'].includes(s.baseStatus)) names.add(s.name);
    }
  } catch (err) {
    logger.debug?.(`fsAdoption: status registry read failed for workspace ${workspaceId} (labels only): ${err.message}`);
  }
  return [...names];
}

async function openFsBornWhere(workspaceId) {
  return {
    workspaceId,
    origin: TICKET_ORIGIN.FRESHSERVICE,
    status: { notIn: await terminalStatusNames(workspaceId) },
  };
}

async function nextNativeNumber() {
  // Same sequence (and logic) as ticketService._nextNativeNumber.
  const { default: ticketService } = await import('./ticketService.js');
  if (typeof ticketService?._nextNativeNumber === 'function') return ticketService._nextNativeNumber();
  const rows = await prisma.$queryRaw`SELECT nextval('ticket_native_number_seq')::int AS "nextval"`;
  return rows[0].nextval;
}

function actorLabel(actorEmail, reason) {
  if (actorEmail) return actorEmail;
  return reason === 'requester_reply' ? 'Ticket Pulse (requester replied)' : 'Ticket Pulse';
}

class FsAdoptionService {
  /**
   * Adopt one FS-born ticket of this workspace. Idempotent: an adopted ticket
   * comes back as it is. Returns the ticket row (with `displayRef`,
   * `adopted: true`, and `alreadyAdopted` when nothing changed).
   */
  async adoptTicket(ticketId, workspaceId, { actorEmail = null, reason = 'agent' } = {}) {
    const ws = Number(workspaceId);
    const why = ADOPTION_REASONS.includes(reason) ? reason : 'agent';
    const ticket = await prisma.ticket.findFirst({ where: { id: Number(ticketId), workspaceId: ws } });
    if (!ticket) throw new NotFoundError(`Ticket ${ticketId} not found in this workspace`);
    if (isAdoptedTicket(ticket)) {
      return { ...ticket, displayRef: ticketDisplayRef(ticket), adopted: true, alreadyAdopted: true };
    }
    if (ticket.origin !== TICKET_ORIGIN.FRESHSERVICE) {
      throw new ValidationError('This is already a Ticket Pulse ticket; there is nothing to adopt.');
    }

    // A sequence value is not transactional; one lost to a race is harmless.
    const nativeNumber = ticket.nativeNumber ?? await nextNativeNumber();
    const fsTicketId = ticket.freshserviceTicketId !== null && ticket.freshserviceTicketId !== undefined
      ? Number(ticket.freshserviceTicketId) : null;
    const now = new Date();

    const adopted = await prisma.$transaction(async (tx) => {
      // Conditional flip: a concurrent adoption (or a racing sync) wins once.
      const flipped = await tx.ticket.updateMany({
        where: { id: ticket.id, workspaceId: ws, origin: TICKET_ORIGIN.FRESHSERVICE },
        data: {
          origin: TICKET_ORIGIN.TICKETPULSE,
          nativeNumber,
          mirrorState: ADOPTED_MIRROR_STATE,
          mirrorError: null,
        },
      });
      if (!flipped?.count) return null;
      await tx.ticketActivity.create({
        data: {
          ticketId: ticket.id,
          activityType: ADOPTION_ACTIVITY,
          performedBy: actorLabel(actorEmail, why),
          performedAt: now,
          details: {
            source: 'ticketpulse_native',
            actorEmail: actorEmail || null,
            actorKind: why === 'api_write' ? 'api' : (actorEmail && why !== 'requester_reply' ? 'human' : 'system'),
            fsTicketId,
            reason: why,
            adoptedBy: actorEmail || null,
          },
        },
      });
      return tx.ticket.findUnique({ where: { id: ticket.id } });
    });

    if (!adopted) {
      // Lost the race: whoever won adopted it (or it is no longer FS-born).
      const current = await prisma.ticket.findFirst({ where: { id: ticket.id, workspaceId: ws } });
      if (isAdoptedTicket(current)) {
        return { ...current, displayRef: ticketDisplayRef(current), adopted: true, alreadyAdopted: true };
      }
      throw new ValidationError('This ticket changed while it was being adopted; try again.');
    }

    logger.info(`Adopted FreshService #${fsTicketId ?? '?'} as ${ticketDisplayRef(adopted)} (ticket ${ticket.id}, workspace ${ws}, ${why}, by ${actorEmail || 'system'})`);

    // Best effort, outside the transaction: store its FreshService files while
    // FreshService still answers (never in an Off workspace).
    try {
      const { default: attachmentService } = await import('./attachmentService.js');
      if (typeof attachmentService?.storeFsAttachmentsForTicket === 'function' && await fsGate(ws, 'attachment')) {
        const stored = await attachmentService.storeFsAttachmentsForTicket(ticket.id);
        const failedCount = Array.isArray(stored?.failed) ? stored.failed.length : Number(stored?.failed) || 0;
        if (failedCount) {
          logger.warn(`Adoption of ticket ${ticket.id}: ${failedCount} of ${stored.total ?? '?'} FreshService file(s) not stored (non-fatal)`);
        }
      }
    } catch (err) {
      logger.warn(`Adoption of ticket ${ticket.id}: FreshService files not stored (non-fatal): ${err.message}`);
    }

    try {
      const { default: ticketService } = await import('./ticketService.js');
      ticketService?._broadcast?.(ws, 'adopted', adopted, { fsTicketId });
    } catch { /* broadcast is cosmetic */ }

    return { ...adopted, displayRef: ticketDisplayRef(adopted), adopted: true, alreadyAdopted: false };
  }

  /**
   * A write reached imported history (an FS-born ticket in an Off workspace):
   * adopt it for that write. The reason follows the actor (adoptionReasonFor).
   * A background writer (isBackgroundWriter) never adopts: returns null and
   * the caller leaves the imported ticket as it is.
   */
  async adoptForWrite(ticketId, workspaceId, actor) {
    if (isBackgroundWriter(actor)) {
      logger.debug?.(`Imported ticket ${ticketId} (workspace ${workspaceId}) left as it is: a background write (${actor?.name || actor?.role || 'system'}) never adopts it`);
      return null;
    }
    return this.adoptTicket(ticketId, workspaceId, { actorEmail: actor?.email || null, reason: adoptionReasonFor(actor) });
  }

  /**
   * What switching this workspace Off would leave behind:
   *   openFsBorn          open FS-born tickets to adopt;
   *   uncachedAttachments FreshService files on FS-born (and adopted) tickets not known to be
   *                       stored in Ticket Pulse (they die with FreshService);
   *   sample              up to 20 of the open FS-born tickets.
   */
  async previewWorkspace(workspaceId) {
    const ws = Number(workspaceId);
    const where = await openFsBornWhere(ws);
    const [openFsBorn, rows, uncached] = await Promise.all([
      prisma.ticket.count({ where }),
      prisma.ticket.findMany({
        where,
        select: { id: true, origin: true, nativeNumber: true, freshserviceTicketId: true, subject: true, status: true },
        orderBy: { id: 'desc' },
        take: SAMPLE_SIZE,
      }),
      this._uncachedAttachments(ws),
    ]);
    return {
      openFsBorn,
      uncachedAttachments: uncached.count,
      uncachedAttachmentsBasis: uncached.basis,
      sample: (rows || []).map((t) => ({ id: t.id, ref: ticketDisplayRef(t), subject: t.subject || null, status: t.status })),
    };
  }

  /**
   * FreshService files on this workspace's FS-born tickets with no stored blob.
   * FS attachments are recorded as metadata-only rows (source 'freshservice')
   * and cached in blob storage on first download; nothing in the row marks the
   * cache. When the attachment service offers an exact count it is used;
   * otherwise every FS metadata row counts (an upper bound).
   */
  async _uncachedAttachments(ws) {
    try {
      const { default: attachmentService } = await import('./attachmentService.js');
      if (typeof attachmentService?.countUnstoredFsAttachments === 'function') {
        const n = await attachmentService.countUnstoredFsAttachments(ws);
        if (Number.isFinite(Number(n))) return { count: Number(n), basis: 'stored_check' };
      }
    } catch (err) {
      logger.debug?.(`fsAdoption: exact unstored count unavailable for workspace ${ws}: ${err.message}`);
    }
    const count = await prisma.ticketAttachment.count({
      where: {
        workspaceId: ws,
        source: 'freshservice',
        ticket: { OR: [{ origin: TICKET_ORIGIN.FRESHSERVICE }, { mirrorState: ADOPTED_MIRROR_STATE }] },
      },
    });
    return { count, basis: 'metadata_rows' };
  }

  /**
   * Adopt every open FS-born ticket of the workspace (reason 'switch_off').
   * Paced like the other background FreshService readers (one ticket per
   * shared slot, ~1/s), because storing each ticket's files calls FreshService.
   * Idempotent and safe to re-run: adopted tickets are no longer FS-born.
   * `onProgress({ done, total, adopted, failed, ticketId })` after each ticket.
   */
  async adoptWorkspace(workspaceId, { actorEmail = null, onProgress = null } = {}) {
    const ws = Number(workspaceId);
    const rows = await prisma.ticket.findMany({
      where: await openFsBornWhere(ws),
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const total = rows.length;
    let adopted = 0;
    const failed = [];
    for (let i = 0; i < rows.length; i += 1) {
      const { id } = rows[i];
      try {
        await reconcileSlot();
        const result = await this.adoptTicket(id, ws, { actorEmail, reason: 'switch_off' });
        if (!result?.alreadyAdopted) adopted += 1;
      } catch (err) {
        failed.push({ id, error: err?.message || String(err) });
        logger.warn(`Adoption of ticket ${id} (workspace ${ws}) failed: ${err?.message || err}`);
      }
      if (typeof onProgress === 'function') {
        try {
          await onProgress({ done: i + 1, total, adopted, failed: failed.length, ticketId: id });
        } catch { /* progress reporting never stops the run */ }
      }
    }
    logger.info(`Workspace ${ws}: adopted ${adopted} of ${total} open FreshService ticket(s)${failed.length ? `, ${failed.length} failed` : ''}`);
    return { adopted, failed, total };
  }
}

const fsAdoptionService = new FsAdoptionService();
export default fsAdoptionService;
