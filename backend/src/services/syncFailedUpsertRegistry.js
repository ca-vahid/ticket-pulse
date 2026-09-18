import settingsRepository from './settingsRepository.js';
import logger from '../utils/logger.js';

/**
 * FreshService tickets that could not be SAVED, remembered until they can be.
 *
 * 18 Sep 2026: two Accounting tickets carried a NUL byte Postgres refuses. Every
 * insert failed — but the scheduled sync only asks FreshService for tickets
 * updated since the previous successful sync's start (minus five minutes), and a
 * sync that saves 20 of 21 tickets is still "successful": per-ticket failures
 * were a warn line and nothing else. So the window moved on. The fast sync looks
 * back 30 minutes. After that, nothing would ever fetch those tickets again
 * unless someone touched them in FreshService — they existed there and never
 * here, silently, and stayed missing after the NUL fix shipped.
 *
 * This registry breaks that: a failed save is recorded per workspace (in
 * app_settings, so it survives the restarts a deploy day brings), and every
 * scheduled sync re-fetches the recorded tickets by id until they save.
 *
 * Every method swallows its own errors. The registry must never be the reason a
 * sync fails.
 */

export const MAX_TRACKED_PER_WORKSPACE = 50;
export const MAX_RETRIES_PER_CYCLE = 5;
export const GIVE_UP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const keyFor = (workspaceId) => `sync_failed_upserts_ws${Number(workspaceId)}`;
const idOf = (value) => String(value?.toString?.() ?? value ?? '').trim();

async function load(workspaceId) {
  const raw = await settingsRepository.get(keyFor(workspaceId));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function save(workspaceId, entries) {
  await settingsRepository.set(keyFor(workspaceId), JSON.stringify(entries));
}

/** Remember that this FreshService ticket could not be saved. */
export async function recordFailedUpsert(workspaceId, freshserviceTicketId, error, now = new Date()) {
  const id = idOf(freshserviceTicketId);
  if (!workspaceId || !/^\d+$/.test(id)) return false;
  try {
    const entries = await load(workspaceId);
    const message = String(error?.cause?.message || error?.message || error || '').replace(/\s+/g, ' ').slice(0, 300);
    const existing = entries[id];
    if (!existing && Object.keys(entries).length >= MAX_TRACKED_PER_WORKSPACE) {
      logger.error(`Sync: FreshService ticket ${id} (workspace ${workspaceId}) could not be saved and the retry list is full (${MAX_TRACKED_PER_WORKSPACE}) — it is NOT being tracked: ${message}`);
      return false;
    }
    entries[id] = {
      firstFailedAt: existing?.firstFailedAt || now.toISOString(),
      lastFailedAt: now.toISOString(),
      attempts: (existing?.attempts || 0) + 1,
      error: message,
    };
    await save(workspaceId, entries);
    // error, not warn, and only the first time: this is a ticket that exists in
    // FreshService and not here. The hourly review greps for it.
    if (!existing) {
      logger.error(`Sync: FreshService ticket ${id} (workspace ${workspaceId}) could not be saved — it will be retried on every sync until it is: ${message}`);
    }
    return true;
  } catch (err) {
    logger.warn(`Sync: could not record failed upsert of FreshService ticket ${id}: ${err.message}`);
    return false;
  }
}

/** Forget a ticket (saved at last, or gone from FreshService). */
export async function clearFailedUpsert(workspaceId, freshserviceTicketId) {
  const id = idOf(freshserviceTicketId);
  try {
    const entries = await load(workspaceId);
    if (!entries[id]) return false;
    delete entries[id];
    await save(workspaceId, entries);
    return true;
  } catch (err) {
    logger.warn(`Sync: could not clear failed upsert of FreshService ticket ${id}: ${err.message}`);
    return false;
  }
}

/** Every tracked ticket for a workspace: [{ freshserviceTicketId, firstFailedAt, lastFailedAt, attempts, error }]. */
export async function listFailedUpserts(workspaceId) {
  try {
    const entries = await load(workspaceId);
    return Object.entries(entries).map(([freshserviceTicketId, entry]) => ({ freshserviceTicketId, ...entry }));
  } catch (err) {
    logger.warn(`Sync: could not read the failed-upsert list for workspace ${workspaceId}: ${err.message}`);
    return [];
  }
}

/**
 * Re-fetch and re-save the tracked tickets, oldest first, a few per cycle.
 * `retry(freshserviceTicketId)` resolves to 'saved' | 'gone' or throws.
 */
export async function retryFailedUpserts(workspaceId, retry, { now = new Date(), maxPerCycle = MAX_RETRIES_PER_CYCLE } = {}) {
  const summary = { tried: 0, saved: 0, gone: 0, stillFailing: 0, givenUp: 0 };
  const tracked = await listFailedUpserts(workspaceId);
  if (tracked.length === 0) return summary;

  tracked.sort((a, b) => String(a.lastFailedAt).localeCompare(String(b.lastFailedAt)));
  for (const entry of tracked) {
    const age = now.getTime() - new Date(entry.firstFailedAt).getTime();
    if (Number.isFinite(age) && age > GIVE_UP_AFTER_MS) {
      logger.error(`Sync: giving up on FreshService ticket ${entry.freshserviceTicketId} (workspace ${workspaceId}) after ${entry.attempts} attempts over 7 days — it is in FreshService and NOT in Ticket Pulse: ${entry.error}`);
      await clearFailedUpsert(workspaceId, entry.freshserviceTicketId);
      summary.givenUp += 1;
      continue;
    }
    if (summary.tried >= maxPerCycle) break;
    summary.tried += 1;
    try {
      const outcome = await retry(entry.freshserviceTicketId);
      await clearFailedUpsert(workspaceId, entry.freshserviceTicketId);
      if (outcome === 'gone') {
        summary.gone += 1;
        logger.info(`Sync: FreshService ticket ${entry.freshserviceTicketId} (workspace ${workspaceId}) no longer exists there — dropped from the retry list`);
      } else {
        summary.saved += 1;
        logger.info(`Sync: FreshService ticket ${entry.freshserviceTicketId} (workspace ${workspaceId}) saved on retry after ${entry.attempts} failed attempt(s)`);
      }
    } catch (error) {
      summary.stillFailing += 1;
      await recordFailedUpsert(workspaceId, entry.freshserviceTicketId, error, now);
    }
  }
  return summary;
}

export default { recordFailedUpsert, clearFailedUpsert, listFailedUpserts, retryFailedUpserts };
