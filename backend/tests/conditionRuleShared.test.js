import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Workflow conditions without code (14 Oct 2026): a raw json-logic rule shows
 * as builder rows when it can, and the step reads as one sentence. The module
 * is shared byte-for-byte with the frontend.
 */
const {
  RULE_FIELDS, RULE_OPERATORS, OPERATOR_WORDS, ruleToConditionGroup, ruleConversionPatch,
  describeConditionStep, conditionSwitchStop,
} = await import('../src/services/conditionRuleShared.js');
const model = await import('../src/services/notificationConditionModel.js');
const { proveSame } = await import('../src/services/workflowRuleConversion.js');

const here = dirname(fileURLToPath(import.meta.url));
const v = (path) => ({ var: path });
const GUARD = { '!': { in: [v('event.extra.autoHelpReplyVerdict'), ['confirmed', 'auto_reply']] } };
const NOISE = { '!=': [v('ticket.isNoise'), true] };

/** Converts, and the rows answer exactly like the rule did. */
function expectSameAsRows(rule, options) {
  const out = ruleToConditionGroup(rule, options);
  expect(out).not.toBeNull();
  const newData = {
    conditionGroup: out.group,
    ...(out.skipNoise ? { skipNoise: true } : {}),
    ...(out.ignoreAutoHelpThanks ? { ignoreAutoHelpThanks: true } : {}),
  };
  expect(proveSame({ rule }, newData)).toMatchObject({ same: true });
  return out;
}

describe('one module on both sides', () => {
  test('the frontend copy is byte-identical', () => {
    const read = (p) => readFileSync(resolve(here, p), 'utf8').replace(/\r\n/g, '\n');
    expect(read('../../frontend/src/utils/conditionRuleShared.js')).toBe(read('../src/services/conditionRuleShared.js'));
  });

  test('field paths and types match the condition model', () => {
    expect(Object.keys(RULE_FIELDS).sort()).toEqual(Object.keys(model.CONDITION_FIELDS).sort());
    for (const [key, spec] of Object.entries(model.CONDITION_FIELDS)) {
      expect([key, RULE_FIELDS[key].path, RULE_FIELDS[key].type]).toEqual([key, spec.path, spec.type]);
    }
    expect(RULE_OPERATORS).toEqual(model.CONDITION_OPERATORS);
    expect(model.OPERATOR_WORDS).toBe(OPERATOR_WORDS);
  });
});

