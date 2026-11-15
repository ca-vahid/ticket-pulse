/**
 * "This workflow can be updated" (MEGA 11-14, A4 / contract §4): an older
 * "Reopen on requester reply" workflow brought to the ready-made shape
 * (metadata.shapeVersion 2) without losing what the workspace chose. Pure.
 *
 * The upgrade keeps the workflow's own status list and extra conditions (for
 * example "Reply answers a workflow e-mail is not true"), adds
 * "Reply sender is an agent is not true" and "Reply is a survey response is
 * not true" when missing, turns both step switches on ("Don't reopen on a
 * thank-you or out-of-office reply", "Stop after 3 reopens by replies in a
 * day"), and drops a leftover raw rule when the builder rows say the same.
 * It lands as the workflow's DRAFT; a person publishes it.
 */
import { ruleToConditionGroup, ignoresThanks } from './conditionRuleShared.js';
import { REOPEN_GUARD_ROWS, REOPEN_SHAPE_VERSION } from './notificationWorkflowDefinition.js';
import { CONDITION_FIELDS } from './notificationConditionModel.js';

const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
const MAX_ROWS = 20;

const rowKey = (row) => JSON.stringify([row?.field, row?.operator, Array.isArray(row?.value) ? [...row.value].map(String).sort() : (row?.value ?? null)]);

function sameRows(a = [], b = []) {
  if (a.length !== b.length) return false;
  const left = a.map(rowKey).sort();
  const right = b.map(rowKey).sort();
  return left.every((k, i) => k === right[i]);
}

function flatRows(group) {
  return (group?.conditions || []).flatMap((c) => (Array.isArray(c?.conditions) ? flatRows(c) : [c]));
}

/** The condition steps a run passes on its way to the reopen step (true branches), nearest last. */
function conditionsBeforeReopen(definition) {
  const nodes = new Map((definition?.nodes || []).map((n) => [n.id, n]));
  const reopen = (definition?.nodes || []).find((n) => n?.type === 'update_ticket' && String(n.data?.setStatus || '').trim().toLowerCase() === 'open');
  if (!reopen) return { reopen: null, chain: [] };
  const chain = [];
  const seen = new Set();
  let current = reopen.id;
  for (let i = 0; i < 30; i += 1) {
    const edge = (definition.edges || []).find((e) => e.target === current && !seen.has(e.source));
    if (!edge) break;
    seen.add(edge.source);
    const source = nodes.get(edge.source);
    if (!source || source.type === 'trigger') break;
    if (source.type === 'condition') {
      if (String(edge.sourceHandle || 'default').toLowerCase() !== 'true') break;
      chain.unshift(source);
    }
    current = source.id;
  }
  return { reopen, chain };
}

function label(field) {
  return CONDITION_FIELDS[field]?.label || field;
}

/**
 * The upgrade for one workflow. Returns { available, changes, definition }.
 * `definition` is the upgraded copy (null when nothing would change).
 */
export function planReopenUpgrade(workflow) {
  const none = { available: false, changes: [], definition: null };
  if (workflow?.triggerType !== 'ticket.reply_received' || workflow?.archivedAt) return none;
  const source = workflow.draftDefinition || workflow.publishedDefinition;
  if (!source?.nodes) return none;
  const def = clone(source);
  const { reopen, chain } = conditionsBeforeReopen(def);
  if (!reopen || !chain.length) return none;
  // The step that holds the status list, else the last one before the reopen.
  const target = chain.find((n) => flatRows(n.data?.conditionGroup).some((r) => r?.field === 'ticket.status' || r?.field === 'ticket.statusBase'))
    || chain[chain.length - 1];
  const data = target.data || (target.data = {});
  const changes = [];

  // A leftover raw rule beside builder rows: the engine reads the rows. Drop
  // it when converting it gives the same rows (its Auto-help guard is the
  // thank-you switch, which is turned on below).
  if (data.rule !== undefined && data.rule !== null && data.conditionGroup && Array.isArray(data.conditionGroup.conditions)) {
    const converted = ruleToConditionGroup(data.rule);
    if (converted && sameRows(flatRows(converted.group), flatRows(data.conditionGroup))) {
      delete data.rule;
      changes.push('Removes the leftover code rule (the conditions already say the same).');
      if (converted.skipNoise && data.skipNoise !== true) data.skipNoise = true;
    }
  }
  // A step with only a raw rule: rows when it converts exactly.
  if (!data.conditionGroup && data.rule !== undefined && data.rule !== null) {
    const converted = ruleToConditionGroup(data.rule);
    if (converted) {
      data.conditionGroup = converted.group;
      delete data.rule;
      if (converted.skipNoise) data.skipNoise = true;
      changes.push('Shows the code rule as conditions.');
    }
  }
  if (data.conditionGroup && Array.isArray(data.conditionGroup.conditions) && (data.conditionGroup.logic || 'all') === 'all') {
    const have = new Set(chain.flatMap((n) => flatRows(n.data?.conditionGroup)).map((r) => `${r?.field}|${r?.operator}`));
    const missing = REOPEN_GUARD_ROWS.filter((r) => !have.has(`${r.field}|${r.operator}`));
    if (missing.length && flatRows(data.conditionGroup).length + missing.length <= MAX_ROWS) {
      data.conditionGroup.conditions = [...missing.map((r) => ({ ...r })), ...data.conditionGroup.conditions];
      for (const r of missing) changes.push(`Adds “${label(r.field)} is not true”.`);
    }
  }
  if (!ignoresThanks(data) || data.ignoreAutoHelpThanks !== undefined) {
    if (!ignoresThanks(data)) changes.push('Turns on “Don\'t reopen on a thank-you or out-of-office reply”.');
    data.ignoreThanks = true;
    delete data.ignoreAutoHelpThanks;
  }
  if (data.replyLoopGuard !== true) {
    data.replyLoopGuard = true;
    changes.push('Turns on “Stop after 3 reopens by replies in a day”.');
  }
  if (!changes.length && Number(def.metadata?.shapeVersion) >= REOPEN_SHAPE_VERSION) return none;
  def.metadata = { ...(def.metadata || {}), shapeVersion: REOPEN_SHAPE_VERSION };
  if (!changes.length) return none;
  return { available: true, changes, definition: def };
}

export default { planReopenUpgrade };
