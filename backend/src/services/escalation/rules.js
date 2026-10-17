/**
 * Escalation — the rules (QA 10-16 item 1).
 *
 * An agent hands a ticket back with the reason "Escalate to Advanced
 * Troubleshooting Team": the ticket needs someone MORE advanced in its
 * category / subcategory than the person handing it back. The AI is told so in
 * its prompt; these rules are the deterministic check after the AI's pick.
 *
 * Levels come from the competency matrix (technician_competencies):
 * basic < intermediate < advanced < expert. No row = no recorded skill (0).
 * A person's level in a ticket's scope is read the same way the AI's
 * find_matching_agents reads it: the subcategory row first, then the category.
 *
 * Pure: no database, no clock.
 */

export const LEVEL_RANK = Object.freeze({ basic: 1, intermediate: 2, advanced: 3, expert: 4 });
export const LEVEL_WORD = Object.freeze({ 0: 'no recorded skill', 1: 'basic', 2: 'intermediate', 3: 'advanced', 4: 'expert' });

export const OUTCOMES = Object.freeze({
  KEPT: 'kept', // the AI's pick is already more advanced
  SWAPPED: 'swapped', // the pick was not; a more advanced person at work was put first
  NONE_HIGHER: 'none_higher', // nobody more advanced is at work: suggestion only
  NO_CATEGORY: 'no_category', // the ticket has no category: the pick stands, unchecked
});

export function rankOf(level) {
  return LEVEL_RANK[String(level || '').toLowerCase()] || 0;
}

export function levelWord(rank) {
  return LEVEL_WORD[Number(rank) || 0] || LEVEL_WORD[0];
}

/**
 * A person's level in a ticket's scope.
 * @param {{ categoryId: number, level: string }[]} skills  their competency rows
 * @param {{ categoryId?: number|null, subcategoryId?: number|null }} scope
 * @returns {{ level: string|null, rank: number, matchedOn: 'subcategory'|'category'|null }}
 */
export function levelIn(skills, { categoryId = null, subcategoryId = null } = {}) {
  const list = Array.isArray(skills) ? skills : [];
  const sub = subcategoryId ? list.find((s) => Number(s.categoryId) === Number(subcategoryId)) : null;
  if (sub) return { level: sub.level || null, rank: rankOf(sub.level), matchedOn: 'subcategory' };
  const top = categoryId ? list.find((s) => Number(s.categoryId) === Number(categoryId)) : null;
  if (top) return { level: top.level || null, rank: rankOf(top.level), matchedOn: 'category' };
  return { level: null, rank: 0, matchedOn: null };
}

/** "Networking / VPN", "Networking", or null. */
export function scopeLabel({ categoryName = null, subcategoryName = null } = {}) {
  const parts = [categoryName, subcategoryName].map((p) => String(p || '').trim()).filter(Boolean);
  return parts.length ? parts.join(' / ') : null;
}

/** The plain line shown on the ticket and the review card. */
export function escalationNote(escalation) {
  if (!escalation) return null;
  const who = escalation.fromTechName || 'The previous assignee';
  const scope = escalation.scope || scopeLabel(escalation);
  return scope
    ? `Escalated by ${who}: needs someone more advanced in ${scope}`
    : `Escalated by ${who}: needs someone more advanced`;
}

/**
 * Decide what happens to the AI's pick on an escalated ticket.
 *
 * @param {object} args
 * @param {{ fromTechId: number|null, fromTechName?: string|null, rank: number, categoryId?: number|null,
 *   subcategoryId?: number|null, scope?: string|null }} args.escalation
 * @param {{ techId: number, techName?: string|null }[]} args.ranked  the AI's recommendations, best first
 * @param {{ techId: number, name: string, rank: number, eligible: boolean, openCount?: number }[]} args.candidates
 *   everyone who could take it; `eligible` = at work, not away, may hold this ticket, never handed it back
 * @returns {{ outcome: string, techId: number|null, techName: string|null, rank: number|null, sentence: string,
 *   fromRank: number, pickRank: number|null }}
 */
export function decideEscalation({ escalation, ranked = [], candidates = [] } = {}) {
  const fromRank = Number(escalation?.rank) || 0;
  const fromName = escalation?.fromTechName || 'the previous assignee';
  const scope = escalation?.scope || scopeLabel(escalation || {});
  const top = ranked.find((r) => r && r.techId) || null;
  const byId = new Map(candidates.map((c) => [Number(c.techId), c]));
  const pick = top ? byId.get(Number(top.techId)) || null : null;
  const pickRank = pick ? pick.rank : (top ? 0 : null);
  const base = { fromRank, pickRank };

  if (!escalation?.categoryId && !escalation?.subcategoryId) {
    return {
      ...base,
      outcome: OUTCOMES.NO_CATEGORY,
      techId: top?.techId ?? null,
      techName: top?.techName || pick?.name || null,
      rank: pickRank,
      sentence: 'Escalation: the ticket has no category, so the level could not be checked. The AI\'s pick stands.',
    };
  }

  if (top && pickRank > fromRank) {
    const name = top.techName || pick?.name || 'The pick';
    return {
      ...base,
      outcome: OUTCOMES.KEPT,
      techId: top.techId,
      techName: name,
      rank: pickRank,
      sentence: `Escalation: ${name} is ${levelWord(pickRank)} in ${scope}, above ${fromName} (${levelWord(fromRank)}).`,
    };
  }

  const higher = (c) => c && c.eligible === true && c.rank > fromRank && Number(c.techId) !== Number(escalation?.fromTechId);
  // The AI's own order first, then everyone else: highest level, lightest load, name.
  const fromRanked = ranked.map((r) => byId.get(Number(r?.techId))).find(higher) || null;
  const others = candidates
    .filter(higher)
    .sort((a, b) => (b.rank - a.rank)
      || ((a.openCount ?? 0) - (b.openCount ?? 0))
      || String(a.name || '').localeCompare(String(b.name || '')));
  const chosen = fromRanked || others[0] || null;

  if (chosen) {
    const was = top ? (top.techName || pick?.name || 'the AI\'s pick') : 'nobody';
    return {
      ...base,
      outcome: OUTCOMES.SWAPPED,
      techId: chosen.techId,
      techName: chosen.name,
      rank: chosen.rank,
      sentence: `Escalation: ${was} is not above ${fromName} (${levelWord(fromRank)}) in ${scope}, so ${chosen.name} (${levelWord(chosen.rank)}) was put first.`,
    };
  }

  return {
    ...base,
    outcome: OUTCOMES.NONE_HIGHER,
    techId: top?.techId ?? null,
    techName: top?.techName || pick?.name || null,
    rank: pickRank,
    sentence: `Escalation: no one more advanced than ${fromName} (${levelWord(fromRank)}) in ${scope} is available. Left for a coordinator - a suggestion only.`,
  };
}

/**
 * Put the chosen person first in the AI's ranked list (a person the AI did not
 * rank is added at the top), renumbering ranks. Returns a new array.
 */
export function promote(ranked = [], chosen, reasoning) {
  const list = Array.isArray(ranked) ? ranked.filter(Boolean) : [];
  const existing = list.find((r) => Number(r.techId) === Number(chosen.techId));
  const head = existing
    ? { ...existing, escalationPromoted: true }
    : { techId: chosen.techId, techName: chosen.techName || chosen.name, score: null, reasoning, escalationPromoted: true };
  const rest = list.filter((r) => Number(r.techId) !== Number(chosen.techId));
  return [head, ...rest].map((r, i) => ({ ...r, rank: i + 1 }));
}
