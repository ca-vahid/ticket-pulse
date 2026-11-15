/**
 * How the condition / branch inspectors show a step (14 Oct 2026): a raw
 * json-logic rule is shown as builder rows when it converts, else as code.
 * See components/settings/ConditionStepEditor.jsx.
 */
import { describeConditionStep, ruleConversionPatch, ruleToConditionGroup } from './conditionRuleShared';

export const REPLY_TRIGGER = 'ticket.reply_received';

/**
 * The step switches a condition step can carry (contract §2, MEGA 11-14):
 * Skip noise, "Don't reopen on a thank-you or out-of-office reply"
 * (`ignoreThanks`; the older `ignoreAutoHelpThanks` key means the same) and
 * "Stop after 3 reopens by replies in a day" (`replyLoopGuard`).
 */
export const STEP_SWITCH_KEYS = Object.freeze(['skipNoise', 'ignoreThanks', 'ignoreAutoHelpThanks', 'replyLoopGuard']);

export function stepSwitches(data = {}) {
  return {
    skipNoise: data?.skipNoise === true,
    thanks: data?.ignoreThanks === true || data?.ignoreAutoHelpThanks === true,
    loopGuard: data?.replyLoopGuard === true,
  };
}

/** The patch the thank-you switch writes: the new key, the legacy key removed. */
export function thanksSwitchPatch(on) {
  return { ignoreThanks: on, ignoreAutoHelpThanks: undefined };
}

const THANKS_WORDS = 'a thank-you or out-of-office reply';
export const LOOP_GUARD_SENTENCE = 'Stops after 3 reopens by replies in a day.';

/** A copy of a group with each row's value(s) passed through `valueLabel(field, value)`. */
function withValueLabels(group, valueLabel) {
  const conditions = (group?.conditions || []).map((entry) => {
    if (Array.isArray(entry?.conditions)) return withValueLabels(entry, valueLabel);
    if (!entry || typeof entry !== 'object') return entry;
    const label = (v) => (typeof v === 'string' ? valueLabel(entry.field, v) : v);
    return { ...entry, value: Array.isArray(entry.value) ? entry.value.map(label) : label(entry.value) };
  });
  return { ...group, conditions };
}

function joinAnd(list) {
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * What a condition step checks, switches included, in one sentence (the
 * editor's line and the canvas caption). The shared describeConditionStep
 * words the conditions; the switches are worded here so the new keys read
 * the same whichever version of the shared module is in the tree.
 *   "Continues when the ticket status is Resolved or Closed, except a
 *    thank-you or out-of-office reply. Stops after 3 reopens by replies in a day."
 * null = a rule written as code (can not say).
 */
export function describeStep(data = {}, { fields = null, short = false, valueLabel = null } = {}) {
  const { mode, view } = conditionStepView(data || {});
  if (mode === 'code') return describeConditionStep(data || {}, { fields, short });
  const switches = stepSwitches(view);
  const bare = { ...view };
  STEP_SWITCH_KEYS.forEach((key) => { delete bare[key]; });
  // Stored codes read as words ("auto_reply" → "out-of-office"); only the
  // sentence changes, never the saved step.
  if (valueLabel && bare.conditionGroup) bare.conditionGroup = withValueLabels(bare.conditionGroup, valueLabel);
  const base = describeConditionStep(bare, { fields, short });
  if (base === null) return null;
  const exceptions = [
    ...(switches.skipNoise ? ['noise or spam'] : []),
    ...(switches.thanks ? [THANKS_WORDS] : []),
  ];
  if (short) {
    if (base !== 'Every ticket') return base;
    return exceptions.length ? `All but ${joinAnd(exceptions)}` : base;
  }
  const sentence = exceptions.length ? `${base.replace(/\.$/, '')}, except ${joinAnd(exceptions)}.` : base;
  return switches.loopGuard ? `${sentence} ${LOOP_GUARD_SENTENCE}` : sentence;
}

const hasRawRule = (data) => data?.rule !== undefined && data?.rule !== null
  && !(data?.conditionGroup && Array.isArray(data.conditionGroup.conditions));

/**
 * What the inspector shows for a step: { mode: 'rows' | 'code', view, conversion }.
 * `view` = the step data as the admin sees it (conversion applied);
 * `conversion` = the patch that turns its raw rule into rows (or null).
 */
export function conditionStepView(data = {}) {
  if (!hasRawRule(data)) return { mode: 'rows', view: data, conversion: null };
  const conversion = ruleConversionPatch(data);
  if (!conversion) return { mode: 'code', view: data, conversion: null };
  const view = { ...data, ...conversion };
  delete view.rule;
  return { mode: 'rows', view, conversion };
}

/**
 * The draft patch that shows a selected step's raw rules as rows (condition
 * step: rule → rows + switches; branch step: each branch's rule → rows).
 * null when nothing converts.
 */
export function stepRuleConversionPatch(node) {
  if (!node) return null;
  if (node.type === 'condition') return conditionStepView(node.data || {}).conversion;
  if (node.type === 'branch') {
    const branches = Array.isArray(node.data?.branches) ? node.data.branches : [];
    let changed = false;
    const next = branches.map((branch) => {
      if (!hasRawRule(branch)) return branch;
      const converted = ruleToConditionGroup(branch.rule, { switches: false });
      if (!converted) return branch;
      changed = true;
      const copy = { ...branch, conditionGroup: converted.group };
      delete copy.rule;
      return copy;
    });
    return changed ? { branches: next } : null;
  }
  return null;
}
