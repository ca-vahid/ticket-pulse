import prisma from './prisma.js';
import logger from '../utils/logger.js';
import statusService from './statusService.js';
import ticketActivityRepository from './ticketActivityRepository.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import { TICKET_CLOSED_VIA } from '../utils/approvalCloseReasons.js';

/**
 * A closed ticket ends its approvals (20 Nov 2026, product owner: "If a ticket
 * has an approval but it is closed, assume that the approval was decided
 * another way, so remove it and mark it as not needed any more").
 *
 * When a ticket's status BASE becomes Closed (Resolved is not enough: a
 * resolved ticket can still reopen), every approval on it that is still open
 * (pending or info_requested) ends as:
 *
 *   status       'closed'
 *   closeReason  'not_needed'
 *   decidedVia   'ticket_closed'
 *   decidedAt    now
 *   decisionNote "Not needed any more: the ticket was closed without a decision."
 *
 * Quietly: no e-mail to anyone, no Teams message, no workflow event, no note
 * on the conversation. What does happen: ONE history row on the ticket, the
 * Teams approval cards already sent are rewritten in place (they follow the
 * approval), an Assetron device hold is released, and open ticket pages refresh.
 *
 * Every road a ticket closes by reaches closeApprovalsAfterStatusChange():
 *   - ticketLifecycleNotificationService.emitTicketLifecycleNotifications
 *     (before its workflow gate): people in the app, the API, bulk, macros,
 *     auto-close-resolved, merges, FreshService sync / webhook / mirror-back;
 *   - ticketService.updateFsTicket when it is told not to notify (a
 *     workflow's FreshService status write-back);
 *   - notificationWorkflowEngine update_ticket on a TP-born ticket (writes the
 *     row directly);
 *   - syncService on-open reconcile (writes the row directly).
 */

export const OPEN_APPROVAL_STATUSES = Object.freeze(['pending', 'info_requested']);
export { TICKET_CLOSED_VIA };
export const TICKET_CLOSED_REASON = 'not_needed';
export const TICKET_CLOSED_NOTE = 'Not needed any more: the ticket was closed without a decision.';
export const TICKET_CLOSED_ACTIVITY = 'Approval no longer needed: the ticket was closed';
const PERFORMED_BY = 'Ticket Pulse';
const SWEEP_BATCH = 500;

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function baseOf(workspaceId, status) {
  if (status === undefined || status === null || status === '') return null;
  try {
    return await statusService.resolveBaseStatus(workspaceId, status);
  } catch {
    return null;
  }
}

function shapeApproval(row, ticket) {
  return {
    approvalId: row.id,
    ticketId: row.ticketId ?? ticket?.id ?? null,
    ticketRef: ticket ? ticketDisplayRef(ticket) : null,
    workspaceId: row.workspaceId ?? ticket?.workspaceId ?? null,
    status: row.status,
    approverEmail: row.approverEmail || null,
    requestGroupId: row.requestGroupId || null,
    requestedAt: row.createdAt || null,
    ticketStatus: ticket?.status ?? null,
    ticketClosedAt: ticket?.closedAt ?? null,
  };
}

function broadcastApprovals(ticket) {
  import('../routes/sse.routes.js')
    .then(({ sseManager }) => sseManager.broadcast('ticket-change', {
      action: 'approval',
      workspaceId: ticket.workspaceId,
      ticketId: ticket.id,
      origin: ticket.origin,
      displayRef: ticketDisplayRef(ticket),
    }, ticket.workspaceId))
    .catch(() => { /* SSE is optional plumbing */ });
}

/** Teams approval cards already sent are rewritten to the closed state (no new message). */
function refreshTeamsCards(ticketId) {
  return import('./teamsNotificationService.js')
    .then(({ default: teams }) => teams.refreshApprovalCards(ticketId))
    .catch((err) => logger.warn(`Teams approval card refresh skipped for ticket ${ticketId}: ${err.message}`));
}

/** A device held in Assetron for the request is released (closed = no decision is possible now). */
function releaseHolds(groupIds) {
  if (!groupIds.length) return Promise.resolve();
  return import('./assetronReservationService.js')
    .then(({ default: assetron }) => Promise.allSettled(groupIds.map((g) => assetron.touch(g))))
    .catch((err) => logger.warn(`Assetron hold release skipped: ${err.message}`));
}

