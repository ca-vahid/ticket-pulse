/**
 * Who put a ticket on its technician. Twin of backend/src/utils/assignerKind.js
 * (keep the two in step): the dashboard re-counts with it when a search or
 * category filter is on.
 *
 *   logged      the technician wrote it in + New ticket and took it
 *               (createdByTechId = the assignee): after the fact, so the AI
 *               never had a chance to assign it
 *   self        the technician took it ("<name> (in FreshService)" included)
 *   ai          the Ticket Pulse service account: the AI assignment pipeline
 *   automation  a rule, not a pick: another "Ticket Pulse …" actor (alert
 *               bundling, Onboarding) or an integration's API key (ContinuIT)
 *   person      anyone else, or no assigner recorded
 */

const SYSTEM_PREFIX = 'ticket pulse';

export function plainName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** From a dashboard response: `serviceAccountNames` and `automationAssignerNames`. */
export function assignerNamesOf({ serviceAccountNames = [], automationNames = [] } = {}) {
  const ai = (serviceAccountNames || []).map((n) => String(n || '').trim().toLowerCase()).filter(Boolean);
  return {
    ai: ai.length ? ai : [SYSTEM_PREFIX],
    automation: (automationNames || []).map(plainName).filter(Boolean),
  };
}

/** A self-assigned ticket its technician wrote: Logged rather than Self. */
function selfKind(ticket) {
  const creator = ticket?.createdByTechId;
  return creator && creator === ticket?.assignedTechId ? 'logged' : 'self';
}

/**
 * 'logged' | 'self' when the technician took the ticket, else null. For row
 * badges, where the service-account names are not at hand.
 */
export function takenKind(ticket, techName) {
  if (ticket?.isSelfPicked) return selfKind(ticket);
  const by = String(ticket?.assignedBy || '').trim();
  if (by && techName && plainName(by) === plainName(techName)) return selfKind(ticket);
  return null;
}

/** @returns {'logged'|'self'|'ai'|'automation'|'person'} */
export function assignerKind(ticket, techName, names) {
  if (ticket?.isSelfPicked) return selfKind(ticket);
  const by = String(ticket?.assignedBy || '').trim();
  if (!by) return 'person';
  const plain = plainName(by);
  if (techName && plain === plainName(techName)) return selfKind(ticket);
  const lower = by.toLowerCase();
  if (names.ai.includes(lower)) return 'ai';
  if (lower.startsWith(SYSTEM_PREFIX) || names.automation.includes(plain)) return 'automation';
  return 'person';
}

/** Hover text for a technician's App count. `ai` is null on data from before the split. */
export function appColumnTitle(app, ai) {
  if (!app) return 'No app-assigned tickets';
  if (ai === null || ai === undefined || ai >= app) return `${app} assigned by the AI (Ticket Pulse)`;
  return `${app} assigned by an app, not a person: ${ai} by the AI, ${app - ai} by a rule or an integration (alert bundling, onboarding, ContinuIT…)`;
}

/**
 * The AI-assigned gauge: the AI's share of the tickets that needed an owner
 * picked. Tickets a rule or an integration routed, and tickets a technician
 * logged for themselves, are left out of both sides.
 */
export function aiAssignedShare({ total = 0, ai = 0, automation = 0, logged = 0 } = {}) {
  const routed = Math.max(0, total - automation - logged);
  return { routed, pct: routed > 0 ? Math.round((ai / routed) * 100) : 0 };
}
