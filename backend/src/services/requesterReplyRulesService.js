import settingsRepository from './settingsRepository.js';
import logger from '../utils/logger.js';

/**
 * What Ticket Pulse does by itself when a requester replies (13 Oct 2026).
 * Two per-workspace switches:
 *
 *  - rerouteWhenOwnerAway  the ticket's owner is away for more than a day:
 *                          clear the owner and send the ticket back through
 *                          assignment (ownerAwayRerouteService).
 *  - suggestNewRequest     a reply that reopens a long-resolved ticket and
 *                          reads like new work: suggest splitting it into its
 *                          own ticket (newRequestSuggestionService). Suggest
 *                          only, never automatic.
 *
 * Storage: the existing key/value `app_settings` table, one workspace-scoped
 * key holding a small JSON object (the `also_notify_additional_requesters_ws<N>`
 * precedent) — no migration. A workspace that never saved the key gets the
 * defaults below: ON for IT (workspace 1), OFF everywhere else. Reads are
 * cached briefly and fall back to OFF when the settings store cannot be read,
 * so a hiccup can never start moving tickets.
 */
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map(); // workspaceId -> { value, at }

/** Workspaces where both rules start ON until someone saves a choice. */
export const DEFAULT_ON_WORKSPACE_IDS = Object.freeze([1]);

export const RULE_KEYS = Object.freeze(['rerouteWhenOwnerAway', 'suggestNewRequest']);

export function requesterReplyRulesSettingKey(workspaceId) {
  return `requester_reply_rules_ws${Number(workspaceId) || 0}`;
}

export function defaultRules(workspaceId) {
  const on = DEFAULT_ON_WORKSPACE_IDS.includes(Number(workspaceId));
  return { rerouteWhenOwnerAway: on, suggestNewRequest: on };
}

function parseStored(raw, workspaceId) {
  const rules = defaultRules(workspaceId);
  if (raw === null || raw === undefined || raw === '') return rules;
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return rules; }
  }
  if (!obj || typeof obj !== 'object') return rules;
  for (const key of RULE_KEYS) {
    if (typeof obj[key] === 'boolean') rules[key] = obj[key];
  }
  return rules;
}

export async function getRequesterReplyRules(workspaceId) {
  const id = Number(workspaceId);
  const off = { rerouteWhenOwnerAway: false, suggestNewRequest: false };
  if (!Number.isFinite(id) || id <= 0) return off;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.value };
  let value;
  try {
    value = parseStored(await settingsRepository.get(requesterReplyRulesSettingKey(id)), id);
  } catch (err) {
    logger.warn(`requesterReplyRules: settings read failed for workspace ${id} (treating as off): ${err.message}`);
    return off; // not cached: the next read tries again
  }
  cache.set(id, { value, at: Date.now() });
  return { ...value };
}

export async function setRequesterReplyRules(workspaceId, patch = {}) {
  const id = Number(workspaceId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('workspaceId is required');
  let current;
  try {
    current = parseStored(await settingsRepository.get(requesterReplyRulesSettingKey(id)), id);
  } catch {
    current = defaultRules(id);
  }
  const next = { ...current };
  for (const key of RULE_KEYS) {
    if (typeof patch?.[key] === 'boolean') next[key] = patch[key];
  }
  await settingsRepository.set(requesterReplyRulesSettingKey(id), JSON.stringify(next));
  cache.set(id, { value: next, at: Date.now() });
  return { ...next };
}

export function invalidateRequesterReplyRulesCache(workspaceId = null) {
  if (workspaceId === null) cache.clear();
  else cache.delete(Number(workspaceId));
}

export default {
  DEFAULT_ON_WORKSPACE_IDS,
  RULE_KEYS,
  requesterReplyRulesSettingKey,
  defaultRules,
  getRequesterReplyRules,
  setRequesterReplyRules,
  invalidateRequesterReplyRulesCache,
};
