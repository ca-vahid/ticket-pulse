// Read status / agent changes out of a FreshService ticket activity feed
// (GET /tickets/:id/activities) — "Latest change wins" (23 Sep 2026,
// plans/PENDING_RESPONSE_STATUS_SYNC.md).
//
// FreshService words them as "set Status as Closed" / "set Agent as Mehdi
// Abbaspour", often chained ("set Status as Closed and set Group as Everyone
// IT"), in the activity's content or its sub_contents. Ticket Pulse's own
// write-backs appear under the integration's agent name ("Ticket Pulse"), so
// they are skipped: they are echoes, not someone else's change.

const DEFAULT_INTEGRATION_ACTORS = ['Ticket Pulse'];

export function integrationActorNames() {
  const extra = String(process.env.FS_INTEGRATION_ACTOR_NAMES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_INTEGRATION_ACTORS, ...extra].map((s) => s.toLowerCase()));
}

const FIELD_PATTERNS = [
  { field: 'status', re: /set Status as (.+?)(?=\s+and set |\s*,\s*set |$)/i },
  { field: 'agent', re: /set Agent as (.+?)(?=\s+and set |\s*,\s*set |$)/i },
];

/**
 * @param {Array} activities FreshService activities (any order)
 * @param {{ ignoreActors?: Set<string> }} [options]
 * @returns {{ status: object|null, agent: object|null, deletedBy: object|null }}
 *   newest change per field: { value, at: Date, actor, actorType }
 */
export function latestFsFieldChanges(activities = [], { ignoreActors = integrationActorNames() } = {}) {
  const sorted = [...(Array.isArray(activities) ? activities : [])]
    .filter((a) => a && a.created_at)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const out = { status: null, agent: null, deletedBy: null };
  for (const a of sorted) {
    const actor = String(a.actor?.name || '').trim();
    const texts = [a.content, ...(Array.isArray(a.sub_contents) ? a.sub_contents : [])]
      .filter((t) => typeof t === 'string' && t.trim());
    if (!out.deletedBy && texts.some((t) => /\bdeleted this ticket\b/i.test(t))) {
      out.deletedBy = { actor: actor || 'someone', at: new Date(a.created_at) };
    }
    if (ignoreActors.has(actor.toLowerCase())) continue;
    for (const { field, re } of FIELD_PATTERNS) {
      if (out[field]) continue;
      for (const t of texts) {
        const m = t.match(re);
        if (m) {
          out[field] = {
            value: m[1].trim(),
            at: new Date(a.created_at),
            actor: actor || 'FreshService',
            actorType: a.actor?.type || null,
          };
          break;
        }
      }
    }
    if (out.status && out.agent && out.deletedBy) break;
  }
  return out;
}
