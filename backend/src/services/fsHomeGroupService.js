import prisma from './prisma.js';
import logger from '../utils/logger.js';

// "Other teams" people (assignable-only technicians, QA 09-25 item 6) are not
// in the IT team's FreshService groups, so FreshService refuses them as the
// assignee of an "Everyone IT" ticket. Their own group (e.g. Coreshack) comes
// from FreshService's group member lists; a write-back that assigns one of
// them moves the ticket to that group in the same PUT (2 Oct 2026).

const CACHE_MS = 15 * 60 * 1000;
const cache = new Map(); // workspaceId -> { at, groups: [{ fsId, name, members:Set<string> }] }
const inflight = new Map();

async function loadGroups(workspaceId, client) {
  const rows = await client.listGroups();
  const local = await Promise.resolve()
    .then(() => prisma.group.findMany({
      where: { workspaceId, freshserviceId: { not: null } },
      select: { freshserviceId: true, name: true, isActive: true },
    }))
    .then((r) => (Array.isArray(r) ? r : []))
    .catch(() => []);
  const localName = new Map(local.map((g) => [String(g.freshserviceId), g]));
  return (Array.isArray(rows) ? rows : []).map((g) => ({
    fsId: String(g.id),
    name: localName.get(String(g.id))?.name || g.name || `Group ${g.id}`,
    active: localName.get(String(g.id))?.isActive !== false,
    members: new Set((Array.isArray(g.members) ? g.members : []).map(String)),
  }));
}

/** Cached FreshService groups with their member agent ids. Null when unknown. */
export async function getFsGroups(workspaceId, client, { wait = true } = {}) {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.groups;
  if (!client) return hit?.groups || null;
  if (!inflight.has(workspaceId)) {
    inflight.set(workspaceId, loadGroups(workspaceId, client)
      .then((groups) => { cache.set(workspaceId, { at: Date.now(), groups }); return groups; })
      .catch((err) => {
        logger.warn(`FS group membership lookup failed for workspace ${workspaceId}: ${err.message}`);
        return hit?.groups || null;
      })
      .finally(() => inflight.delete(workspaceId)));
  }
  if (!wait) return hit?.groups || null;
  return inflight.get(workspaceId);
}

/**
 * The group to move a ticket to so `fsAgentId` can own it, or null when no
 * move is needed (no group on the ticket, already a member) or none is known.
 * Several groups: the smallest active one (the person's own team, not a
 * catch-all).
 */
export function pickHomeGroup(groups, fsAgentId, ticketFsGroupId) {
  if (!Array.isArray(groups) || !fsAgentId) return null;
  const agent = String(fsAgentId);
  if (ticketFsGroupId) {
    const current = groups.find((g) => g.fsId === String(ticketFsGroupId));
    if (current && current.members.has(agent)) return null;
  } else {
    return null;
  }
  const mine = groups.filter((g) => g.members.has(agent) && g.active);
  if (mine.length === 0) return null;
  mine.sort((a, b) => a.members.size - b.members.size || a.name.localeCompare(b.name));
  return { fsId: mine[0].fsId, name: mine[0].name };
}

/** Each listed technician's own group ({ fsId, name }), keyed by technician id. */
export function homeGroupsByTech(groups, techs) {
  const out = {};
  if (!Array.isArray(groups)) return out;
  for (const t of techs || []) {
    if (!t?.freshserviceId) continue;
    const mine = groups.filter((g) => g.members.has(String(t.freshserviceId)) && g.active);
    if (mine.length === 0) continue;
    mine.sort((a, b) => a.members.size - b.members.size || a.name.localeCompare(b.name));
    out[t.id] = { id: mine[0].fsId, name: mine[0].name, memberOf: mine.map((g) => g.fsId) };
  }
  return out;
}

export function _resetFsGroupCache() {
  cache.clear();
  inflight.clear();
}

export default { getFsGroups, pickHomeGroup, homeGroupsByTech, _resetFsGroupCache };