describe('ruleToConditionGroup — every shape', () => {
  test('== and != (literal on either side)', () => {
    expect(expectSameAsRows({ '==': [v('ticket.priorityLabel'), 'Urgent'] }).group.conditions)
      .toEqual([{ field: 'ticket.priorityLabel', operator: 'is', value: 'Urgent' }]);
    expect(expectSameAsRows({ '==': ['Urgent', v('ticket.priorityLabel')] }).group.conditions[0].operator).toBe('is');
    expect(expectSameAsRows({ '!=': [v('ticket.status'), 'Closed'] }).group.conditions)
      .toEqual([{ field: 'ticket.status', operator: 'is_not', value: 'Closed' }]);
    expect(expectSameAsRows({ '==': [v('ticket.isParked'), true] }).group.conditions[0]).toMatchObject({ operator: 'is_true' });
  });

  test('in [var, list] and in [value, var] (contains), and their negations', () => {
    expect(expectSameAsRows({ in: [v('ticket.status'), ['Resolved', 'Closed']] }).group.conditions)
      .toEqual([{ field: 'ticket.status', operator: 'in', value: ['Resolved', 'Closed'] }]);
    expect(expectSameAsRows({ in: ['vpn', v('ticket.subject')] }).group.conditions)
      .toEqual([{ field: 'ticket.subject', operator: 'contains', value: 'vpn' }]);
    expect(expectSameAsRows({ '!': { in: [v('ticket.priorityLabel'), ['Low']] } }).group.conditions[0].operator).toBe('not_in');
    expect(expectSameAsRows({ '!': [{ in: ['spam', v('ticket.subject')] }] }).group.conditions[0].operator).toBe('not_contains');
    expect(expectSameAsRows({ '!': { '==': [v('ticket.origin'), 'freshservice'] } }).group.conditions[0].operator).toBe('is_not');
  });

  test('!! and ! of a var (set / empty), a bare var', () => {
    expect(expectSameAsRows({ '!!': [v('assignedAgent.email')] }).group.conditions[0].operator).toBe('is_not_empty');
    expect(expectSameAsRows({ '!': v('assignedAgent.email') }).group.conditions[0].operator).toBe('is_empty');
    expect(expectSameAsRows(v('ticket.subject')).group.conditions[0].operator).toBe('is_not_empty');
  });

  test('numbers, regex and list ops', () => {
    expect(expectSameAsRows({ '>': [v('ticket.ageMinutes'), 120] }).group.conditions[0]).toMatchObject({ operator: 'gt', value: 120 });
    expect(expectSameAsRows({ '<': [60, v('ticket.ageMinutes')] }).group.conditions[0]).toMatchObject({ operator: 'gt', value: 60 });
    expect(expectSameAsRows({ regex_match: [v('ticket.subject'), '^re:'] }).group.conditions[0].operator).toBe('matches_regex');
    expect(expectSameAsRows({ list_has_any: [v('ticket.tags'), ['vip']] }).group.conditions[0].operator).toBe('has_any');
    expect(expectSameAsRows({ '!': { list_has_any: [v('ticket.tags'), ['vip']] } }).group.conditions[0].operator).toBe('has_none');
  });

  test('and / or nesting (one level), same-logic nesting flattens', () => {
    const rule = { or: [{ '==': [v('ticket.priorityLabel'), 'Urgent'] }, { and: [{ in: ['vpn', v('ticket.subject')] }, { '>': [v('ticket.ageMinutes'), 120] }] }] };
    const out = expectSameAsRows(rule);
    expect(out.group.logic).toBe('any');
    expect(out.group.conditions[1]).toMatchObject({ logic: 'all', conditions: [expect.any(Object), expect.any(Object)] });
    const flat = expectSameAsRows({ and: [{ '==': [v('ticket.origin'), 'ticketpulse'] }, { and: [{ '==': [v('ticket.status'), 'Open'] }] }] });
    expect(flat.group).toEqual({ logic: 'all', conditions: [
      { field: 'ticket.origin', operator: 'is', value: 'ticketpulse' },
      { field: 'ticket.status', operator: 'is', value: 'Open' },
    ] });
  });

  test('the Auto-help guard and the noise rule become the step switches', () => {
    const out = expectSameAsRows({ and: [{ in: [v('ticket.status'), ['Resolved', 'Closed']] }, GUARD] });
    expect(out).toEqual({ group: { logic: 'all', conditions: [{ field: 'ticket.status', operator: 'in', value: ['Resolved', 'Closed'] }] }, skipNoise: false, ignoreAutoHelpThanks: true });
    expect(expectSameAsRows(NOISE)).toEqual({ group: { logic: 'all', conditions: [] }, skipNoise: true, ignoreAutoHelpThanks: false });
    // On a branch there are no switches: they stay rows.
    const branch = ruleToConditionGroup({ and: [NOISE, GUARD] }, { switches: false });
    expect(branch.group.conditions.map((c) => c.operator)).toEqual(['is_false', 'not_in']);
    expect(branch.skipNoise).toBe(false);
  });

  test('true is an empty condition list', () => {
    expect(ruleToConditionGroup(true)).toEqual({ group: { logic: 'all', conditions: [] }, skipNoise: false, ignoreAutoHelpThanks: false });
  });

  test.each([
    ['strict equality', { '===': [v('ticket.status'), 'Open'] }],
    ['a var with a default', { '==': [{ var: ['ticket.status', 'Open'] }, 'Open'] }],
    ['between (three arguments)', { '<': [1, v('ticket.impact'), 3] }],
    ['an empty and', { and: [] }],
    ['== false (no row matches null the same way)', { '==': [v('ticket.isNoise'), false] }],
    ['an unknown field', { '==': [v('ticket.mystery'), 'x'] }],
    ['two levels of nesting', { and: [v('workspace.name'), { or: [v('requester.email'), { and: [v('ticket.subject'), { '==': [v('ticket.status'), 'Open'] }] }] }] }],
    ['a custom field without its definition types', { '==': [v('ticket.customFields.budget'), 5] }],
    ['an op the builder has no row for', { if: [v('ticket.subject'), true, false] }],
    ['false', false],
  ])('%s stays code (null)', (_name, rule) => {
    expect(ruleToConditionGroup(rule)).toBeNull();
  });

  test('custom fields convert only when their type keeps plain semantics', () => {
    const rule = { '==': [v('ticket.customFields.tier'), 'Gold'] };
    expect(ruleToConditionGroup(rule, { customFieldTypes: { tier: 'select' } }).group.conditions[0]).toEqual({ field: 'custom:tier', operator: 'is', value: 'Gold' });
    expect(ruleToConditionGroup(rule, { customFieldTypes: { tier: 'number' } })).toBeNull();
  });

  // The 15 production steps on 14 Oct 2026 (workspaces 1-5): 11 noise rules
  // and 4 status rules — the IT copy (9764) carried the Auto-help guard too.
  test.each([
    ['skip noise (11 steps)', NOISE, 'Every ticket continues, except noise or spam.'],
    ['reopen: resolved or closed (3 steps)', { in: [v('ticket.status'), ['Resolved', 'Closed']] }, 'Continues when the ticket status is Resolved or Closed.'],
    ['reopen with the Auto-help guard (IT, before 14 Oct)', { and: [{ in: [v('ticket.status'), ['Resolved', 'Closed']] }, GUARD] },
      'Continues when the ticket status is Resolved or Closed, except a thank-you or out-of-office reply after an Auto-help close.'],
  ])('production rule converts and proves the same: %s', (_name, rule, sentence) => {
    const out = expectSameAsRows(rule);
    expect(describeConditionStep({ conditionGroup: out.group, skipNoise: out.skipNoise, ignoreAutoHelpThanks: out.ignoreAutoHelpThanks })).toBe(sentence);
    expect(describeConditionStep({ rule })).toBe(sentence);
  });
});

