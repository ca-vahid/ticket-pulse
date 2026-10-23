/**
 * FreshService tags → Ticket Pulse tags (QA 10-22 #2).
 *
 * A FreshService-born ticket carries the tags its team set in FreshService
 * (the Field Equipment team tags by vendor and instrument). Ticket Pulse tags
 * are its own layer (TicketTag / TicketTagLink, never written back), so the
 * sync copies them over:
 *  - a tag name is matched to the workspace's tag of the same name (any case);
 *    a missing one is created (slate, created by "freshservice");
 *  - a tag an admin retired (isActive false) is not linked again;
 *  - a link the sync made carries createdBy "freshservice" and goes when the
 *    tag leaves the FreshService ticket; a link a person added stays.
 *
 * Only payloads that carry `tags` (an array) are reconciled, so a payload
 * without the field never clears anything. Workspaces: FS_TAG_SYNC_WORKSPACE_IDS
 * (default "4", Field Equipment).
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';

export const FS_TAG_SOURCE = 'freshservice';
const MAX_NAME = 60;
const MAX_TAGS = 30;

export function fsTagSyncWorkspaceIds() {
  const raw = process.env.FS_TAG_SYNC_WORKSPACE_IDS ?? '4';
  return new Set(String(raw).split(',').map((v) => Number(v.trim())).filter((n) => Number.isInteger(n) && n > 0));
}

export function isFsTagSyncWorkspace(workspaceId) {
  return fsTagSyncWorkspaceIds().has(Number(workspaceId));
}

/**
 * The `include` for a FreshService ticket read: tags come back only when
 * asked for (`include=tags`, checked against production 22 Oct 2026), so a
 * tag-sync workspace asks for them too.
 */
export function fsTicketInclude(workspaceId, base = 'requester,stats') {
  return isFsTagSyncWorkspace(workspaceId) ? `${base},tags` : base;
}

/** FreshService tag list → clean, de-duplicated names (case-insensitive). */
export function cleanFsTags(tags) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(tags) ? tags : []) {
    const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * Make the sync's links on one ticket match the FreshService list.
 * Returns { added, removed, created } or null when nothing was done.
 */
export async function reconcileFsTags(ticket, fsTags) {
  if (!ticket?.id || !Array.isArray(fsTags) || !isFsTagSyncWorkspace(ticket.workspaceId)) return null;
  const workspaceId = Number(ticket.workspaceId);
  const wanted = cleanFsTags(fsTags);
  const links = await prisma.ticketTagLink.findMany({
    where: { ticketId: ticket.id },
    select: { id: true, tagId: true, createdBy: true, tag: { select: { name: true } } },
  });
  const linkedNames = new Map(links.map((l) => [String(l.tag?.name || '').toLowerCase(), l]));
  const wantedKeys = new Set(wanted.map((n) => n.toLowerCase()));
  const toAdd = wanted.filter((n) => !linkedNames.has(n.toLowerCase()));
  const toRemove = links.filter((l) => l.createdBy === FS_TAG_SOURCE && !wantedKeys.has(String(l.tag?.name || '').toLowerCase()));
  if (!toAdd.length && !toRemove.length) return null;

  let created = 0;
  let added = 0;
  if (toAdd.length) {
    const existing = await prisma.ticketTag.findMany({
      where: { workspaceId, name: { in: toAdd, mode: 'insensitive' } },
      select: { id: true, name: true, isActive: true },
    });
    const byKey = new Map(existing.map((t) => [t.name.toLowerCase(), t]));
    for (const name of toAdd) {
      let tag = byKey.get(name.toLowerCase());
      if (!tag) {
        try {
          tag = await prisma.ticketTag.create({ data: { workspaceId, name, color: 'slate', createdBy: FS_TAG_SOURCE }, select: { id: true, name: true, isActive: true } });
          created += 1;
        } catch (err) {
          if (err?.code !== 'P2002') throw err;
          tag = await prisma.ticketTag.findFirst({ where: { workspaceId, name }, select: { id: true, name: true, isActive: true } });
        }
      }
      if (!tag || tag.isActive === false) continue;
      try {
        await prisma.ticketTagLink.create({ data: { ticketId: ticket.id, tagId: tag.id, createdBy: FS_TAG_SOURCE } });
        added += 1;
      } catch (err) {
        if (err?.code !== 'P2002') throw err;
      }
    }
  }
  if (toRemove.length) {
    await prisma.ticketTagLink.deleteMany({ where: { id: { in: toRemove.map((l) => l.id) }, createdBy: FS_TAG_SOURCE } });
  }
  if (added || toRemove.length) {
    logger.debug(`FS tags: ticket ${ticket.id} +${added} -${toRemove.length}${created ? ` (${created} new tag${created === 1 ? '' : 's'})` : ''}`);
  }
  return { added, removed: toRemove.length, created };
}

export default { reconcileFsTags, cleanFsTags, isFsTagSyncWorkspace, FS_TAG_SOURCE };
