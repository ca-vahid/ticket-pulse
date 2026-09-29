/**
 * FreshService parent / child tickets, read into Ticket Pulse (29 Sep 2026).
 *
 * FreshService keeps its own parent/child relationships (a parent ticket's
 * "Child tickets" tab). Its API exposes them only on the single-ticket read,
 * `GET /tickets/:id?include=related_tickets`:
 *   parent → { child_ids: [...], child_tickets_details: [{ id, subject, status, priority, agent, requester }] }
 *   child  → { parent_id }
 * The list endpoint refuses the include, so relations are read per ticket:
 * when its Parent / child card loads (at most every few minutes per ticket)
 * and, live, right before an FS-born ticket is resolved or closed.
 *
 * Imported relations are stored as ordinary `parent_of` links marked
 * createdBy = 'freshservice'. FreshService owns them: they are added and
 * removed here only, never by an agent in Ticket Pulse, and a link an agent
 * made in Ticket Pulse is never overwritten by one from FreshService.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ConflictError } from '../utils/errors.js';

export const FS_LINK_SOURCE = 'freshservice';
const REFRESH_TTL_MS = 5 * 60 * 1000;
const MAX_REMEMBERED = 2000;
const CLOSED_FS_STATUSES = new Set(['resolved', 'closed']);

// ticketId -> { at, externalChildren, externalParent }
const recent = new Map();

function remember(ticketId, value) {
  if (recent.size >= MAX_REMEMBERED) recent.delete(recent.keys().next().value);
  recent.set(ticketId, { at: Date.now(), ...value });
}

/** Test hook. */
export function _resetRelationCache() { recent.clear(); }

/**
 * Read one ticket's FreshService relations.
 * @returns {{ parentFsId: number|null, children: Array<{ fsId, subject, status, agent }> }}
 */
export async function fetchFsRelations(client, fsTicketId) {
  const res = await client._get(`/tickets/${Number(fsTicketId)}?include=related_tickets`);
  const related = res?.data?.ticket?.related_tickets || {};
  const details = Array.isArray(related.child_tickets_details) ? related.child_tickets_details : [];
  const byId = new Map(details.map((d) => [Number(d.id), d]));
  const ids = Array.isArray(related.child_ids) ? related.child_ids.map(Number) : [...byId.keys()];
  return {
    parentFsId: related.parent_id ? Number(related.parent_id) : null,
    children: ids.filter(Number.isFinite).map((fsId) => {
      const d = byId.get(fsId) || {};
      return { fsId, subject: d.subject || null, status: d.status || null, agent: d.agent || null };
    }),
  };
}

/** Is a FreshService child still open? Unknown status counts as open. */
export function isOpenFsChild(child) {
  return !CLOSED_FS_STATUSES.has(String(child?.status || '').trim().toLowerCase());
}

async function tpTicketsByFsId(workspaceId, fsIds) {
  if (!fsIds.length) return new Map();
  const rows = await prisma.ticket.findMany({
    where: { workspaceId, freshserviceTicketId: { in: fsIds.map((id) => BigInt(id)) } },
    select: { id: true, freshserviceTicketId: true },
  });
  return new Map(rows.map((r) => [Number(r.freshserviceTicketId), r.id]));
}

/**
 * Bring one FS-born ticket's FreshService relations into ticket_links.
 * Returns what FreshService knows that Ticket Pulse cannot link (tickets not
 * synced into this workspace), for the card to show read-only; null when the
 * ticket is not FS-born or FreshService could not be asked.
 */
