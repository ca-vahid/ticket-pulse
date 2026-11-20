import prisma from './prisma.js';
import settingsRepository from './settingsRepository.js';
import logger from '../utils/logger.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

/**
 * Dashboard view grant (QA 11-19 item 2).
 *
 * An admin lets one agent open the Dashboard and the technician pages it links
 * to, read only, without making them a coordinator, a reviewer or a Read-only
 * observer. Nothing else they can do changes.
 *
 * Stored per workspace in app_settings, no migration:
 *   dashboard_viewers_ws<N> = JSON array of technician ids, e.g. "[12,40]"
 *
 * A grant belongs to a technician row of THAT workspace, so it is scoped to the
 * workspace that granted it. It counts only while the technician is active and
 * their e-mail is the signed-in person's.
 */

export function dashboardViewersKey(workspaceId) {
  return `dashboard_viewers_ws${Number(workspaceId)}`;
}

/** Positive integer ids from the stored value (JSON array, or a comma list typed by hand). */
export function parseViewerIds(raw) {
  if (raw === null || raw === undefined || raw === '') return [];
  let list = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else {
    const text = String(raw).trim();
    try {
      const parsed = JSON.parse(text);
      list = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      list = text.split(',');
    }
  }
  const ids = new Set();
  for (const v of list) {
    const n = Number(String(v).trim());
    if (Number.isInteger(n) && n > 0) ids.add(n);
  }
  return [...ids].sort((a, b) => a - b);
}

// Short read cache: the gate runs on every Dashboard request. A change made
// here clears it at once; another server copy sees it within the TTL.
const CACHE_TTL_MS = 15_000;
const cache = new Map(); // workspaceId -> { ids: number[], at }

function validWorkspaceId(workspaceId) {
  const n = Number(workspaceId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function readIds(workspaceId, { fresh = false } = {}) {
  const ws = validWorkspaceId(workspaceId);
  if (!ws) return [];
  const hit = cache.get(ws);
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.ids;
  const ids = parseViewerIds(await settingsRepository.get(dashboardViewersKey(ws)));
  cache.set(ws, { ids, at: Date.now() });
  return ids;
}

/** Technician ids granted Dashboard view in this workspace. */
export async function getViewerIds(workspaceId) {
  return readIds(workspaceId);
}

/**
 * Is this signed-in person a listed Dashboard viewer in this workspace?
 * Fails closed: any error is "no".
 */
export async function isDashboardViewer(email, workspaceId) {
  const ws = validWorkspaceId(workspaceId);
  const address = String(email || '').trim().toLowerCase();
  if (!ws || !address) return false;
  let ids;
  try {
    ids = await readIds(ws);
  } catch (err) {
    logger.warn(`Dashboard viewer list unreadable for workspace ${ws}: ${err.message}`);
    return false;
  }
  if (!ids.length) return false;
  const tech = await Promise.resolve()
    .then(() => prisma.technician.findFirst({
      where: {
        workspaceId: ws,
        id: { in: ids },
        isActive: true,
        email: { equals: address, mode: 'insensitive' },
      },
      select: { id: true },
    }))
    .catch((err) => {
      logger.warn(`Dashboard viewer check failed for ${address} in workspace ${ws}: ${err.message}`);
      return null;
    });
  return Boolean(tech);
}

/**
 * Turn the grant on or off for one technician of this workspace.
 * Returns the new list of ids.
 */
export async function setDashboardViewer(workspaceId, technicianId, enabled) {
  const ws = validWorkspaceId(workspaceId);
  const techId = Number(technicianId);
  if (!ws) throw new ValidationError('Invalid workspace id');
  if (!Number.isInteger(techId) || techId <= 0) throw new ValidationError('Invalid technician id');
  if (typeof enabled !== 'boolean') throw new ValidationError('enabled must be true or false');

  const tech = await prisma.technician.findFirst({
    where: { id: techId, workspaceId: ws },
    select: { id: true, name: true },
  });
  // Turning it off always works, so a removed technician's id can be cleared.
  if (!tech && enabled) throw new NotFoundError('That person is not a member of this workspace');

  const current = await readIds(ws, { fresh: true });
  const next = new Set(current);
  if (enabled) next.add(techId);
  else next.delete(techId);
  const ids = [...next].sort((a, b) => a - b);
  await settingsRepository.set(dashboardViewersKey(ws), JSON.stringify(ids));
  cache.set(ws, { ids, at: Date.now() });
  return ids;
}

/** Test helper. */
export function resetDashboardViewerCache() {
  cache.clear();
}

export default {
  dashboardViewersKey,
  parseViewerIds,
  getViewerIds,
  isDashboardViewer,
  setDashboardViewer,
  resetDashboardViewerCache,
};
