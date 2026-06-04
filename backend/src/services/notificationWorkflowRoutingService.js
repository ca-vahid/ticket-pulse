import jsonLogic from 'json-logic-js';
import { ValidationError } from '../utils/errors.js';

export const WORKFLOW_ROUTING_MODES = Object.freeze({
  EXCLUSIVE: 'exclusive',
  ADDITIVE: 'additive',
});

const VALID_ROUTING_MODES = new Set(Object.values(WORKFLOW_ROUTING_MODES));

export function normalizeRoutingMode(value) {
  const normalized = String(value || WORKFLOW_ROUTING_MODES.EXCLUSIVE).trim().toLowerCase();
  return VALID_ROUTING_MODES.has(normalized) ? normalized : WORKFLOW_ROUTING_MODES.EXCLUSIVE;
}

export function normalizeRoutingPriority(value, fallback = 100) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(999, Math.max(1, parsed));
}

export function normalizeRoutingRule(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      throw new ValidationError('Routing rule must be valid JSONLogic');
    }
  }
  if (typeof value !== 'object' && typeof value !== 'boolean') {
    throw new ValidationError('Routing rule must be a JSONLogic object or boolean');
  }
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function workflowRoutingSummary(workflow = {}) {
  return {
    id: workflow.id,
    key: workflow.key || null,
    name: workflow.name || null,
    triggerType: workflow.triggerType || null,
    routingMode: normalizeRoutingMode(workflow.routingMode),
    routingPriority: normalizeRoutingPriority(workflow.routingPriority),
    isDefaultVariant: workflow.isDefaultVariant === true,
    archived: Boolean(workflow.archivedAt),
  };
}

function routingRulePresent(workflow = {}) {
  return workflow.routingRule !== undefined
    && workflow.routingRule !== null
    && !(isPlainObject(workflow.routingRule) && Object.keys(workflow.routingRule).length === 0);
}

function evaluateRoutingRule(rule, context) {
  if (rule === true) return true;
  if (rule === false || rule === null || rule === undefined) return false;
  try {
    return jsonLogic.apply(rule, context) === true;
  } catch {
    return false;
  }
}

function routeSort(a, b) {
  const priorityDiff = normalizeRoutingPriority(a.routingPriority) - normalizeRoutingPriority(b.routingPriority);
  if (priorityDiff !== 0) return priorityDiff;
  return Number(a.id || 0) - Number(b.id || 0);
}

function fallbackDefault(workflows = []) {
  return workflows
    .filter((workflow) => workflow.isDefaultVariant === true)
    .sort(routeSort)[0] || null;
}

function decisionFor(workflow, reason, matched = false) {
  return {
    ...workflowRoutingSummary(workflow),
    matched,
    reason,
  };
}

export function selectWorkflowVariants(workflows = [], context = {}, options = {}) {
  const activeWorkflows = (workflows || []).filter((workflow) => !workflow?.archivedAt);
  const considered = activeWorkflows.map((workflow) => workflowRoutingSummary(workflow));
  const suppressed = [];
  const matched = [];
  const exclusiveMatches = [];
  const additiveMatches = [];
  const defaultWorkflow = fallbackDefault(activeWorkflows);

  for (const workflow of activeWorkflows) {
    if (workflow.isDefaultVariant === true) {
      continue;
    }

    if (!routingRulePresent(workflow)) {
      suppressed.push(decisionFor(workflow, 'missing_routing_rule'));
      continue;
    }

    const didMatch = evaluateRoutingRule(workflow.routingRule, context);
    if (!didMatch) {
      suppressed.push(decisionFor(workflow, 'routing_rule_not_matched'));
      continue;
    }

    const mode = normalizeRoutingMode(workflow.routingMode);
    const decision = decisionFor(workflow, mode === WORKFLOW_ROUTING_MODES.ADDITIVE ? 'additive_match' : 'exclusive_match', true);
    matched.push(decision);
    if (mode === WORKFLOW_ROUTING_MODES.ADDITIVE) {
      additiveMatches.push(workflow);
    } else {
      exclusiveMatches.push(workflow);
    }
  }

  exclusiveMatches.sort(routeSort);
  additiveMatches.sort(routeSort);

  const exclusiveWinner = exclusiveMatches[0] || defaultWorkflow;
  const selected = [
    ...(exclusiveWinner ? [exclusiveWinner] : []),
    ...additiveMatches.filter((workflow) => workflow.id !== exclusiveWinner?.id),
  ];
  const selectedIds = new Set(selected.map((workflow) => workflow.id));

  if (exclusiveWinner && exclusiveMatches.length === 0 && defaultWorkflow) {
    matched.push(decisionFor(defaultWorkflow, 'default_fallback', true));
  }

  for (const workflow of exclusiveMatches.slice(1)) {
    suppressed.push(decisionFor(workflow, 'lower_priority_exclusive_match_suppressed', true));
  }

  for (const workflow of activeWorkflows) {
    if (selectedIds.has(workflow.id)) continue;
    if (workflow.isDefaultVariant === true && workflow.id !== exclusiveWinner?.id) {
      suppressed.push(decisionFor(workflow, 'default_variant_not_needed'));
    }
  }

  const baseSuppressed = (options.baseSuppressed || []).map((workflow) => decisionFor(workflow, 'schedule_policy_suppressed'));
  const reason = exclusiveMatches.length > 0
    ? 'Highest-priority exclusive workflow variant selected'
    : defaultWorkflow
      ? 'No exclusive variant matched; default workflow selected'
      : selected.length > 0
        ? 'Additive workflow variant selected'
        : 'No workflow variant matched and no default workflow is available';

  return {
    selected,
    selectedWorkflowIds: selected.map((workflow) => workflow.id),
    considered,
    matched,
    suppressed: [...baseSuppressed, ...suppressed],
    fallbackWorkflowId: exclusiveMatches.length === 0 ? defaultWorkflow?.id || null : null,
    mode: 'variant_routing',
    reason,
  };
}

export default {
  WORKFLOW_ROUTING_MODES,
  normalizeRoutingMode,
  normalizeRoutingPriority,
  normalizeRoutingRule,
  selectWorkflowVariants,
  workflowRoutingSummary,
};
