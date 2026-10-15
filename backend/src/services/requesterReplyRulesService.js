import settingsRepository from './settingsRepository.js';
import logger from '../utils/logger.js';

/**
 * What Ticket Pulse does by itself when a requester replies (13 Oct 2026;
 * one settings page since 14 Oct 2026, plans/REQUESTER_REPLY_SETTINGS_PLAN.md).
 * Per workspace:
 *
 *  - reopenOnReply + reopenStatuses
 *                          a requester reply to a ticket in one of the ticked
 *                          statuses puts it back to Open
 *                          (requesterReplyReopenService). Replaces the Mail
 *                          Workflows "Reopen on requester reply" copy, which
 *                          is archived when this is saved on.
 *  - ignoreThanks          a reply to a resolved / closed ticket that only
 *                          says thanks, or is an out-of-office, leaves it
 *                          closed (with a quiet line in the conversation).
 *  - replyCheckMonthlyCapUsd
 *                          the monthly limit for the model call that reads
 *                          the replies the keyword fast path cannot.
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
 * defaults below: owner-away and new-request ON for IT (workspace 1), OFF
 * everywhere else; reopen and the thank-you switch OFF everywhere (the
 * workflow keeps reopening until an admin moves the workspace). Reads are
 * cached briefly and fall back to OFF when the settings store cannot be read,
 * so a hiccup can never start moving tickets.
 */
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map(); // workspaceId -> { value, at }

/** Workspaces where the owner-away and new-request rules start ON until someone saves a choice. */
export const DEFAULT_ON_WORKSPACE_IDS = Object.freeze([1]);

/** The on/off switches. */
export const RULE_KEYS = Object.freeze(['rerouteWhenOwnerAway', 'suggestNewRequest', 'reopenOnReply', 'ignoreThanks']);

/** What the page offers ticked when an admin first turns the reopen on (IT's process). */
export const SUGGESTED_REOPEN_STATUSES = Object.freeze(['Resolved', 'Closed', 'Pending Response']);

/** The monthly limits the page offers for reading replies (US dollars). */
export const REPLY_CHECK_CAP_CHOICES = Object.freeze([5, 10, 25, 50]);
export const DEFAULT_REPLY_CHECK_CAP_USD = 10;
const MAX_REOPEN_STATUSES = 20;
const MAX_RETIRED_KEPT = 20;

export function requesterReplyRulesSettingKey(workspaceId) {
  return `requester_reply_rules_ws${Number(workspaceId) || 0}`;
}

export function defaultRules(workspaceId) {
  const on = DEFAULT_ON_WORKSPACE_IDS.includes(Number(workspaceId));
  return {
    rerouteWhenOwnerAway: on,
    suggestNewRequest: on,
    reopenOnReply: false,
    reopenStatuses: [],
    ignoreThanks: false,
    replyCheckMonthlyCapUsd: DEFAULT_REPLY_CHECK_CAP_USD,
    retiredWorkflows: [],
  };
}

function offRules() {
  return { ...defaultRules(0), rerouteWhenOwnerAway: false, suggestNewRequest: false };
}

/** Unique, trimmed status names (case-insensitive), at most MAX_REOPEN_STATUSES. */
export function cleanStatusList(list) {
  if (!Array.isArray(list)) return null;
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const name = String(raw ?? '').trim().slice(0, 60);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
    if (out.length >= MAX_REOPEN_STATUSES) break;
  }
  return out;
}

function cleanRetired(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((w) => w && Number.isFinite(Number(w.id)))
    .map((w) => ({
      id: Number(w.id),
      name: String(w.name || '').slice(0, 200),
      wasEnabled: w.wasEnabled === true,
      at: w.at || null,
      by: w.by || null,
    }))
    .slice(-MAX_RETIRED_KEPT);
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
  const statuses = cleanStatusList(obj.reopenStatuses);
  if (statuses) rules.reopenStatuses = statuses;
  if (REPLY_CHECK_CAP_CHOICES.includes(Number(obj.replyCheckMonthlyCapUsd))) rules.replyCheckMonthlyCapUsd = Number(obj.replyCheckMonthlyCapUsd);
  rules.retiredWorkflows = cleanRetired(obj.retiredWorkflows);
  // Reopen with nothing ticked reopens nothing: read it as off.
  if (rules.reopenOnReply && rules.reopenStatuses.length === 0) rules.reopenOnReply = false;
  return rules;
}

