import settingsRepository from './settingsRepository.js';
import logger from '../utils/logger.js';

/**
 * "Also notify additional requesters" — per-workspace toggle (Phase MR6).
 *
 * When ON, requester-facing lifecycle mails (workflow sends whose To is the
 * ticket's requester: created / status / resolution / …) cc the ticket's
 * "Also for" list (Ticket.ccEmails). Default OFF so nobody gets surprise
 * mail the day this ships; reply emails ALWAYS reach the list regardless
 * (that is what "Also for" promises), and CSAT surveys stay primary-only.
 *
 * Storage: the existing global key/value `app_settings` table with a
 * workspace-scoped key (the `llm_tool_usage_ws<N>` precedent) — no
 * migration. Reads are cached briefly and fail CLOSED (off) so a settings
 * hiccup can never widen a delivery.
 */
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map(); // workspaceId -> { value, at }

export function alsoForNotifySettingKey(workspaceId) {
  return `also_notify_additional_requesters_ws${Number(workspaceId) || 0}`;
}

function parseFlag(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

export async function isAlsoForNotifyEnabled(workspaceId) {
  const id = Number(workspaceId);
  if (!Number.isFinite(id) || id <= 0) return false;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  let value = false;
  try {
    value = parseFlag(await settingsRepository.get(alsoForNotifySettingKey(id)));
  } catch (err) {
    logger.warn(`alsoForNotify: settings read failed for workspace ${id} (treating as off): ${err.message}`);
    value = false;
  }
  cache.set(id, { value, at: Date.now() });
  return value;
}

export async function setAlsoForNotifyEnabled(workspaceId, enabled) {
  const id = Number(workspaceId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('workspaceId is required');
  await settingsRepository.set(alsoForNotifySettingKey(id), enabled ? '1' : '0');
  cache.set(id, { value: Boolean(enabled), at: Date.now() });
  return Boolean(enabled);
}

export function invalidateAlsoForNotifyCache(workspaceId = null) {
  if (workspaceId === null) cache.clear();
  else cache.delete(Number(workspaceId));
}

/**
 * The cc list a requester-facing mail should carry for this ticket context:
 * the ticket's "Also for" addresses minus anything already in `to`
 * (case-insensitive), or [] when the workspace toggle is off. `ticket` is
 * either a Ticket row or the workflow eventContext.ticket (both carry
 * `ccEmails`).
 */
export async function additionalRequesterCc(workspaceId, ticket, to = []) {
  if (!(await isAlsoForNotifyEnabled(workspaceId))) return [];
  const taken = new Set((Array.isArray(to) ? to : [to]).map((a) => String(a || '').trim().toLowerCase()).filter(Boolean));
  const out = [];
  for (const raw of Array.isArray(ticket?.ccEmails) ? ticket.ccEmails : []) {
    const address = String(raw || '').trim().toLowerCase();
    if (!address || taken.has(address)) continue;
    taken.add(address);
    out.push(address);
  }
  return out;
}

export default {
  alsoForNotifySettingKey,
  isAlsoForNotifyEnabled,
  setAlsoForNotifyEnabled,
  invalidateAlsoForNotifyCache,
  additionalRequesterCc,
};
