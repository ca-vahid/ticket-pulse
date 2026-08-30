import settingsRepository from './settingsRepository.js';
import logger from '../utils/logger.js';

/**
 * "Post FreshService replies as the acting agent" — per-workspace flag
 * (Mega 08-30 Phase DR4 spike, DEFAULT OFF).
 *
 * FreshService's Create a Reply / Create a Note APIs document `user_id`
 * ("ID of the agent/user who is adding the note"). When this flag is ON and
 * the acting Ticket Pulse user maps to a technician with a FreshService id,
 * the FS-born reply/note carries `user_id: <technicians.freshservice_id>` so
 * FreshService itself attributes — and, for replies, addresses — the
 * conversation as the agent instead of the API-key owner ("Ticket Pulse").
 *
 * OFF by default: FS silently ignoring OR rejecting `user_id` for a user
 * that is not an agent seat on the tenant are both plausible and neither
 * has been observed on prod yet. Enable per workspace, send ONE test reply,
 * confirm the FS conversation's `user_id` and the requester email's sender,
 * then leave it on. Storage: `app_settings` key `fs_reply_as_agent_ws<N>`
 * (the alsoForNotify precedent) — no migration. Reads cached briefly and
 * fail CLOSED (off) so a settings hiccup never changes FS attribution.
 */
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map(); // workspaceId -> { value, at }

export function fsReplyAsAgentSettingKey(workspaceId) {
  return `fs_reply_as_agent_ws${Number(workspaceId) || 0}`;
}

function parseFlag(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

export async function isFsReplyAsAgentEnabled(workspaceId) {
  const id = Number(workspaceId);
  if (!Number.isFinite(id) || id <= 0) return false;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  let value = false;
  try {
    value = parseFlag(await settingsRepository.get(fsReplyAsAgentSettingKey(id)));
  } catch (err) {
    logger.warn(`fsReplyAsAgent: settings read failed for workspace ${id} (treating as off): ${err.message}`);
    value = false;
  }
  cache.set(id, { value, at: Date.now() });
  return value;
}

export async function setFsReplyAsAgentEnabled(workspaceId, enabled) {
  const id = Number(workspaceId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('workspaceId is required');
  await settingsRepository.set(fsReplyAsAgentSettingKey(id), enabled ? '1' : '0');
  cache.set(id, { value: Boolean(enabled), at: Date.now() });
  return Boolean(enabled);
}

export function invalidateFsReplyAsAgentCache(workspaceId = null) {
  if (workspaceId === null) cache.clear();
  else cache.delete(Number(workspaceId));
}

export default {
  fsReplyAsAgentSettingKey,
  isFsReplyAsAgentEnabled,
  setFsReplyAsAgentEnabled,
  invalidateFsReplyAsAgentCache,
};
