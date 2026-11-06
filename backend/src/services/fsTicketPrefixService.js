import settingsRepository from './settingsRepository.js';
import { parseTicketPrefixes } from '../utils/freshserviceRefs.js';

/**
 * A workspace's own FreshService ticket-number prefixes (6 Nov 2026).
 *
 * Accounting's FreshService writes `[CASE-251037]` in its mail subjects. The
 * mail-intake ladder reads such a prefix only for the workspace that says it
 * uses it, in `app_settings` key `fs_ticket_prefixes_ws<N>` (e.g. "CASE"):
 * vendors put their own case numbers in subjects, so a prefix read everywhere
 * would thread a vendor's mail onto an unrelated ticket in another workspace.
 * Cached for 10 minutes; any failure reads as "no extra prefixes".
 */
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // workspaceId -> { value: string[], at }

export function fsTicketPrefixSettingKey(workspaceId) {
  return `fs_ticket_prefixes_ws${Number(workspaceId) || 0}`;
}

export async function fsTicketPrefixes(workspaceId) {
  const id = Number(workspaceId);
  if (!Number.isInteger(id) || id <= 0) return [];
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  let value = [];
  try {
    value = parseTicketPrefixes(await settingsRepository.get(fsTicketPrefixSettingKey(id)));
  } catch {
    value = [];
  }
  cache.set(id, { value, at: Date.now() });
  return value;
}

export function clearFsTicketPrefixCache() {
  cache.clear();
}

export default { fsTicketPrefixes, fsTicketPrefixSettingKey, clearFsTicketPrefixCache };
