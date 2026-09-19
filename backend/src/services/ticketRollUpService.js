import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ConflictError } from '../utils/errors.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import statusService, { TERMINAL_BASE_STATUSES } from './statusService.js';
import ticketActivityRepository from './ticketActivityRepository.js';
import { sendTransactionalEmail } from './transactionalEmailService.js';
import { resolvePublicBaseUrl } from '../utils/publicBaseUrl.js';

/**
 * Parent / child roll-up (Simorgh SOC relations, B8 — Vahid, 19 Sep 2026):
 *
 *  1. A parent cannot reach a terminal status while any child is still open —
 *     people in the app and the API alike get 409 `open_children` naming the
 *     children. Children are live conversations with someone; tasks are not,
 *     and do not block.
 *  2. Nothing closes automatically. When the LAST open child reaches a terminal
 *     status, the parent is marked ready to close (`readyToCloseAt`), its owner
 *     is e-mailed once, a history row is written and `ticket.ready_to_close`
 *     is emitted. The mark is cleared when a child reopens, when the parent
 *     itself closes, or when the parent has no children left.
 *
 * Every hook here is best-effort except the block in (1): a roll-up problem
 * must never undo a status change that already happened.
 */
export const OPEN_CHILDREN = 'open_children';

const CHILD_SELECT = { id: true, status: true, origin: true, nativeNumber: true, freshserviceTicketId: true, subject: true };

async function isTerminal(workspaceId, status) {
  const base = await statusService.baseStatusOf(workspaceId, status);
  return TERMINAL_BASE_STATUSES.includes(base);
}

/** Children of a ticket with their current status. */
export async function childrenOf(ticketId, workspaceId) {
  const links = await prisma.ticketLink.findMany({
    where: { workspaceId, ticketId, kind: 'parent_of' },
    include: { relatedTicket: { select: CHILD_SELECT } },
    orderBy: { id: 'asc' },
  });
  return links.map((l) => l.relatedTicket).filter(Boolean);
}

/** Children not yet in a terminal status (Deleted/Spam children do not count). */
export async function openChildrenOf(ticketId, workspaceId) {
  const children = await childrenOf(ticketId, workspaceId);
  const open = [];
  for (const child of children) {
    if (['Deleted', 'Spam'].includes(child.status)) continue;
    if (!(await isTerminal(workspaceId, child.status))) open.push(child);
  }
  return open;
}

/** Rule 1. Throws 409 `open_children` when the ticket has open children. */
export async function assertNoOpenChildren(ticketId, workspaceId) {
  let open;
  try {
    open = await openChildrenOf(ticketId, workspaceId);
  } catch (err) {
    // Fail open: only a real "these children are open" answer may block a
    // close. A lookup problem must not lock every ticket in the workspace.
    logger.warn(`Roll-up open-children check skipped for ticket ${ticketId} (non-fatal): ${err.message}`);
    return;
  }
  if (!open.length) return;
  const refs = open.map((c) => ticketDisplayRef(c));
  const error = new ConflictError(
    `This ticket cannot be closed while ${open.length === 1 ? 'a child ticket is' : `${open.length} child tickets are`} still open: ${refs.join(', ')}. Close ${open.length === 1 ? 'it' : 'them'} first.`,
  );
  error.code = OPEN_CHILDREN;
  error.details = { openChildren: open.map((c) => ({ id: c.id, ref: ticketDisplayRef(c), status: c.status })) };
  throw error;
}

/**
 * Rule 2. Recompute one parent's readiness. Called after a child's status
 * changes, after a child is attached or detached, and after the parent itself
 * changes status. Returns what it did, for tests and logs.
 */
