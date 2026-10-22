/**
 * Who put a ticket on its technician (21 Oct 2026, Vahid: the dashboard's
 * AI-assigned gauge read low). One rule for the dashboard, Analytics and the
 * frontend's filter re-count (frontend/src/utils/assignerKind.js is its twin):
 *
 *   self        the technician took it: is_self_picked, or the assigner is the
 *               assignee ("Mehdi Abbaspour (in FreshService)" counts as Mehdi)
 *   ai          the Ticket Pulse service account, i.e. the AI assignment
 *               pipeline (settings → service_account_names, "Ticket Pulse")
 *   automation  routed by a rule, not picked by a person or the AI: any other
 *               "Ticket Pulse …" actor (alert bundling, Onboarding, owner away)
 *               or an integration writing through its API key (ContinuIT)
 *   person      anyone else, or no assigner recorded
 *
 * Before this, "Ticket Pulse alert bundling" and the ContinuIT key counted as
 * a coordinator, and an "(in FreshService)" self-pick counted as assigned.
 */

const DEFAULT_AI_ACCOUNT = 'Ticket Pulse';
const SYSTEM_PREFIX = 'ticket pulse';

/** "Reza Zaim (in FreshService)" and "Muhammad (Mo) Shahidullah" compare equal to the plain name. */
export function plainName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Accepts the old argument (an array of service account names) or
 * `{ serviceAccountNames, automationNames }`.
 */
export function assignerNamesOf(input) {
  const raw = Array.isArray(input) ? { serviceAccountNames: input } : (input || {});
  const ai = (raw.serviceAccountNames || []).map((n) => String(n || '').trim().toLowerCase()).filter(Boolean);
  return {
    ai: ai.length ? ai : [DEFAULT_AI_ACCOUNT.toLowerCase()],
    automation: (raw.automationNames || []).map(plainName).filter(Boolean),
  };
}

/** @returns {'self'|'ai'|'automation'|'person'} */
export function assignerKind(ticket, techName, names) {
  if (ticket?.isSelfPicked) return 'self';
  const by = String(ticket?.assignedBy || '').trim();
  if (!by) return 'person';
  const plain = plainName(by);
  if (techName && plain === plainName(techName)) return 'self';
  const { ai, automation } = names?.ai ? names : assignerNamesOf(names);
  const lower = by.toLowerCase();
  if (ai.includes(lower)) return 'ai';
  if (lower.startsWith(SYSTEM_PREFIX) || automation.includes(plain)) return 'automation';
  return 'person';
}

/**
 * Counts by kind. `app` = ai + automation (the dashboard's App column: not a
 * person). `routed` = the tickets that needed an owner picked (everything but
 * automation), the AI-assigned gauge's denominator.
 */
export function countAssignerKinds(tickets, techName, names) {
  const resolved = names?.ai ? names : assignerNamesOf(names);
  const out = { self: 0, ai: 0, automation: 0, person: 0 };
  for (const t of tickets || []) out[assignerKind(t, techName, resolved)] += 1;
  return { ...out, app: out.ai + out.automation, routed: out.self + out.ai + out.person };
}