/**
 * Close every open approval on one ticket, if the ticket is Closed NOW (read
 * fresh, so a ticket reopened a moment later keeps its approvals).
 *
 * @param {number} ticketId
 * @param {object} [opts]
 * @param {string} [opts.source] which road closed the ticket (for the history row and the log)
 * @param {boolean} [opts.dryRun] list what would close, write nothing
 * @returns {Promise<{ closed: number, approvals: object[], reason?: string }>} never throws
 */
export async function closeApprovalsForClosedTicket(ticketId, { source = null, dryRun = false } = {}) {
  const id = asNumber(ticketId);
  if (!id) return { closed: 0, approvals: [] };
  try {
    const open = await Promise.resolve()
      .then(() => prisma.ticketApproval.findMany({
        where: { ticketId: id, status: { in: [...OPEN_APPROVAL_STATUSES] } },
        orderBy: { id: 'asc' },
        select: { id: true, ticketId: true, workspaceId: true, status: true, approverEmail: true, requestGroupId: true, createdAt: true },
      }))
      .catch(() => []);
    if (!Array.isArray(open) || open.length === 0) return { closed: 0, approvals: [] };

    const ticket = await prisma.ticket.findUnique({
      where: { id },
      select: { id: true, workspaceId: true, status: true, origin: true, nativeNumber: true, freshserviceTicketId: true, closedAt: true },
    });
    if (!ticket) return { closed: 0, approvals: [], reason: 'ticket_not_found' };
    if (await baseOf(ticket.workspaceId, ticket.status) !== 'Closed') {
      return { closed: 0, approvals: [], reason: 'ticket_not_closed' };
    }
    const approvals = open.map((row) => shapeApproval(row, ticket));
    if (dryRun) return { closed: 0, wouldClose: approvals.length, approvals };

    const now = new Date();
    const result = await prisma.ticketApproval.updateMany({
      // The status guard keeps this idempotent and race-safe: a row an
      // approver decided a moment ago is left alone.
      where: { id: { in: open.map((r) => r.id) }, status: { in: [...OPEN_APPROVAL_STATUSES] } },
      data: {
        status: 'closed',
        closeReason: TICKET_CLOSED_REASON,
        decidedVia: TICKET_CLOSED_VIA,
        decidedAt: now,
        decisionNote: TICKET_CLOSED_NOTE,
        decisionNoteHtml: null,
      },
    });
    const count = Number(result?.count) || 0;
    if (count === 0) return { closed: 0, approvals: [] };

    // Which rows THIS write closed: a row decided between the read above and
    // the write is not one of them. decidedAt = this write's own stamp.
    const mine = await Promise.resolve()
      .then(() => prisma.ticketApproval.findMany({
        where: { id: { in: open.map((r) => r.id) }, status: 'closed', decidedVia: TICKET_CLOSED_VIA, decidedAt: now },
        select: { id: true },
      }))
      .catch(() => null);
    const closedIdSet = Array.isArray(mine)
      ? new Set(mine.map((r) => r.id))
      // Re-read failed: only an all-rows write is certain.
      : (count === open.length ? new Set(open.map((r) => r.id)) : new Set());
    const closedRows = open.filter((r) => closedIdSet.has(r.id));
    const closed = Array.isArray(mine) ? closedRows.length : (closedIdSet.size || count);
    if (closed === 0) return { closed: 0, approvals: [] };
    const closedApprovals = approvals.filter((a) => closedIdSet.has(a.approvalId));

    const groupIds = [...new Set(closedRows.map((r) => r.requestGroupId).filter(Boolean))];
    await ticketActivityRepository.create({
      ticketId: ticket.id,
      activityType: 'approval_closed',
      performedBy: PERFORMED_BY,
      performedAt: now,
      details: {
        via: TICKET_CLOSED_VIA,
        closeReason: TICKET_CLOSED_REASON,
        note: TICKET_CLOSED_ACTIVITY,
        approvalIds: closedRows.map((r) => r.id),
        requestGroupIds: groupIds,
        closed,
        ticketStatus: ticket.status,
        actorKind: 'system',
        ...(source ? { source } : {}),
      },
    }).catch((err) => logger.warn(`Approval close history row failed for ticket ${ticket.id} (non-fatal): ${err.message}`));

    broadcastApprovals(ticket);
    // Not awaited here (a person's click must not wait on Assetron or Teams);
    // `followUps` lets the sweep script wait for both before it exits.
    const followUps = Promise.allSettled([releaseHolds(groupIds), refreshTeamsCards(ticket.id)]);
    logger.info('Approvals closed: the ticket was closed', { ticketId: ticket.id, workspaceId: ticket.workspaceId, closed, source });
    return { closed, approvals: closedApprovals, followUps };
  } catch (err) {
    logger.warn(`Approval close on ticket close skipped for ticket ${id} (non-fatal): ${err.message}`);
    return { closed: 0, approvals: [] };
  }
}