export async function recomputeReadiness(parentId, workspaceId, { actor = null } = {}) {
  try {
    const parent = await prisma.ticket.findFirst({
      where: { id: parentId, workspaceId },
      select: { ...CHILD_SELECT, workspaceId: true, readyToCloseAt: true, assignedTech: { select: { id: true, name: true, email: true } } },
    });
    if (!parent) return { changed: false, reason: 'no_parent' };
    const children = await childrenOf(parentId, workspaceId);
    const counted = children.filter((c) => !['Deleted', 'Spam'].includes(c.status));
    const parentTerminal = await isTerminal(workspaceId, parent.status);
    let allDone = counted.length > 0;
    for (const child of counted) {
      if (!(await isTerminal(workspaceId, child.status))) { allDone = false; break; }
    }
    const shouldBeReady = allDone && !parentTerminal;

    if (shouldBeReady && !parent.readyToCloseAt) {
      const now = new Date();
      await prisma.ticket.update({ where: { id: parent.id }, data: { readyToCloseAt: now } });
      await ticketActivityRepository.create({
        ticketId: parent.id,
        activityType: 'ready_to_close',
        performedBy: 'Ticket Pulse',
        performedAt: now,
        details: { source: 'ticketpulse_native', actorKind: 'system', children: counted.map((c) => ({ id: c.id, ref: ticketDisplayRef(c), status: c.status })), triggeredBy: actor?.name || actor?.email || null },
      }).catch((err) => logger.warn(`ready_to_close history write failed for ticket ${parent.id} (non-fatal): ${err.message}`));
      await notifyOwnerReady(parent, counted).catch((err) => logger.warn(`ready_to_close e-mail failed for ticket ${parent.id} (non-fatal): ${err.message}`));
      await emitReady(parent, counted).catch(() => {});
      logger.info(`Roll-up: ${ticketDisplayRef(parent)} is ready to close — all ${counted.length} child ticket(s) are done`);
      return { changed: true, readyToClose: true };
    }
    if (!shouldBeReady && parent.readyToCloseAt) {
      await prisma.ticket.update({ where: { id: parent.id }, data: { readyToCloseAt: null } });
      return { changed: true, readyToClose: false };
    }
    return { changed: false };
  } catch (err) {
    logger.warn(`Roll-up recompute failed for ticket ${parentId} (non-fatal): ${err.message}`);
    return { changed: false, error: err.message };
  }
}

/** After a CHILD's status changed: recompute its parent, if it has one. */
export async function afterChildStatusChange(childId, workspaceId, { actor = null } = {}) {
  try {
    const link = await prisma.ticketLink.findFirst({ where: { workspaceId, relatedTicketId: childId, kind: 'parent_of' }, select: { ticketId: true } });
    if (!link) return null;
    return await recomputeReadiness(link.ticketId, workspaceId, { actor });
  } catch (err) {
    logger.warn(`Roll-up parent lookup failed for ticket ${childId} (non-fatal): ${err.message}`);
    return null;
  }
}

async function notifyOwnerReady(parent, children) {
  const owner = parent.assignedTech;
  if (!owner?.email) return false;
  const ref = ticketDisplayRef(parent);
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const publicBase = resolvePublicBaseUrl({ warn: (m) => logger.warn(m) });
  const rows = children.map((c) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#0f172a;">${esc(ticketDisplayRef(c))}</td><td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#334155;">${esc(c.subject || '')}</td><td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#15803d;">${esc(c.status)}</td></tr>`).join('');
  const html = [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#1f2937;max-width:640px;">',
    `<p style="margin:0 0 14px;">Every child ticket of <b>${esc(ref)}</b>${parent.subject ? ` (“${esc(parent.subject)}”)` : ''} is now done. The parent is ready to close — nothing closes on its own, that part is yours.</p>`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;max-width:640px;border:1px solid #e2e8f0;border-radius:10px;">',
    rows,
    '</table>',
    `<p style="margin:16px 0 0;"><a href="${publicBase}/tickets/${parent.id}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#2563eb;color:#ffffff;font-size:13px;line-height:18px;font-weight:700;text-decoration:none;border-radius:8px;padding:10px 18px;">Open ${esc(ref)}</a></p>`,
    '<p style="margin:16px 0 0;color:#64748b;font-size:12px;line-height:18px;">Sent by Ticket Pulse.</p>',
    '</div>',
  ].join('');
  const result = await sendTransactionalEmail({
    workspaceId: parent.workspaceId, to: owner.email, label: 'ready to close',
    subject: `${ref} is ready to close — all ${children.length} child ticket${children.length === 1 ? '' : 's'} done`,
    html,
  });
  return result?.sent === true;
}

async function emitReady(parent, children) {
  const { dispatchWebhookEvent } = await import('./webhookDispatchService.js');
  dispatchWebhookEvent(parent.workspaceId, 'ticket.ready_to_close', {
    ticket: { id: parent.id, ref: ticketDisplayRef(parent), subject: parent.subject, status: parent.status },
    children: children.map((c) => ({ id: c.id, ref: ticketDisplayRef(c), status: c.status })),
    assignedAgent: parent.assignedTech ? { technicianId: parent.assignedTech.id, name: parent.assignedTech.name, email: parent.assignedTech.email || null } : null,
  });
}

export default { assertNoOpenChildren, openChildrenOf, childrenOf, recomputeReadiness, afterChildStatusChange, OPEN_CHILDREN };
