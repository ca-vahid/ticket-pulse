/**
 * One-off conversion of raw json-logic rules on workflow steps into builder
 * rows (14 Oct 2026, "rules should be UI oriented"). Pure: the script
 * (scripts/convert-workflow-rules.mjs) reads and writes the database, this
 * module only decides.
 *
 * A step converts only when ruleToConditionGroup can show it as rows AND the
 * old rule and the new rows give the same answer for every combination of
 * values the rule reads (every option value, the rule's own values, null,
 * empty, true / false, a value nobody uses). One difference = the step is
 * refused and keeps its code.
 */
import jsonLogic from 'json-logic-js';
import {
  CONDITION_FIELDS, compileConditionGroup, registerWorkflowConditionOps, ruleVarPaths,
} from './notificationConditionModel.js';
import { conditionSwitchStop, describeConditionStep, ruleToConditionGroup } from './conditionRuleShared.js';

registerWorkflowConditionOps(jsonLogic);

/** Workspaces the script may change (sandboxes 6-9 never). */
export const CONVERT_WORKSPACES = Object.freeze([1, 2, 3, 4, 5]);
const MAX_FULL_GRID = 50_000;
const SAMPLE_SIZE = 20_000;

const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
const OTHER = 'zz-not-a-real-value';

function scalarsIn(rule, out = new Set()) {
  if (Array.isArray(rule)) rule.forEach((r) => scalarsIn(r, out));
  else if (rule && typeof rule === 'object') {
    for (const [op, arg] of Object.entries(rule)) if (op !== 'var') scalarsIn(arg, out);
  } else if (rule !== null && rule !== undefined) out.add(rule);
  return out;
}

function optionsForPath(path) {
  return Object.values(CONDITION_FIELDS).filter((f) => f.path === path).flatMap((f) => f.options || []);
}

function typesForPath(path) {
  return new Set(Object.values(CONDITION_FIELDS).filter((f) => f.path === path).map((f) => f.type));
}

