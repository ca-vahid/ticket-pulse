import prisma from './prisma.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';

/**
 * Resolve a user-facing ticket reference to the actual ticket row
 * (QA 07-07 #6 — people type what they SEE, not internal ids):
 *   "TP-1042"  → nativeNumber 1042 (TP-born)
 *   "#231164"  → freshserviceTicketId 231164
 *   "231164"   → tried as FS number, then native number, then internal id
 *                (visible refs win; database ids — the old input format —
 *                still resolve as the fallback)
 *
 * Workspace-scoped. Returns a slim ticket row; throws NotFoundError naming
 * the ref when nothing matches.
 */

const SELECT = {
  id: true, subject: true, status: true, origin: true,
  nativeNumber: true, freshserviceTicketId: true,
};

export async function resolveTicketRef(raw, workspaceId) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) throw new ValidationError('Enter a ticket reference (TP-1042 or 231164)');
  const explicitFs = trimmed.startsWith('#');
  const ref = explicitFs ? trimmed.slice(1) : trimmed;

  const tpMatch = ref.match(/^tp-?(\d+)$/i);
  if (tpMatch && !explicitFs) {
    return prisma.ticket.findFirst({
      where: { workspaceId, nativeNumber: Number(tpMatch[1]) },
      select: SELECT,
    });
  }

  if (!/^\d+$/.test(ref)) return null;
  const num = Number(ref);
  if (!Number.isSafeInteger(num) || num <= 0) return null;

  const byFs = () => prisma.ticket.findFirst({ where: { workspaceId, freshserviceTicketId: BigInt(num) }, select: SELECT });
  if (explicitFs) return byFs(); // "#231164" is unambiguous
  const byNative = () => prisma.ticket.findFirst({ where: { workspaceId, nativeNumber: num }, select: SELECT });
  const byId = () => prisma.ticket.findFirst({ where: { workspaceId, id: num }, select: SELECT });

  // Typed refs are what users see (FS numbers dominate); ids only via URLs.
  for (const lookup of [byFs, byNative, byId]) {
    const hit = await lookup();
    if (hit) return hit;
  }
  return null;
}

export async function resolveTicketRefOrThrow(raw, workspaceId) {
  const ticket = await resolveTicketRef(raw, workspaceId);
  if (!ticket) {
    throw new NotFoundError(`No ticket matching "${String(raw).trim()}" in this workspace — try its TP-#### or #FS number`);
  }
  return { ...ticket, displayRef: ticketDisplayRef(ticket) };
}
