import { jest } from '@jest/globals';

/**
 * QA 10-05 #5: every stopped preview read "Noise ticket skipped" because that
 * is the Stop step's fixed note. The condition step now says what it checked.
 */
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { explainConditionStep } = await import('../src/services/notificationWorkflowEngine.js');

const NOISE_RULE = { '!=': [{ var: 'ticket.isNoise' }, true] };
const scope = { ticket: { priorityLabel: 'Medium', isNoise: false } };

test('structured conditions on the "skip noise" step: the cause is the priority, and the replaced noise rule is flagged', () => {
  const node = { id: 'skip-noise', data: { label: 'Skip noise tickets', rule: NOISE_RULE, conditionGroup: { logic: 'all', conditions: [{ field: 'ticket.priorityLabel', operator: 'is', value: 'Urgent' }] } } };
  const out = explainConditionStep(node, { passed: false, evalScope: scope });
  expect(out.source).toBe('conditions');
  expect(out.summary).toBe('Priority is Urgent (this ticket: Medium)');
  expect(out.ignoredRule).toBe(true);
  expect(out.ignoredRuleReads).toEqual(['ticket.isNoise']);
});

test('the raw noise rule on a noise ticket says so; on a clean ticket it names what it read', () => {
  const node = { id: 'skip-noise', data: { rule: NOISE_RULE } };
  expect(explainConditionStep(node, { passed: false, evalScope: { ticket: { isNoise: true } } }).summary).toBe('this ticket is marked as noise');
  const clean = explainConditionStep(node, { passed: true, evalScope: scope });
  expect(clean.source).toBe('rule');
  expect(clean.summary).toBe('advanced rule read ticket.isNoise = false');
  expect(clean.ignoredRule).toBeUndefined();
});

test('conditions that cannot be read fail closed and say why', () => {
  const out = explainConditionStep({ id: 'c', data: { conditionGroup: { logic: 'all', conditions: [] } } }, { passed: false, compileError: 'Unknown condition field: x' });
  expect(out.summary).toContain('could not be read');
});
