import prisma from './prisma.js';
import workspaceRepository from './workspaceRepository.js';

/**
 * A ticket link is canonical (`/tickets/44797`) but a session is pinned to
 * ONE workspace. Opening an IT ticket while the session sits on Accounting
 * answered "Ticket 44797 not found in this workspace" — and switching
 * workspace from that page bounced to the queue (Vahid, 14 Sep, following a
 * Simorgh link). Tell the caller WHERE the ticket lives, provided the signed-in
 * user may see that workspace, so the page can switch and stay on the ticket.
 *
 * @returns {Promise<{id:number,name:string,slug:string}|null>} the ticket's
 *   workspace when it differs from the current one and the user has access.
 */
export async function locateTicketWorkspaceForUser({ ticketId, currentWorkspaceId, userEmail }, deps = {}) {
  const db = deps.prisma || prisma;
  const workspaces = deps.workspaceRepository || workspaceRepository;
  const id = Number(ticketId);
  const email = typeof userEmail === 'string' ? userEmail.trim().toLowerCase() : '';
  if (!Number.isInteger(id) || id <= 0 || !email) return null;

  const row = await db.ticket.findUnique({
    where: { id },
    select: { workspaceId: true, workspace: { select: { id: true, name: true, slug: true, isActive: true } } },
  }).catch(() => null);
  if (!row?.workspace || !row.workspace.isActive) return null;
  if (Number(row.workspaceId) === Number(currentWorkspaceId)) return null;

  const accessible = await workspaces.getAccessibleWorkspaces(email).catch(() => []);
  if (!accessible.some((w) => Number(w.id) === Number(row.workspaceId))) return null;
  return { id: row.workspace.id, name: row.workspace.name, slug: row.workspace.slug };
}

export default { locateTicketWorkspaceForUser };