/** The values tried for one path. */
export function candidateValues(path, rule) {
  const literals = [...scalarsIn(rule)];
  const values = [undefined, null, '', true, false, OTHER, ...literals, ...optionsForPath(path)];
  const types = typesForPath(path);
  if (types.has('number') || types.has('duration')) {
    for (const n of literals.filter((v) => typeof v === 'number')) values.push(n - 1, n + 1);
  }
  if (types.has('list')) {
    const strings = literals.filter((v) => typeof v === 'string');
    values.push([], [OTHER], strings, ...strings.map((s) => [s]), ...strings.map((s) => [s.toUpperCase()]));
  }
  const seen = new Set();
  return values.filter((v) => {
    const key = v === undefined ? 'undefined' : JSON.stringify(v);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function setPath(target, path, value) {
  if (value === undefined) return;
  const keys = path.split('.');
  let node = target;
  keys.slice(0, -1).forEach((k) => {
    if (!node[k] || typeof node[k] !== 'object') node[k] = {};
    node = node[k];
  });
  node[keys[keys.length - 1]] = value;
}

/** Deterministic PRNG so a dry run and its --apply test the same combinations. */
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Every combination (or a fixed sample when there are too many). */
export function scopeGrid(paths, rule) {
  const axes = paths.map((p) => [p, candidateValues(p, rule)]);
  const total = axes.reduce((n, [, vals]) => n * vals.length, 1);
  const build = (pick) => {
    const scope = {};
    axes.forEach(([p, vals], i) => setPath(scope, p, vals[pick(i)]));
    return scope;
  };
  const scopes = [];
  if (total <= MAX_FULL_GRID) {
    for (let index = 0; index < total; index += 1) {
      let rest = index;
      scopes.push(build((i) => {
        const len = axes[i][1].length;
        const k = rest % len;
        rest = Math.floor(rest / len);
        return k;
      }));
    }
    return { scopes, exhaustive: true };
  }
  // Too many: each value of each path against every base value of the others,
  // plus a fixed random sample.
  for (let i = 0; i < axes.length; i += 1) {
    for (let k = 0; k < axes[i][1].length; k += 1) {
      for (let base = 0; base < 6; base += 1) {
        scopes.push(build((j) => (j === i ? k : base % axes[j][1].length)));
      }
    }
  }
  const rand = prng(20261014);
  for (let n = 0; n < SAMPLE_SIZE; n += 1) scopes.push(build((j) => Math.floor(rand() * axes[j][1].length)));
  return { scopes, exhaustive: false };
}

/** How the engine answers a condition step (no custom-field types, no reply clocks). */
export function conditionStepPasses(data, scope) {
  if (conditionSwitchStop(data, scope)) return false;
  const rule = data?.conditionGroup ? compileConditionGroup(data.conditionGroup) : (data?.rule || true);
  return Boolean(jsonLogic.apply(rule, scope));
}

/** How the engine answers one branch of a branch step. */
export function branchMatches(branch, scope) {
  const rule = branch?.conditionGroup ? compileConditionGroup(branch.conditionGroup) : (branch?.rule || false);
  return Boolean(jsonLogic.apply(rule, scope));
}

/**
 * Same answer everywhere? { same: true, tried, exhaustive } or
 * { same: false, tried, scope, before, after }.
 */
export function proveSame(oldData, newData, { kind = 'condition' } = {}) {
  const evaluate = kind === 'branch' ? branchMatches : conditionStepPasses;
  const paths = new Set(ruleVarPaths(oldData?.rule ?? true));
  if (oldData?.skipNoise || newData?.skipNoise) paths.add('ticket.isNoise');
  if (oldData?.ignoreAutoHelpThanks || newData?.ignoreAutoHelpThanks) paths.add('event.extra.autoHelpReplyVerdict');
  const { scopes, exhaustive } = scopeGrid([...paths], oldData?.rule ?? true);
  for (const scope of scopes) {
    let before;
    let after;
    try { before = evaluate(oldData, scope); } catch { before = 'error'; }
    try { after = evaluate(newData, scope); } catch { after = 'error'; }
    if (before !== after) return { same: false, tried: scopes.length, exhaustive, scope, before, after };
  }
  return { same: true, tried: scopes.length, exhaustive };
}

const withoutRule = (data) => {
  const copy = { ...data };
  delete copy.rule;
  return copy;
};

const hasRawRule = (data) => data && data.rule !== undefined && data.rule !== null
  && !(data.conditionGroup && Array.isArray(data.conditionGroup.conditions));

/** Does this definition have any step a conversion would look at? */
export function definitionHasRawRules(definition) {
  return (definition?.nodes || []).some((node) => (
    (node?.type === 'condition' && hasRawRule(node.data))
    || (node?.type === 'branch' && (node.data?.branches || []).some(hasRawRule))
  ));
}

/**
 * Convert every raw-rule step of a definition that converts and proves the
 * same. Returns { definition, changed, steps: [{ nodeId, branchKey, label,
 * oldRule, sentence, verdict: 'convert' | 'keep' | 'refuse', why }] }.
 */
export function convertDefinitionRules(definition) {
  const next = clone(definition);
  const steps = [];
  let changed = false;
  for (const node of next?.nodes || []) {
    if (node?.type === 'condition' && hasRawRule(node.data)) {
      const oldData = node.data;
      const base = { nodeId: node.id, branchKey: null, label: oldData.label || node.id, oldRule: oldData.rule };
      const converted = ruleToConditionGroup(oldData.rule, { switches: true });
      if (!converted) {
        steps.push({ ...base, sentence: null, verdict: 'keep', why: 'the rule can not be shown as rows; it stays code' });
        continue;
      }
      const newData = {
        ...withoutRule(oldData),
        conditionGroup: converted.group,
        ...(converted.skipNoise ? { skipNoise: true } : {}),
        ...(converted.ignoreAutoHelpThanks ? { ignoreAutoHelpThanks: true } : {}),
      };
      const proof = proveSame(oldData, newData, { kind: 'condition' });
      const sentence = describeConditionStep(newData);
      if (!proof.same) {
        steps.push({ ...base, sentence, verdict: 'refuse', why: `answers differ for ${JSON.stringify(proof.scope)} (rule ${proof.before}, rows ${proof.after})` });
        continue;
      }
      node.data = newData;
      changed = true;
      steps.push({ ...base, sentence, verdict: 'convert', why: `same answer in ${proof.tried} combinations${proof.exhaustive ? ' (all of them)' : ' (sampled)'}` });
    }
    if (node?.type === 'branch') {
      const branches = Array.isArray(node.data?.branches) ? node.data.branches : [];
      branches.forEach((branch, index) => {
        if (!hasRawRule(branch)) return;
        const base = { nodeId: node.id, branchKey: branch.key || String(index), label: branch.label || branch.key || node.id, oldRule: branch.rule };
        const converted = ruleToConditionGroup(branch.rule, { switches: false });
        if (!converted) {
          steps.push({ ...base, sentence: null, verdict: 'keep', why: 'the rule can not be shown as rows; it stays code' });
          return;
        }
        const newBranch = { ...withoutRule(branch), conditionGroup: converted.group };
        const proof = proveSame(branch, newBranch, { kind: 'branch' });
        const sentence = describeConditionStep({ conditionGroup: converted.group });
        if (!proof.same) {
          steps.push({ ...base, sentence, verdict: 'refuse', why: `answers differ for ${JSON.stringify(proof.scope)} (rule ${proof.before}, rows ${proof.after})` });
          return;
        }
        branches[index] = newBranch;
        changed = true;
        steps.push({ ...base, sentence, verdict: 'convert', why: `same answer in ${proof.tried} combinations${proof.exhaustive ? ' (all of them)' : ' (sampled)'}` });
      });
    }
  }
  return { definition: changed ? next : definition, changed, steps };
}

export const CONVERSION_CHANGE_NOTE = 'Conditions shown as builder rows instead of code. Same checks, nothing else changed (convert-workflow-rules, 14 Oct 2026).';

export default {
  CONVERT_WORKSPACES,
  CONVERSION_CHANGE_NOTE,
  candidateValues,
  scopeGrid,
  conditionStepPasses,
  branchMatches,
  proveSame,
  definitionHasRawRules,
  convertDefinitionRules,
};