/**
 * Status-change hook. Cheap: nothing is read unless the status moved and its
 * new base is Closed; then one indexed read by ticket id. Never throws.
 *
 * @param {object} before the ticket as it was ({ status, ... }); may lack id
 * @param {object} after  the ticket as it is now ({ id, workspaceId, status })
 */
export async function closeApprovalsAfterStatusChange(before, after, { source = null } = {}) {
  try {
    if (!before || !after) return { closed: 0, approvals: [] };
    const ticketId = asNumber(after.id) || asNumber(before.id);
    const workspaceId = asNumber(after.workspaceId) || asNumber(before.workspaceId);
    if (!ticketId || after.status === undefined || after.status === null) return { closed: 0, approvals: [] };
    if (String(after.status) === String(before.status ?? '')) return { closed: 0, approvals: [] };
    if (await baseOf(workspaceId, after.status) !== 'Closed') return { closed: 0, approvals: [] };
    return closeApprovalsForClosedTicket(ticketId, { source });
  } catch (err) {
    logger.warn(`Approval close hook skipped (non-fatal): ${err.message}`);
    return { closed: 0, approvals: [] };
  }
}

/**
 * One-off sweep for approvals left open on tickets that were closed before
 * this existed. Same rule, same quiet close as the hook.
 *
 * @param {object} [opts]
 * @param {number} [opts.workspaceId] one workspace; every workspace when omitted
 * @param {boolean} [opts.dryRun=true] list only; pass false to write
 * @returns {Promise<{ dryRun: boolean, tickets: number, approvals: object[], closed: number }>}
 */
export async function closeApprovalsOnClosedTickets({ workspaceId = null, dryRun = true } = {}) {
  const ws = asNumber(workspaceId);
  const found = [];
  let afterId = 0;
  for (;;) {
    const batch = await prisma.ticketApproval.findMany({
      where: { status: { in: [...OPEN_APPROVAL_STATUSES] }, id: { gt: afterId }, ...(ws ? { workspaceId: ws } : {}) },
      orderBy: { id: 'asc' },
      take: SWEEP_BATCH,
      select: {
        id: true, ticketId: true, workspaceId: true, status: true, approverEmail: true, requestGroupId: true, createdAt: true,
        ticket: { select: { id: true, workspaceId: true, status: true, origin: true, nativeNumber: true, freshserviceTicketId: true, closedAt: true } },
      },
    });
    if (!batch.length) break;
    afterId = batch[batch.length - 1].id;
    for (const row of batch) {
      if (!row.ticket) continue;
      if (await baseOf(row.ticket.workspaceId, row.ticket.status) !== 'Closed') continue;
      found.push(shapeApproval(row, row.ticket));
    }
    if (batch.length < SWEEP_BATCH) break;
  }

  const ticketIds = [...new Set(found.map((a) => a.ticketId))];
  if (dryRun) return { dryRun: true, tickets: ticketIds.length, approvals: found, closed: 0 };

  let closed = 0;
  const closedIds = new Set();
  const followUps = [];
  for (const ticketId of ticketIds) {
    const res = await closeApprovalsForClosedTicket(ticketId, { source: 'sweep' });
    closed += res.closed;
    // Only the rows this run actually closed (re-read by the close itself).
    for (const a of res.approvals || []) closedIds.add(a.approvalId);
    if (res.followUps) followUps.push(res.followUps);
  }
  // The Assetron release and the Teams card refresh finish before the sweep
  // reports, so a script can exit straight after it.
  await Promise.allSettled(followUps);
  return {
    dryRun: false,
    tickets: ticketIds.length,
    approvals: found.map((a) => ({ ...a, applied: closedIds.has(a.approvalId) })),
    closed,
  };
}

export default { closeApprovalsForClosedTicket, closeApprovalsAfterStatusChange, closeApprovalsOnClosedTickets };
