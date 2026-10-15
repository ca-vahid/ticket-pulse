/**
 * How the condition / branch inspectors show a step (14 Oct 2026): a raw
 * json-logic rule is shown as builder rows when it converts, else as code.
 * See components/settings/ConditionStepEditor.jsx.
 */
import { ruleConversionPatch, ruleToConditionGroup } from './conditionRuleShared';

export const REPLY_TRIGGER = 'ticket.reply_received';

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
