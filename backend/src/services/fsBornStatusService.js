/**
 * Status change on a FreshService-born ticket through the public API
 * (Vahid + TP Dev, 23 Sep 2026: ContinuIT resolves a linked #<fsid> ticket
 * when a meeting reports the work done).
 *
 * FreshService stays the owner. The write goes through the sanctioned seam,
 * ticketService.updateFsTicket (registry validation, bound FS status id,
 * one PUT, echo check — the TP row changes only when FS took the value —
 * the RO-5 hold against the next sync, audit, lifecycle notify). This file
 * adds what changeStatus does for TP-born tickets and updateFsTicket does not:
 *
 *   - roll-up: a parent with open children cannot be closed (409 open_children)
 *   - resolution reason: required on Security tickets, validated BEFORE FS is
 *     touched, and stamped on the TP row only AFTER FS accepted
 *   - roll-up readiness for the parent after a child's status moves
 *
 * The caller must hold the per-client `fsStatusWrite` opt-in (checked in the
 * route). updateFsTicket's signature is deliberately untouched (the Parked
 * tickets build hooks into it).
 */
import prisma from './prisma.js';
import statusService from './statusService.js';
import ticketService from './ticketService.js';
import ticketRollUpService from './ticketRollUpService.js';
import { requiresResolutionReason, validateResolution, resolvedByKindFromActor } from './resolutionReasonService.js';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors.js';
import { TICKET_ORIGIN } from '../utils/ticketOrigin.js';

const TERMINAL = ['Resolved', 'Closed'];

/** Is this ticket FreshService-born (the only case this service handles)? */
// A lookup problem (or a missing row) answers false: the caller then takes the
// Ticket Pulse path, which reports "not found" or refuses an FS-born ticket
// exactly as before this feature existed.
export async function isFreshServiceBorn(ticketId, workspaceId) {
  const t = await Promise.resolve()
    .then(() => prisma.ticket.findFirst({ where: { id: ticketId, workspaceId }, select: { origin: true, freshserviceTicketId: true } }))
    .catch(() => null);
  if (!t) return false;
  return t.origin !== TICKET_ORIGIN.TICKETPULSE && !!t.freshserviceTicketId;
}

/**
 * Change the status of an FS-born ticket, FreshService first.
 * Errors: ValidationError (bad status / missing or bad resolution reason,
 * before any write); ConflictError open_children; ConflictError
 * freshservice_rejected when FreshService refused or did not keep the value.
 */
export async function changeFsBornStatus(ticketId, workspaceId, status, actor, { resolutionReason = null, resolutionNote = null } = {}) {
  const ticket = await prisma.ticket.findFirst({
    where: { id: ticketId, workspaceId },
    select: {
      id: true, status: true, origin: true, freshserviceTicketId: true, resolutionReason: true, resolvedByKind: true,
      internalCategory: { select: { name: true } },
    },
  });
  if (!ticket) throw new NotFoundError(`Ticket ${ticketId} not found in this workspace`);

  // Validation first — nothing may reach FreshService that we would refuse.
  const normalized = await statusService.assertValidStatus(workspaceId, status);
  if (normalized === ticket.status) return { changed: false, status: normalized };
  const oldBase = await statusService.baseStatusOf(workspaceId, ticket.status);
  const newBase = await statusService.baseStatusOf(workspaceId, normalized);
  const wasTerminal = TERMINAL.includes(oldBase);
  const isTerminal = TERMINAL.includes(newBase);

  let resolution = { resolutionReason: null, resolutionNote: null };
  if (isTerminal && !wasTerminal) {
    await ticketRollUpService.assertNoOpenChildren(ticket.id, workspaceId);
    resolution = validateResolution(
      { resolutionReason, resolutionNote },
      { required: requiresResolutionReason(ticket) && !ticket.resolutionReason },
    );
  }

  try {
    await ticketService.updateFsTicket(ticket.id, workspaceId, { status: normalized }, actor);
  } catch (err) {
    if (err instanceof ValidationError) {
      const e = new ConflictError(`FreshService did not accept the status change: ${err.message}`);
      e.code = 'freshservice_rejected';
      throw e;
    }
    throw err;
  }

  // FreshService took it (updateFsTicket updated our row). Now the TP-only fields.
  const patch = {};
  if (isTerminal && !wasTerminal) {
    const kind = resolvedByKindFromActor(actor);
    if (resolution.resolutionReason) {
      patch.resolutionReason = resolution.resolutionReason;
      patch.resolutionNote = resolution.resolutionNote;
      patch.resolvedByKind = kind;
    } else if (!ticket.resolvedByKind) {
      patch.resolvedByKind = kind;
    }
  } else if (wasTerminal && !isTerminal) {
    patch.resolutionReason = null;
    patch.resolutionNote = null;
    patch.resolvedByKind = null;
  }
  if (Object.keys(patch).length) {
    await prisma.ticket.update({ where: { id: ticket.id }, data: patch }).catch(() => {});
  }

  await Promise.resolve()
    .then(() => ticketRollUpService.afterChildStatusChange(ticket.id, workspaceId, { actor }))
    .catch(() => {});
  if (wasTerminal && !isTerminal) {
    await Promise.resolve()
      .then(() => ticketRollUpService.recomputeReadiness(ticket.id, workspaceId, { actor }))
      .catch(() => {});
  }
  return { changed: true, status: normalized, from: ticket.status };
}

export default { isFreshServiceBorn, changeFsBornStatus };
