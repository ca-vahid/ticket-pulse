/**
 * FreshService copies that are being created right now (IT intake plan, 12 Oct 2026).
 *
 * The mirror creates the copy through the API, and only then learns its number. FreshService fires
 * its "Ticket is raised" workflow at once, whose first step is a webhook back to Ticket Pulse; the
 * sync lists the new ticket too. Until the number is saved on our ticket, nothing told the ingest
 * that this FreshService ticket is OUR copy, so it could create a second, FreshService-born ticket
 * (production: #241182 on 8 Sep 2026, and the throw-away #246727 on 12 Oct 2026).
 *
 * This registry is the missing fact. The mirror marks a ticket before it calls FreshService and
 * clears it afterwards; every FreshService-to-Ticket-Pulse path goes through
 * syncFreshServiceTicketSnapshot, which asks here before it creates a row. One process, in memory:
 * the app runs as a single instance, and a restart in the few seconds a create takes is covered by
 * the copy's `tp-copy` tag being visible to a person.
 */
const CREATING_TTL_MS = 20 * 60 * 1000; // a create that never reports back
const SETTLED_TTL_MS = 3 * 60 * 1000;   // late webhooks and list syncs after the number is saved
const entries = new Map(); // ticketId -> { workspaceId, subject, email, until }

const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

function sweep(now) {
  for (const [id, e] of entries) if (e.until <= now) entries.delete(id);
}

export function markCreating(ticketId, { workspaceId, subject, email } = {}, now = Date.now()) {
  sweep(now);
  entries.set(Number(ticketId), { workspaceId: Number(workspaceId), subject: norm(subject), email: norm(email), until: now + CREATING_TTL_MS });
}

/** The copy exists and its number is saved: keep the entry a little longer for late arrivals. */
export function settleCreating(ticketId, now = Date.now()) {
  const e = entries.get(Number(ticketId));
  if (e) e.until = now + SETTLED_TTL_MS;
}

/** The create failed: nothing was made, so nothing may be mistaken for it. */
export function clearCreating(ticketId) {
  entries.delete(Number(ticketId));
}

/**
 * The Ticket Pulse ticket whose copy this FreshService ticket is, or null.
 * Same workspace and same subject; the requester must agree when both sides know it.
 */
export function findInFlightCopy({ workspaceId, subject, email } = {}, now = Date.now()) {
  sweep(now);
  const s = norm(subject);
  const m = norm(email);
  if (!s) return null;
  for (const [id, e] of entries) {
    if (e.workspaceId !== Number(workspaceId) || e.subject !== s) continue;
    if (m && e.email && m !== e.email) continue;
    return id;
  }
  return null;
}

export function _resetMirrorInFlight() { entries.clear(); }
