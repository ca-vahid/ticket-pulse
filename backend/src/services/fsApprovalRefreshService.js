/**
 * FreshService approval status, refreshed at lookup time (17 Sep 2026).
 *
 * The FreshService LIST payload the sync reads carries no `approval_status`
 * — only the single-ticket VIEW does (verified 17 Sep: 60 listed tickets, 39
 * service requests, none with the field; the view of the same ticket has it).
 * So the sync can never fill `tickets.fs_approval_status*`. Instead, the two
 * callers that decide on approvals (the ticket verdict and the hand-out check)
 * refresh the handful of tickets they are about to judge with one interactive
 * FreshService read each, persist the answer, and carry on. A five-minute
 * in-process cache keeps repeated lookups (an operator retrying) cheap, and an
 * APPROVED status is final — never re-fetched.
 *
 * Never throws: a FreshService hiccup leaves the stored value in place.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const recent = new Map(); // ticketId → checkedAt (ms)

export function resetFsApprovalRefreshCache() { recent.clear(); }

function needsRefresh(ticket, now) {
  if (!ticket?.id || !ticket.freshserviceTicketId) return false;
  if (String(ticket.fsApprovalStatusName || '').toLowerCase() === 'approved') return false;
  const last = recent.get(ticket.id);
  return !last || now - last > CACHE_TTL_MS;
}

/**
 * Refresh one ticket's FreshService approval status. Returns the (possibly
 * updated) `{ fsApprovalStatus, fsApprovalStatusName }`; mutates `ticket` too.
 */
export async function refreshFsApprovalStatus(ticket, { now = Date.now(), client = null } = {}) {
  const current = { fsApprovalStatus: ticket?.fsApprovalStatus ?? null, fsApprovalStatusName: ticket?.fsApprovalStatusName ?? null };
  if (!needsRefresh(ticket, now)) return current;
  recent.set(ticket.id, now);
  try {
    let fs = client;
    if (!fs) {
      const { default: mirrorService } = await import('./mirrorService.js');
      fs = await mirrorService.getInteractiveClient(ticket.workspaceId);
    }
    if (!fs?.fetchTicket) return current;
    const view = await fs.fetchTicket(Number(ticket.freshserviceTicketId));
    if (!view || view.approval_status === undefined) return current;
    const next = { fsApprovalStatus: view.approval_status ?? null, fsApprovalStatusName: view.approval_status_name ?? null };
    if (next.fsApprovalStatus !== current.fsApprovalStatus || next.fsApprovalStatusName !== current.fsApprovalStatusName) {
      await prisma.ticket.update({ where: { id: ticket.id }, data: next }).catch((err) => logger.debug?.(`fs approval status persist skipped for ${ticket.id}: ${err.message}`));
    }
    Object.assign(ticket, next);
    return next;
  } catch (err) {
    logger.debug?.(`fs approval status refresh skipped for ticket ${ticket?.id}: ${err.message}`);
    return current;
  }
}

/** Refresh a few tickets in parallel (the matched tickets of a hand-out check). Mutates in place. */
export async function refreshFsApprovalStatuses(tickets, opts = {}) {
  const list = (tickets || []).slice(0, 5);
  await Promise.all(list.map((t) => refreshFsApprovalStatus(t, opts)));
  return tickets;
}

export default { refreshFsApprovalStatus, refreshFsApprovalStatuses, resetFsApprovalRefreshCache };
