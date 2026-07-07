import { sseManager } from '../routes/sse.routes.js';
import logger from '../utils/logger.js';

/**
 * Ticket presence (gap plan 2, Phase 4.1). Purely in-memory "who has this
 * ticket open right now" — nothing is ever persisted, no durations tracked
 * (team-safe: presence is a collision-avoidance signal, not a metric).
 * Single-instance prod makes an in-process registry sufficient.
 *
 * Clients heartbeat while a detail page is open; entries expire after
 * STALE_AFTER_MS without one. Changes broadcast a workspace-scoped SSE
 * `presence` event: { ticketId, viewers: [{ email, name }] }.
 */

const STALE_AFTER_MS = 75_000; // ~2 missed 30s heartbeats
const SWEEP_INTERVAL_MS = 30_000;

// workspaceId -> Map(ticketId -> Map(email -> { name, lastSeenAt }))
const registry = new Map();

function viewersOf(ticketMap) {
  return [...ticketMap.entries()].map(([email, v]) => ({ email, name: v.name }));
}

function broadcastTicket(workspaceId, ticketId, ticketMap) {
  try {
    sseManager.broadcast('presence', {
      workspaceId,
      ticketId,
      viewers: ticketMap ? viewersOf(ticketMap) : [],
    }, workspaceId);
  } catch (err) {
    logger.debug(`Presence broadcast failed (non-fatal): ${err.message}`);
  }
}

/** Announce/refresh a viewer on a ticket. Broadcasts only when the viewer set changes. */
export function heartbeatPresence(workspaceId, ticketId, { email, name }) {
  if (!registry.has(workspaceId)) registry.set(workspaceId, new Map());
  const wsMap = registry.get(workspaceId);
  if (!wsMap.has(ticketId)) wsMap.set(ticketId, new Map());
  const ticketMap = wsMap.get(ticketId);
  const isNew = !ticketMap.has(email);
  ticketMap.set(email, { name: name || email, lastSeenAt: Date.now() });
  if (isNew) broadcastTicket(workspaceId, ticketId, ticketMap);
  return viewersOf(ticketMap);
}

/** Explicit leave (page closed/navigated away). */
export function leavePresence(workspaceId, ticketId, email) {
  const ticketMap = registry.get(workspaceId)?.get(ticketId);
  if (!ticketMap || !ticketMap.delete(email)) return;
  if (ticketMap.size === 0) {
    registry.get(workspaceId).delete(ticketId);
    if (registry.get(workspaceId).size === 0) registry.delete(workspaceId);
    broadcastTicket(workspaceId, ticketId, null);
  } else {
    broadcastTicket(workspaceId, ticketId, ticketMap);
  }
}

/** Workspace snapshot for initial page loads: { [ticketId]: [{email, name}] } */
export function presenceSnapshot(workspaceId) {
  const wsMap = registry.get(workspaceId);
  if (!wsMap) return {};
  const out = {};
  for (const [ticketId, ticketMap] of wsMap) out[ticketId] = viewersOf(ticketMap);
  return out;
}

/** Drop viewers whose heartbeats stopped (tab crash, network loss). */
export function sweepStalePresence(now = Date.now()) {
  for (const [workspaceId, wsMap] of registry) {
    for (const [ticketId, ticketMap] of wsMap) {
      let changed = false;
      for (const [email, v] of ticketMap) {
        if (now - v.lastSeenAt > STALE_AFTER_MS) {
          ticketMap.delete(email);
          changed = true;
        }
      }
      if (!changed) continue;
      if (ticketMap.size === 0) wsMap.delete(ticketId);
      broadcastTicket(workspaceId, ticketId, ticketMap.size ? ticketMap : null);
    }
    if (wsMap.size === 0) registry.delete(workspaceId);
  }
}

/** Test hook. */
export function resetPresence() {
  registry.clear();
}

const sweeper = setInterval(() => sweepStalePresence(), SWEEP_INTERVAL_MS);
sweeper.unref?.();
