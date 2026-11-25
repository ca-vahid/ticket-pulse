/**
 * FreshService mode per workspace (FreshService exit, A1 — 25 Nov 2026).
 *
 * `freshservice_mode_ws<N>` (app setting JSON) holds one of:
 *   - 'connected' — today's behaviour (the default for an FS-linked workspace);
 *   - 'shadow'    — behaves as connected, but every FreshService call that Off
 *                   would stop is COUNTED by purpose (see fsGate), so hidden
 *                   dependencies show up before a workspace is switched off;
 *   - 'off'       — nothing calls FreshService for this workspace.
 * A workspace with no FreshService link (FS workspace id 0) is always treated
 * as off and reported as 'never_connected'.
 *
 * Callers:
 *   - `isFreshServiceOff(wsOrRow)` — true when unlinked or mode 'off'. Cheap
 *     (cached 30 s); use it at every choke point that would call FreshService.
 *   - `fsGate(ws, purpose)` — the same answer as a boolean "may I call FS?",
 *     and in Shadow it records `purpose` (never blocks in Shadow).
 *   - `onModeChange(fn)` — services that cache FS clients or schedule FS jobs
 *     register here to reset themselves when a workspace flips.
 * Read errors mean "connected" (today's behaviour), never a silent Off.
 */
import prisma from './prisma.js';
import settingsRepository from './settingsRepository.js';
import logger from '../utils/logger.js';
import { isFreshServiceUnlinked } from '../utils/workspaceFsBinding.js';

export const FS_MODES = Object.freeze(['connected', 'shadow', 'off']);
export const FS_PURPOSES = Object.freeze([
  'sync', 'fast_lane', 'deleted_check', 'reconcile', 'mirror', 'writeback', 'reply_or_note',
  'thread_pull', 'attachment', 'approval_refresh', 'relations', 'tasks', 'webhook', 'ai_tools',
  'assignment_check', 'daily_review', 'groups', 'ticket_types', 'other',
]);

const CACHE_TTL_MS = 30 * 1000;
const SHADOW_FLUSH_MS = 10 * 60 * 1000;
const modeCache = new Map(); // ws -> { value, at }
const linkCache = new Map(); // ws -> { unlinked, at }
const listeners = new Set();
const shadowCounts = new Map(); // ws -> { purpose -> { n, first, last } }
let flushTimer = null;

export const modeSettingKey = (ws) => `freshservice_mode_ws${Number(ws) || 0}`;
export const shadowSettingKey = (ws) => `freshservice_shadow_ws${Number(ws) || 0}`;

function parse(raw) {
  if (!raw) return null;
  let obj = raw;
  if (typeof raw === 'string') { try { obj = JSON.parse(raw); } catch { return null; } }
  if (!obj || !FS_MODES.includes(obj.mode)) return null;
  return obj;
}

async function workspaceUnlinked(ws) {
  const hit = linkCache.get(ws);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.unlinked;
  try {
    const row = await prisma.workspace.findUnique({ where: { id: ws }, select: { id: true, freshserviceWorkspaceId: true } });
    const unlinked = row ? isFreshServiceUnlinked(row) : false;
    linkCache.set(ws, { unlinked, at: Date.now() });
    return unlinked;
  } catch (err) {
    // Data-safety review (25 Nov): the last answer we had, even expired, beats
    // a guess; "linked" only when nothing was ever read.
    if (hit) {
      logger.warn(`fsMode: workspace ${ws} link read failed (kept the last answer: ${hit.unlinked ? 'not linked' : 'linked'}): ${err.message}`);
      linkCache.set(ws, { unlinked: hit.unlinked, at: Date.now() });
      return hit.unlinked;
    }
    logger.warn(`fsMode: workspace ${ws} link read failed (treated as linked): ${err.message}`);
    return false;
  }
}