describe('ruleConversionPatch', () => {
  test('drops the rule and sets rows + switches; leaves steps with conditions alone', () => {
    expect(ruleConversionPatch({ label: 'x', rule: NOISE })).toEqual({ conditionGroup: { logic: 'all', conditions: [] }, rule: undefined, skipNoise: true });
    expect(ruleConversionPatch({ rule: NOISE, conditionGroup: { logic: 'all', conditions: [] } })).toBeNull();
    expect(ruleConversionPatch({ rule: { '===': [v('ticket.status'), 'Open'] } })).toBeNull();
    expect(ruleConversionPatch({})).toBeNull();
  });
});

describe('sentences', () => {
  test('the step reads as one plain sentence', () => {
    expect(describeConditionStep({
      conditionGroup: { logic: 'all', conditions: [{ field: 'ticket.status', operator: 'in', value: ['Resolved', 'Closed', 'Pending Response'] }] },
      ignoreAutoHelpThanks: true,
    })).toBe('Continues when the ticket status is Resolved, Closed or Pending Response, except a thank-you or out-of-office reply after an Auto-help close.');
    expect(describeConditionStep({ conditionGroup: { logic: 'all', conditions: [] } })).toBe('Every ticket continues.');
    expect(describeConditionStep({ conditionGroup: { logic: 'any', conditions: [
      { field: 'ticket.isParked', operator: 'is_true' },
      { field: 'ticket.lastRequesterReplyMinutes', operator: 'gte', value: 2880 },
    ] } })).toBe('Continues when the ticket is parked or the time since the requester last wrote is at least 2 days.');
    expect(describeConditionStep({ rule: { '===': [v('a'), 1] } })).toBeNull();
    expect(describeConditionStep({ conditionGroup: { logic: 'all', conditions: [{ field: 'ticket.status', operator: 'is', value: 'Open' }] } }, { short: true })).toBe('The ticket status is Open');
  });
});

describe('conditionSwitchStop', () => {
  test('noise first, then the Auto-help thank-you verdicts', () => {
    const scope = (isNoise, verdict) => ({ ticket: { isNoise }, event: { extra: { autoHelpReplyVerdict: verdict } } });
    const both = { skipNoise: true, ignoreAutoHelpThanks: true };
    expect(conditionSwitchStop(both, scope(true, 'confirmed'))).toBe('skip_noise');
    expect(conditionSwitchStop(both, scope(false, 'confirmed'))).toBe('auto_help_thanks');
    expect(conditionSwitchStop(both, scope(false, 'auto_reply'))).toBe('auto_help_thanks');
    expect(conditionSwitchStop(both, scope(false, 'help'))).toBeNull();
    expect(conditionSwitchStop({}, scope(true, 'confirmed'))).toBeNull();
  });
});