export async function syncFsRelations(ticketId, workspaceId, { force = false, client = null } = {}) {
  const cached = recent.get(ticketId);
  if (!force && cached && Date.now() - cached.at < REFRESH_TTL_MS) {
    return { externalChildren: cached.externalChildren, externalParent: cached.externalParent, fresh: false };
  }
  const ticket = await prisma.ticket.findFirst({
    where: { id: ticketId, workspaceId },
    select: { id: true, origin: true, freshserviceTicketId: true },
  });
  if (!ticket || ticket.origin === 'ticketpulse' || !ticket.freshserviceTicketId) return null;

  let fsClient = client;
  if (!fsClient) {
    const { default: mirrorService } = await import('./mirrorService.js');
    fsClient = await mirrorService.getInteractiveClient(workspaceId);
  }
  if (!fsClient) return null;

  let relations;
  try {
    relations = await fetchFsRelations(fsClient, ticket.freshserviceTicketId);
  } catch (err) {
    logger.warn(`FS relations: could not read #${ticket.freshserviceTicketId} (non-fatal): ${err.message}`);
    return null;
  }

  const lookupIds = [...relations.children.map((c) => c.fsId), ...(relations.parentFsId ? [relations.parentFsId] : [])];
  const tpByFs = await tpTicketsByFsId(workspaceId, lookupIds);
  const changedParents = new Set();

  // Children: this ticket is the parent.
  const wantedChildIds = new Set();
  for (const child of relations.children) {
    const childId = tpByFs.get(child.fsId);
    if (!childId || childId === ticket.id) continue;
    wantedChildIds.add(childId);
    if (await linkParent(workspaceId, ticket.id, childId)) changedParents.add(ticket.id);
  }
  const staleChildren = await prisma.ticketLink.findMany({
    where: { workspaceId, ticketId: ticket.id, kind: 'parent_of', createdBy: FS_LINK_SOURCE },
    select: { id: true, relatedTicketId: true },
  });
  for (const link of staleChildren) {
    if (wantedChildIds.has(link.relatedTicketId)) continue;
    await prisma.ticketLink.delete({ where: { id: link.id } }).catch(() => {});
    changedParents.add(ticket.id);
  }

  // Parent: this ticket is the child.
  const parentId = relations.parentFsId ? tpByFs.get(relations.parentFsId) : null;
  if (parentId && parentId !== ticket.id) {
    if (await linkParent(workspaceId, parentId, ticket.id)) changedParents.add(parentId);
  }
  const fsParentLink = await prisma.ticketLink.findFirst({
    where: { workspaceId, relatedTicketId: ticket.id, kind: 'parent_of', createdBy: FS_LINK_SOURCE },
    select: { id: true, ticketId: true },
  });
  if (fsParentLink && fsParentLink.ticketId !== parentId) {
    await prisma.ticketLink.delete({ where: { id: fsParentLink.id } }).catch(() => {});
    changedParents.add(fsParentLink.ticketId);
  }

  if (changedParents.size) {
    logger.info(`FS relations: #${ticket.freshserviceTicketId} parent/child links updated from FreshService`);
    try {
      const { default: ticketRollUpService } = await import('./ticketRollUpService.js');
      for (const id of changedParents) await ticketRollUpService.recomputeReadiness(id, workspaceId);
    } catch (err) {
      logger.warn(`FS relations: roll-up recompute skipped (non-fatal): ${err.message}`);
    }
  }

  const externalChildren = relations.children.filter((c) => !tpByFs.has(c.fsId));
  const externalParent = relations.parentFsId && !parentId ? { fsId: relations.parentFsId } : null;
  remember(ticket.id, { externalChildren, externalParent });
  return { externalChildren, externalParent, fresh: true, children: relations.children, parentFsId: relations.parentFsId };
}

/**
 * Store parent → child from FreshService. One parent per child: a parent an
 * agent set in Ticket Pulse is kept (logged); an older FreshService parent is
 * replaced. Returns true when a row was written.
 */
async function linkParent(workspaceId, parentId, childId) {
  const existing = await prisma.ticketLink.findFirst({
    where: { workspaceId, relatedTicketId: childId, kind: 'parent_of' },
    select: { id: true, ticketId: true, createdBy: true },
  });
  if (existing?.ticketId === parentId) return false;
  if (existing && existing.createdBy !== FS_LINK_SOURCE) {
    logger.info(`FS relations: ticket ${childId} keeps its Ticket Pulse parent ${existing.ticketId}; FreshService says ${parentId}`);
    return false;
  }
  if (existing) await prisma.ticketLink.delete({ where: { id: existing.id } }).catch(() => {});
  await prisma.ticketLink.upsert({
    where: { ticketId_relatedTicketId_kind: { ticketId: parentId, relatedTicketId: childId, kind: 'parent_of' } },
    update: {},
    create: { workspaceId, ticketId: parentId, relatedTicketId: childId, kind: 'parent_of', createdBy: FS_LINK_SOURCE },
  });
  return true;
}

/**
 * Close guard for an FS-born ticket: FreshService will not close a parent
 * whose child tickets are still open, so ask it first (live, not cached) and
 * refuse with the list. When FreshService cannot be asked, fall back to the
 * links Ticket Pulse already has.
 */
export async function assertNoOpenFsChildren(ticket, workspaceId, client) {
  const synced = await syncFsRelations(ticket.id, workspaceId, { force: true, client }).catch(() => null);
  if (!synced?.fresh) {
    const { default: ticketRollUpService } = await import('./ticketRollUpService.js');
    await ticketRollUpService.assertNoOpenChildren(ticket.id, workspaceId);
    return;
  }
  const open = synced.children.filter(isOpenFsChild);
  if (!open.length) return;
  const refs = open.map((c) => `#${c.fsId}${c.status ? ` (${c.status})` : ''}`);
  const error = new ConflictError(
    `FreshService will not close this ticket while ${open.length === 1 ? 'a child ticket is' : `${open.length} child tickets are`} still open: ${refs.join(', ')}. Resolve or close ${open.length === 1 ? 'it' : 'them'} first.`,
  );
  error.code = 'open_children';
  error.details = { openChildren: open.map((c) => ({ fsId: c.fsId, status: c.status, subject: c.subject })) };
  throw error;
}

export default { fetchFsRelations, syncFsRelations, assertNoOpenFsChildren, isOpenFsChild, FS_LINK_SOURCE };