const copy = (value) => ({ ...value, reopenStatuses: [...value.reopenStatuses], retiredWorkflows: value.retiredWorkflows.map((w) => ({ ...w })) });

export async function getRequesterReplyRules(workspaceId) {
  const id = Number(workspaceId);
  if (!Number.isFinite(id) || id <= 0) return offRules();
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return copy(hit.value);
  let value;
  try {
    value = parseStored(await settingsRepository.get(requesterReplyRulesSettingKey(id)), id);
  } catch (err) {
    logger.warn(`requesterReplyRules: settings read failed for workspace ${id} (treating as off): ${err.message}`);
    return offRules(); // not cached: the next read tries again
  }
  cache.set(id, { value, at: Date.now() });
  return copy(value);
}

/**
 * Save a patch: the switches (booleans), reopenStatuses (a list of names —
 * the caller checks them against the status registry), and
 * replyCheckMonthlyCapUsd (one of REPLY_CHECK_CAP_CHOICES). Anything else is
 * ignored. `retiredWorkflows` is only written through recordRetiredWorkflows.
 */
export async function setRequesterReplyRules(workspaceId, patch = {}) {
  const id = Number(workspaceId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('workspaceId is required');
  let current;
  try {
    current = parseStored(await settingsRepository.get(requesterReplyRulesSettingKey(id)), id);
  } catch {
    current = defaultRules(id);
  }
  const next = copy(current);
  for (const key of RULE_KEYS) {
    if (typeof patch?.[key] === 'boolean') next[key] = patch[key];
  }
  const statuses = cleanStatusList(patch?.reopenStatuses);
  if (statuses) next.reopenStatuses = statuses;
  if (REPLY_CHECK_CAP_CHOICES.includes(Number(patch?.replyCheckMonthlyCapUsd))) next.replyCheckMonthlyCapUsd = Number(patch.replyCheckMonthlyCapUsd);
  if (next.reopenOnReply && next.reopenStatuses.length === 0) throw new Error('Tick at least one status to reopen');
  await settingsRepository.set(requesterReplyRulesSettingKey(id), JSON.stringify(next));
  cache.set(id, { value: next, at: Date.now() });
  return copy(next);
}

/** Remember which workflows the page archived (shown on the page by name). */
export async function recordRetiredWorkflows(workspaceId, retired = []) {
  const id = Number(workspaceId);
  if (!Number.isFinite(id) || id <= 0 || !retired.length) return getRequesterReplyRules(id);
  let current;
  try {
    current = parseStored(await settingsRepository.get(requesterReplyRulesSettingKey(id)), id);
  } catch {
    current = defaultRules(id);
  }
  const keep = current.retiredWorkflows.filter((w) => !retired.some((r) => Number(r.id) === w.id));
  const next = { ...copy(current), retiredWorkflows: cleanRetired([...keep, ...retired]) };
  await settingsRepository.set(requesterReplyRulesSettingKey(id), JSON.stringify(next));
  cache.set(id, { value: next, at: Date.now() });
  return copy(next);
}

/** Forget a retired workflow once it is back (restored from the page or Mail Workflows). */
export async function forgetRetiredWorkflows(workspaceId, ids = []) {
  const id = Number(workspaceId);
  const drop = new Set((ids || []).map(Number));
  if (!Number.isFinite(id) || id <= 0 || !drop.size) return getRequesterReplyRules(id);
  let current;
  try {
    current = parseStored(await settingsRepository.get(requesterReplyRulesSettingKey(id)), id);
  } catch {
    current = defaultRules(id);
  }
  const next = { ...copy(current), retiredWorkflows: current.retiredWorkflows.filter((w) => !drop.has(w.id)) };
  await settingsRepository.set(requesterReplyRulesSettingKey(id), JSON.stringify(next));
  cache.set(id, { value: next, at: Date.now() });
  return copy(next);
}

export function invalidateRequesterReplyRulesCache(workspaceId = null) {
  if (workspaceId === null) cache.clear();
  else cache.delete(Number(workspaceId));
}

export default {
  DEFAULT_ON_WORKSPACE_IDS,
  RULE_KEYS,
  SUGGESTED_REOPEN_STATUSES,
  REPLY_CHECK_CAP_CHOICES,
  DEFAULT_REPLY_CHECK_CAP_USD,
  requesterReplyRulesSettingKey,
  defaultRules,
  cleanStatusList,
  getRequesterReplyRules,
  setRequesterReplyRules,
  recordRetiredWorkflows,
  forgetRetiredWorkflows,
  invalidateRequesterReplyRulesCache,
};
