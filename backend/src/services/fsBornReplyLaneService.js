import settingsRepository from './settingsRepository.js';
import logger from '../utils/logger.js';

/**
 * "Send replies on FreshService tickets from Ticket Pulse" — per-workspace
 * flag (17 Sep 2026, DEFAULT OFF).
 *
 * Off: a reply on an FS-born ticket is posted to FreshService, and
 * FreshService mails the requester from its helpdesk address (for IT that is
 * `it@bgcengineering.ca`, with no display name unless FS attributes the reply
 * to an agent). Replies come back to FreshService.
 *
 * On: Ticket Pulse mails the requester itself — the workspace mailbox, the
 * agent's display name, `Reply-To: <mailbox>+fs<n>@` and threading headers —
 * exactly as it does for TP-born tickets, then records the reply on the
 * FreshService ticket as a public note. The requester's answer lands in the
 * workspace mailbox, threads onto the ticket (ingest rung 1 / 1.5) and is
 * written back to FreshService as an incoming note by the requester.
 *
 * Storage: `app_settings` key `fs_born_replies_via_tp_ws<N>` (no migration).
 * Reads are cached briefly and fail CLOSED (off) so a settings hiccup never
 * changes which system sends mail.
 */
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map(); // workspaceId -> { value, at }

export function fsBornReplyLaneSettingKey(workspaceId) {
  return `fs_born_replies_via_tp_ws${Number(workspaceId) || 0}`;
}

function parseFlag(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

export async function isFsBornRepliesViaTicketPulseEnabled(workspaceId) {
  const id = Number(workspaceId);
  if (!Number.isFinite(id) || id <= 0) return false;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  let value = false;
  try {
    value = parseFlag(await settingsRepository.get(fsBornReplyLaneSettingKey(id)));
  } catch (err) {
    logger.warn(`fsBornReplyLane: settings read failed for workspace ${id} (treating as off): ${err.message}`);
    value = false;
  }
  cache.set(id, { value, at: Date.now() });
  return value;
}

export async function setFsBornRepliesViaTicketPulseEnabled(workspaceId, enabled) {
  const id = Number(workspaceId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('workspaceId is required');
  await settingsRepository.set(fsBornReplyLaneSettingKey(id), enabled ? '1' : '0');
  cache.set(id, { value: Boolean(enabled), at: Date.now() });
  return Boolean(enabled);
}

export function invalidateFsBornReplyLaneCache(workspaceId = null) {
  if (workspaceId === null) cache.clear();
  else cache.delete(Number(workspaceId));
}

export default {
  fsBornReplyLaneSettingKey,
  isFsBornRepliesViaTicketPulseEnabled,
  setFsBornRepliesViaTicketPulseEnabled,
  invalidateFsBornReplyLaneCache,
};
