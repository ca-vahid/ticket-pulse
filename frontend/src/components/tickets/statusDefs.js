// Per-workspace ticket-status definitions (QA 08-04 #12, Phase 8b).
//
// The queue meta endpoint (`ticketsAPI.meta()`) serves the workspace's status
// registry as `meta.statuses = [{ name, baseStatus, color, sortOrder,
// isSystem }]` (active statuses only, in display order). Every queue surface
// resolves against these helpers so custom statuses render, filter and bucket
// correctly — and every helper tolerates meta-not-loaded (or a pre-registry
// backend) by falling back to the canonical 4, which keeps first-paint
// behavior identical to the old hardcoded constant sets.
//
// Origin rule: only TP-born tickets can carry custom statuses. FS-born
// tickets keep FreshService's own vocabulary, so their pickers stay on
// CANONICAL_STATUS_DEFS until the 8c FS mapping work.

export const CANONICAL_STATUS_DEFS = [
  { name: 'Open', baseStatus: 'Open', color: 'blue', sortOrder: 0, isSystem: true },
  { name: 'Pending', baseStatus: 'Pending', color: 'amber', sortOrder: 1, isSystem: true },
  { name: 'Resolved', baseStatus: 'Resolved', color: 'emerald', sortOrder: 2, isSystem: true },
  { name: 'Closed', baseStatus: 'Closed', color: 'slate', sortOrder: 3, isSystem: true },
];
export const CANONICAL_STATUS_NAMES = CANONICAL_STATUS_DEFS.map((d) => d.name);

/** Workspace defs from a loaded meta payload, canonical 4 otherwise. */
export function statusDefsFromMeta(meta) {
  const defs = meta?.statuses;
  return Array.isArray(defs) && defs.length > 0 ? defs : CANONICAL_STATUS_DEFS;
}

export function statusNamesOf(defs) {
  return (defs?.length ? defs : CANONICAL_STATUS_DEFS).map((d) => d.name);
}

/**
 * Base status (Open/Pending/Resolved/Closed) for a label. Unknown labels: an
 * exact canonical name maps to itself (legacy rows / FS-born tickets on a
 * pre-seed workspace); anything else is null — mirrors backend baseStatusOf.
 */
export function baseStatusOf(defs, name) {
  const def = (defs || []).find((d) => d.name === name);
  if (def) return def.baseStatus;
  return CANONICAL_STATUS_NAMES.includes(name) ? name : null;
}

/** True when the label's base is Resolved or Closed. */
export function isTerminalStatus(defs, name) {
  return ['Resolved', 'Closed'].includes(baseStatusOf(defs, name));
}

/** All active names mapping to the given base status(es). */
export function statusNamesForBase(defs, baseOrBases) {
  const bases = Array.isArray(baseOrBases) ? baseOrBases : [baseOrBases];
  return (defs?.length ? defs : CANONICAL_STATUS_DEFS)
    .filter((d) => bases.includes(d.baseStatus))
    .map((d) => d.name);
}

// Registry color token → pill tone / facet dot. Full class strings (Tailwind
// JIT needs them literal). Tones follow the soft "subtle bg + colored text"
// pill style from tech-detail/constants.js.
export const STATUS_TONE_BY_COLOR = {
  slate: 'bg-slate-100 text-slate-500',
  orange: 'bg-orange-50 text-orange-700',
  violet: 'bg-violet-50 text-violet-700',
  red: 'bg-rose-50 text-rose-600',
  blue: 'bg-blue-50 text-blue-700',
  emerald: 'bg-emerald-50 text-emerald-700',
  amber: 'bg-amber-50 text-amber-700',
  cyan: 'bg-cyan-50 text-cyan-700',
  pink: 'bg-pink-50 text-pink-700',
};
export const STATUS_DOT_BY_COLOR = {
  slate: 'bg-slate-400',
  orange: 'bg-orange-500',
  violet: 'bg-violet-500',
  red: 'bg-rose-500',
  blue: 'bg-blue-500',
  emerald: 'bg-emerald-500',
  amber: 'bg-amber-500',
  cyan: 'bg-cyan-500',
  pink: 'bg-pink-500',
};

// Seeded default color per system base (matches the 8a migration seed).
const SYSTEM_DEFAULT_COLOR = { Open: 'blue', Pending: 'amber', Resolved: 'emerald', Closed: 'slate' };

/**
 * Pill tone override for StatusPill, resolved from the workspace defs.
 * Returns null (= keep StatusPill's own STATUS_COLORS/slate fallback) for:
 *  - statuses with no definition (legacy FS labels, Deleted/Spam), and
 *  - system rows still at their seeded default color — those keep the
 *    hand-tuned classic pill palette (Open is rose there by design) instead
 *    of snapping to the seed token.
 * Custom statuses and admin-recolored system rows get their token tone.
 */
export function statusToneFromDefs(defs, name) {
  const def = (defs || []).find((d) => d.name === name);
  if (!def || !def.color) return null;
  if (def.isSystem && def.color === SYSTEM_DEFAULT_COLOR[def.baseStatus]) return null;
  return STATUS_TONE_BY_COLOR[def.color] || null;
}

/** Facet-dot class for a def (canonical seed colors included). */
export function statusDotClass(def) {
  return STATUS_DOT_BY_COLOR[def?.color] || 'bg-slate-300';
}