/**
 * The stored record for a workspace ({ mode, changedBy, changedAt, ... }); default connected.
 * A read error, or a stored value that cannot be read, keeps the LAST record
 * read (even past its 30 s), so a database hiccup after the switch-off never
 * turns the gates back to "call FreshService"; 'connected' only when nothing
 * was ever read. The kept record is re-used for another 30 s before retrying.
 */
export async function getModeRecord(workspaceId) {
  const ws = Number(workspaceId);
  if (!Number.isInteger(ws) || ws <= 0) return { mode: 'connected' };
  const hit = modeCache.get(ws);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const keepLast = (why) => {
    if (hit) {
      logger.warn(`fsMode: ${why} for workspace ${ws}; kept the last mode read ('${hit.value?.mode}')`);
      modeCache.set(ws, { value: hit.value, at: Date.now() });
      return hit.value;
    }
    logger.warn(`fsMode: ${why} for workspace ${ws}; nothing read before, treated as connected`);
    return { mode: 'connected' };
  };
  let raw;
  try {
    raw = await settingsRepository.get(modeSettingKey(ws));
  } catch (err) {
    return keepLast(`mode read failed (${err.message})`);
  }
  // No setting at all: never switched, so connected (the default), cached.
  if (raw === null || raw === undefined || raw === '') {
    const value = { mode: 'connected' };
    modeCache.set(ws, { value, at: Date.now() });
    return value;
  }
  const value = parse(raw);
  if (!value) return keepLast('stored mode could not be read');
  modeCache.set(ws, { value, at: Date.now() });
  return value;
}

/** 'never_connected' | 'connected' | 'shadow' | 'off'. */
export async function getMode(workspaceId) {
  const ws = Number(workspaceId);
  // No workspace (null, 0, NaN): global behaviour, no lookup — a findUnique
  // with an invalid id would fail and log on every call.
  if (!Number.isInteger(ws) || ws <= 0) return 'connected';
  if (await workspaceUnlinked(ws)) return 'never_connected';
  return (await getModeRecord(ws)).mode;
}

/**
 * True when nothing may call FreshService for this workspace. Accepts a
 * workspace id or a row; a row that SAYS it has no link (FS id 0) is off
 * without a lookup.
 */
export async function isFreshServiceOff(wsOrRow) {
  if (wsOrRow && typeof wsOrRow === 'object' && isFreshServiceUnlinked(wsOrRow)) return true;
  const mode = await getMode(wsOrRow && typeof wsOrRow === 'object' ? wsOrRow.id : wsOrRow);
  return mode === 'off' || mode === 'never_connected';
}

function recordShadow(ws, purpose) {
  const p = FS_PURPOSES.includes(purpose) ? purpose : 'other';
  const byWs = shadowCounts.get(ws) || {};
  const now = new Date().toISOString();
  const cur = byWs[p] || { n: 0, first: now, last: now };
  cur.n += 1; cur.last = now;
  byWs[p] = cur;
  shadowCounts.set(ws, byWs);
  if (!flushTimer) {
    flushTimer = setTimeout(() => { flushTimer = null; flushShadow().catch(() => {}); }, SHADOW_FLUSH_MS);
    flushTimer.unref?.();
  }
}

/**
 * "May I call FreshService for this workspace, for this purpose?"
 * connected → true; shadow → true and counted; off / never connected → false.
 */
export async function fsGate(workspaceId, purpose = 'other') {
  const ws = Number(workspaceId);
  if (!Number.isInteger(ws) || ws <= 0) return true; // no workspace: global behaviour unchanged
  const mode = await getMode(ws);
  if (mode === 'connected') return true;
  if (mode === 'shadow') { recordShadow(ws, purpose); return true; }
  return false;
}

