/**
 * "Skip noise tickets" as the condition step's own switch (QA 10-06 #2).
 *
 * The noise check used to be a condition row ("Is noise/spam is false") or the
 * step's raw rule — so adding conditions could drop it, and the warning that
 * said so vanished the moment it was fixed, leaving no visible state. Now the
 * step carries `skipNoise` (applied by the engine before the conditions), and
 * the old shapes are read through the same switch:
 *   - a top-level noise row in an ALL group, or
 *   - no conditions and a raw rule that reads ticket.isNoise.
 * Turning the switch off removes those; editing the conditions moves an old
 * noise row onto the switch.
 */

const isGroup = (g) => Boolean(g && typeof g === 'object' && Array.isArray(g.conditions));
const isNoiseRow = (e) => !isGroup(e) && e?.field === 'ticket.isNoise';
const ruleReadsNoise = (rule) => Boolean(rule && typeof rule === 'object') && JSON.stringify(rule).includes('"ticket.isNoise"');

export function noiseState(data = {}) {
  const group = isGroup(data.conditionGroup) ? data.conditionGroup : null;
  const legacyGroup = Boolean(group && group.logic !== 'any' && group.conditions.some(isNoiseRow));
  const legacyRule = !group && ruleReadsNoise(data.rule);
  return { on: data.skipNoise === true || legacyGroup || legacyRule, legacyGroup, legacyRule };
}

/** The conditions shown in the builder — an old noise row lives on the switch. */
export function visibleConditionGroup(data = {}) {
  const group = isGroup(data.conditionGroup) ? data.conditionGroup : null;
  if (!group || !noiseState(data).legacyGroup) return data.conditionGroup ?? null;
  return { ...group, conditions: group.conditions.filter((e) => !isNoiseRow(e)) };
}

/** Patch for an edit in the builder (keeps the noise check on the switch). */
export function conditionGroupPatch(data = {}, nextGroup) {
  const { legacyGroup, legacyRule } = noiseState(data);
  if (nextGroup && (legacyGroup || legacyRule)) return { conditionGroup: nextGroup, skipNoise: true };
  return { conditionGroup: nextGroup };
}

/** Patch for the switch itself. */
export function skipNoisePatch(data = {}, on) {
  if (on) return { skipNoise: true };
  const { legacyGroup, legacyRule } = noiseState(data);
  if (legacyGroup) return { skipNoise: false, conditionGroup: visibleConditionGroup(data) };
  // A raw noise rule is set aside by an empty condition list (matches every
  // ticket; the advanced rule is not used while conditions are set).
  if (legacyRule) return { skipNoise: false, conditionGroup: { logic: 'all', conditions: [] } };
  return { skipNoise: false };
}
