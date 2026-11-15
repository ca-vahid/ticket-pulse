import prisma from './prisma.js';
import logger from '../utils/logger.js';
import statusService from './statusService.js';

/**
 * The review queue settles itself (MEGA 11-14 Part B).
 *
 * An AI suggestion waiting for review (run status 'completed', decision
 * 'pending_review') has nothing left to decide once its ticket has an owner,
 * is resolved or closed, deleted, or marked spam / noise. Such runs are
 * SETTLED: decision 'settled_elsewhere', with when (decidedAt), who
 * (decidedByEmail: the person's address, or a `system:<source>` marker) and
 * why (decisionNote). Nothing else happens: no assignment, no e-mail, no Teams
 * card, no competency feedback (the learner reads approved / modified /
 * auto_assigned and the close itself, never this decision).
 *
 * Two ways in, one rule:
 *   settleForTicket()  called where a ticket changes (lifecycle emitter, the
 *                      ticket service, sync reconcile, the pipeline's own
 *                      completion). One indexed read by ticket id; nothing
 *                      else when the ticket has no open review.
 *   clearBacklog()     the "Clear N settled items" button in Assignment Review
 *                      for runs left from before this existed. Same rule, same
 *                      note, idempotent: a second click finds nothing.
 */

export const SETTLED_DECISION = 'settled_elsewhere';
export const SYSTEM_MARKER_PREFIX = 'system:';
const OPEN_REVIEW = { status: 'completed', decision: 'pending_review' };
const REMOVED_STATUSES = ['Deleted', 'Spam'];
const BACKLOG_BATCH = 500;
const BACKLOG_MAX_PER_CLICK = 20000;

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The marker stored in decidedByEmail when no person made the change. */
export function systemMarker(source) {
  const clean = String(source || 'ticket-pulse').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${SYSTEM_MARKER_PREFIX}${clean || 'ticket-pulse'}`.slice(0, 255);
}

/** A person's address when the actor is a person; otherwise the system marker. */
export function decidedByFor(actor, source) {
  const email = String(actor?.email || '').trim();
  if (email && email.includes('@')) return email.slice(0, 255);
  return systemMarker(source);
}

/**
 * Why a ticket no longer needs a review, or null when it still does.
 * `base` is the status's base (Open / Pending / Resolved / Closed) when known.
 * Order: removed beats closed beats assigned (a closed ticket with an owner
 * reads as closed).
 */
export function settleReasonFor(ticket, { base = null, noise = false } = {}) {
  if (!ticket) return null;
  const status = String(ticket.status || '');
  if (status === 'Deleted') return { kind: 'deleted' };
  if (status === 'Spam') return { kind: 'spam' };
  if (base === 'Resolved' || base === 'Closed') return { kind: 'closed', status };
  if (asNumber(ticket.assignedTechId)) return { kind: 'assigned', techId: asNumber(ticket.assignedTechId) };
  if (noise || ticket.isNoise === true) return { kind: 'noise' };
  return null;
}

/** One plain sentence for the run's decision note. */
export function settleNote(reason, { techName = null, actorName = null, via = null } = {}) {
  if (!reason) return null;
  const by = actorName ? ` by ${actorName}` : '';
  const where = via ? ` ${via}` : '';
  let what;
  switch (reason.kind) {
  case 'deleted': what = `Ticket deleted${by}${where}.`; break;
  case 'spam': what = `Ticket marked as spam${by}${where}.`; break;
  case 'noise': what = `Ticket marked as noise${by}${where}.`; break;
  case 'closed': {
    const name = String(reason.status || 'Closed');
    const verb = ['resolved', 'closed'].includes(name.toLowerCase()) ? name.toLowerCase() : `closed (${name})`;
    what = `Ticket ${verb}${by}${where}.`;
    break;
  }
  case 'assigned':
  default:
    what = `Ticket assigned to ${techName || 'someone'}${by}${where}.`;
  }
  return `${what} The suggestion was settled; nothing was assigned and nobody was told.`;
}

const VIA_LABEL = {
  freshservice: 'in FreshService',
  freshservice_sync: 'in FreshService',
  freshservice_webhook: 'in FreshService',
  freshservice_sync_snapshot: 'in FreshService',
  reconcile: 'in FreshService',
  workflow: 'by a workflow',
  api: 'through the API',
  assignment_pipeline: 'by the assignment pipeline',
  pipeline: null,
  ticketpulse_native: null,
  backlog: null,
};

function viaFor(source) {
  const key = String(source || '');
  if (Object.prototype.hasOwnProperty.call(VIA_LABEL, key)) return VIA_LABEL[key];
  return key.startsWith('freshservice') ? 'in FreshService' : null;
}

async function baseOf(workspaceId, status) {
  if (!status) return null;
  if (REMOVED_STATUSES.includes(String(status))) return null;
  try {
    return await statusService.resolveBaseStatus(workspaceId, status);
  } catch {
    return null;
  }
}

async function techNameOf(techId, ticket) {
  if (!techId) return null;
  if (ticket?.assignedTech?.name && Number(ticket.assignedTech.id ?? techId) === techId) return ticket.assignedTech.name;
  const row = await Promise.resolve()
    .then(() => prisma.technician.findUnique({ where: { id: techId }, select: { name: true } }))
    .catch(() => null);
  return row?.name || null;
}

async function broadcastSettled(workspaceId, ticketId, count) {
  try {
    const { sseManager } = await import('../routes/sse.routes.js');
    sseManager.broadcast('ticket-change', {
      action: 'pipeline', workspaceId, ticketId, runId: null, status: 'completed', decision: SETTLED_DECISION, settled: count,
    }, workspaceId);
  } catch { /* SSE is optional plumbing */ }
}

class ReviewQueueSettleService {
  /**
   * Settle every open review on one ticket if the ticket no longer needs one.
   *
   * @param {object|number} ticketOrId the ticket row ({ id, workspaceId, status, assignedTechId, isNoise, assignedTech? }) or its id
   * @param {object} [opts]
   * @param {object} [opts.actor]  who changed the ticket ({ name, email }); null for system paths
   * @param {string} [opts.source] where the change came from (freshservice_sync, workflow, api, pipeline, …)
   * @param {boolean} [opts.noise] the change was "marked as noise" (setNoise)
   * @returns {Promise<{ settled: number, reason?: string }>} never throws
   */
  async settleForTicket(ticketOrId, { actor = null, source = 'ticket-pulse', noise = false } = {}) {
    try {
      const ticketId = asNumber(typeof ticketOrId === 'object' && ticketOrId ? ticketOrId.id : ticketOrId);
      if (!ticketId) return { settled: 0 };
      const open = await prisma.assignmentPipelineRun.findMany({
        where: { ticketId, ...OPEN_REVIEW },
        select: { id: true, workspaceId: true },
        take: 50,
      });
      if (!open.length) return { settled: 0 };

      let ticket = typeof ticketOrId === 'object' && ticketOrId ? ticketOrId : null;
      if (!ticket || ticket.status === undefined || ticket.assignedTechId === undefined) {
        ticket = await prisma.ticket.findUnique({
          where: { id: ticketId },
          select: { id: true, workspaceId: true, status: true, assignedTechId: true, isNoise: true, assignedTech: { select: { id: true, name: true } } },
        });
      }
      if (!ticket) return { settled: 0 };
      const workspaceId = asNumber(ticket.workspaceId) || open[0].workspaceId;
      const base = await baseOf(workspaceId, ticket.status);
      const reason = settleReasonFor(ticket, { base, noise });
      if (!reason) return { settled: 0 };

      const techName = reason.kind === 'assigned' ? await techNameOf(reason.techId, ticket) : null;
      const actorName = actor?.name && !/^notification workflow$/i.test(actor.name) ? String(actor.name) : null;
      const decisionNote = settleNote(reason, { techName, actorName, via: viaFor(source) });
      const result = await prisma.assignmentPipelineRun.updateMany({
        // The decision guard keeps this idempotent and race-safe: a run a
        // reviewer decided a moment ago is left alone.
        where: { id: { in: open.map((r) => r.id) }, ...OPEN_REVIEW },
        data: {
          decision: SETTLED_DECISION,
          decidedAt: new Date(),
          decidedByEmail: decidedByFor(actor, source),
          decisionNote,
        },
      });
      const settled = Number(result?.count) || 0;
      if (settled > 0) {
        logger.info('Review queue: settled open reviews', { ticketId, workspaceId, settled, reason: reason.kind, source });
        await broadcastSettled(workspaceId, ticketId, settled);
      }
      return { settled, reason: reason.kind };
    } catch (err) {
      logger.warn(`Review queue settle skipped for ticket ${typeof ticketOrId === 'object' ? ticketOrId?.id : ticketOrId} (non-fatal): ${err.message}`);
      return { settled: 0 };
    }
  }

  /**
   * Lifecycle hook: settle only when this change gave the ticket an owner or
   * closed / removed it. Cheap: no read at all for other changes.
   */
  async settleOnChange(existingTicket, updatedTicket, { actor = null, source = 'ticket-pulse' } = {}) {
    if (!existingTicket || !updatedTicket?.id) return { settled: 0 };
    const gotOwner = asNumber(updatedTicket.assignedTechId)
      && asNumber(updatedTicket.assignedTechId) !== asNumber(existingTicket.assignedTechId);
    const statusMoved = updatedTicket.status !== undefined && updatedTicket.status !== existingTicket.status;
    if (!gotOwner && !statusMoved) return { settled: 0 };
    return this.settleForTicket(updatedTicket, { actor, source });
  }

  /** Every status name that counts as closed or removed in this workspace (retired ones too). */
  async _closedNames(workspaceId) {
    const rows = await statusService.listStatuses(workspaceId, { includeInactive: true }).catch(() => []);
    const names = new Set(['Resolved', 'Closed', 'resolved', 'closed', '4', '5', ...REMOVED_STATUSES]);
    for (const r of rows || []) if (r.baseStatus === 'Resolved' || r.baseStatus === 'Closed') names.add(r.name);
    return [...names];
  }

  _backlogWhere(workspaceId, closedNames) {
    return {
      workspaceId,
      ...OPEN_REVIEW,
      ticket: {
        is: {
          OR: [
            { assignedTechId: { not: null } },
            { status: { in: closedNames } },
          ],
        },
      },
    };
  }

  /** How many open reviews in this workspace are already settled elsewhere. */
  async countBacklog(workspaceId) {
    const ws = asNumber(workspaceId);
    if (!ws) return 0;
    const closedNames = await this._closedNames(ws);
    return prisma.assignmentPipelineRun.count({ where: this._backlogWhere(ws, closedNames) });
  }

  /**
   * Settle the backlog for one workspace, in batches. Same rule and note as
   * settleForTicket, recorded as cleared by the admin who clicked.
   * @returns {Promise<{ settled: number, remaining: number }>}
   */
  async clearBacklog(workspaceId, { actor = null } = {}) {
    const ws = asNumber(workspaceId);
    if (!ws) return { settled: 0, remaining: 0 };
    const closedNames = await this._closedNames(ws);
    const where = this._backlogWhere(ws, closedNames);
    const decidedByEmail = decidedByFor(actor, 'backlog');
    const clearedBy = actor?.name || actor?.email || null;
    let settled = 0;
    while (settled < BACKLOG_MAX_PER_CLICK) {
      const batch = await prisma.assignmentPipelineRun.findMany({
        where,
        select: {
          id: true,
          ticket: { select: { id: true, status: true, assignedTechId: true, isNoise: true, assignedTech: { select: { id: true, name: true } } } },
        },
        orderBy: { id: 'asc' },
        take: BACKLOG_BATCH,
      });
      if (!batch.length) break;
      // Group by note so one update covers every run with the same sentence.
      const byNote = new Map();
      for (const run of batch) {
        const t = run.ticket || {};
        const closed = closedNames.includes(String(t.status)) && !REMOVED_STATUSES.includes(String(t.status));
        const reason = settleReasonFor(t, { base: closed ? 'Closed' : null });
        if (!reason) continue;
        const base = settleNote(reason, { techName: t.assignedTech?.name || null });
        const note = clearedBy ? `${base} Cleared from the review queue by ${clearedBy}.` : base;
        if (!byNote.has(note)) byNote.set(note, []);
        byNote.get(note).push(run.id);
      }
      let thisBatch = 0;
      const now = new Date();
      for (const [decisionNote, ids] of byNote) {
        const res = await prisma.assignmentPipelineRun.updateMany({
          where: { id: { in: ids }, ...OPEN_REVIEW },
          data: { decision: SETTLED_DECISION, decidedAt: now, decidedByEmail, decisionNote },
        });
        thisBatch += Number(res?.count) || 0;
      }
      settled += thisBatch;
      if (thisBatch === 0) break; // nothing moved: never spin
    }
    const remaining = await prisma.assignmentPipelineRun.count({ where }).catch(() => 0);
    logger.info('Review queue: backlog cleared', { workspaceId: ws, settled, remaining, by: decidedByEmail });
    if (settled > 0) await broadcastSettled(ws, null, settled);
    return { settled, remaining };
  }
}

export default new ReviewQueueSettleService();