/** Persist the in-memory Shadow counts (merged with what is stored). */
export async function flushShadow() {
  const entries = [...shadowCounts.entries()];
  shadowCounts.clear();
  for (const [ws, counts] of entries) {
    try {
      const raw = parseShadow(await settingsRepository.get(shadowSettingKey(ws)));
      const merged = { since: raw.since || new Date().toISOString(), counts: { ...(raw.counts || {}) } };
      for (const [p, c] of Object.entries(counts)) {
        const before = merged.counts[p] || { n: 0, first: c.first, last: c.last };
        merged.counts[p] = { n: before.n + c.n, first: before.first || c.first, last: c.last };
      }
      await settingsRepository.set(shadowSettingKey(ws), JSON.stringify(merged));
      const line = Object.entries(counts).map(([p, c]) => `${p} ${c.n}`).join(', ');
      logger.info(`FreshService Shadow (workspace ${ws}): calls Off would stop in the last window: ${line}`);
    } catch (err) {
      logger.warn(`fsMode: Shadow flush failed for workspace ${ws}: ${err.message}`);
    }
  }
}
function parseShadow(raw) {
  if (!raw) return { since: null, counts: {} };
  try { const o = typeof raw === 'string' ? JSON.parse(raw) : raw; return o && typeof o === 'object' ? o : { since: null, counts: {} }; } catch { return { since: null, counts: {} }; }
}

/** Stored Shadow counts plus whatever this process has not flushed yet. */
export async function getShadowReport(workspaceId) {
  const ws = Number(workspaceId);
  const stored = parseShadow(await settingsRepository.get(shadowSettingKey(ws)).catch(() => null));
  const live = shadowCounts.get(ws) || {};
  const counts = { ...(stored.counts || {}) };
  for (const [p, c] of Object.entries(live)) {
    const before = counts[p] || { n: 0, first: c.first, last: c.last };
    counts[p] = { n: before.n + c.n, first: before.first || c.first, last: c.last };
  }
  const total = Object.values(counts).reduce((s, c) => s + (c.n || 0), 0);
  return { since: stored.since || null, counts, total };
}

/** Register (ws, mode, previousMode) => void|Promise; returns an unregister function. */
export function onModeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Set a workspace's mode (super-admin action; the route checks the role).
 * Never for an unlinked workspace. Starting Shadow resets the Shadow counts.
 * Listeners run after the write; a listener failure is logged, never thrown.
 */
export async function setMode(workspaceId, mode, { actorEmail = null, note = null, extra = {} } = {}) {
  const ws = Number(workspaceId);
  if (!FS_MODES.includes(mode)) throw new Error(`Unknown FreshService mode "${mode}"`);
  if (await workspaceUnlinked(ws)) throw new Error('This workspace was never connected to FreshService');
  const before = await getModeRecord(ws);
  const record = {
    ...extra,
    mode,
    changedBy: actorEmail || null,
    changedAt: new Date().toISOString(),
    note: note || null,
    history: [...(Array.isArray(before.history) ? before.history : []), { from: before.mode, to: mode, by: actorEmail || null, at: new Date().toISOString() }].slice(-20),
  };
  await settingsRepository.set(modeSettingKey(ws), JSON.stringify(record));
  modeCache.set(ws, { value: record, at: Date.now() });
  if (mode === 'shadow' && before.mode !== 'shadow') {
    shadowCounts.delete(ws);
    await settingsRepository.set(shadowSettingKey(ws), JSON.stringify({ since: record.changedAt, counts: {} })).catch(() => {});
  }
  logger.info(`FreshService mode for workspace ${ws}: ${before.mode} → ${mode} (by ${actorEmail || 'unknown'})`);
  for (const fn of listeners) {
    try { await fn(ws, mode, before.mode); } catch (err) { logger.warn(`fsMode: a mode-change listener failed for workspace ${ws}: ${err.message}`); }
  }
  return record;
}

/** Tests and admin tools: forget cached modes and links. */
export function _resetFsModeCache() {
  modeCache.clear(); linkCache.clear(); shadowCounts.clear();
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
}

export default {
  FS_MODES, FS_PURPOSES, getMode, getModeRecord, isFreshServiceOff, fsGate, setMode, onModeChange,
  getShadowReport, flushShadow, modeSettingKey, shadowSettingKey, _resetFsModeCache,
};
