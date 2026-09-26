/* eslint-env node */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Auto-help integration W1 + W3 (plans/AUTO_HELP_INTEGRATION_PLAN.md): the
 * new triggers must be visible in the builder (a label AND a picker entry —
 * a trigger in one map and not the other renders as a raw key), the new
 * condition fields must be pickable, and the send-email step carries the
 * "When Auto-help will answer: merge" option.
 */
const read = (file) => readFileSync(resolve(process.cwd(), `src/components/settings/${file}`), 'utf8');
const panel = read('NotificationWorkflowsPanel.jsx');
const builder = read('ConditionGroupBuilder.jsx');
const index = read('WorkflowIndex.jsx');

const TRIGGERS = [
  ['ticket.intake_settled', 'Ticket intake settled'],
  ['auto_help.staged', 'Auto-help suggested an answer'],
  ['auto_help.answered', 'Auto-help answer sent'],
  ['auto_help.nudged', 'Auto-help checked in'],
  ['auto_help.help_requested', 'Requester still needs help (after Auto-help)'],
  ['auto_help.resolved', 'Auto-help closed the ticket'],
];

describe('Auto-help triggers in the builder', () => {
  test.each(TRIGGERS)('%s has a label, a picker entry and a place in the index order', (value, label) => {
    expect(panel).toContain(`'${value}': '${label}'`);
    expect(panel).toContain(`{ value: '${value}', hint: '`);
    expect(index).toContain(`'${value}'`);
  });

  test('the Auto-help group is offered in the trigger picker', () => {
    expect(panel).toMatch(/label: 'Auto-help',\s+triggers: \[/);
  });
});

describe('Auto-help condition fields', () => {
  test.each([
    'ticket.autoHelp.state', 'ticket.autoHelp.expected', 'ticket.autoHelp.mode', 'ticket.autoHelp.playbook',
    'ticket.autoHelp.outcome', 'ticket.resolvedByKind', 'event.intakeProvisional', 'event.intakeDecision',
    'event.intakeSource', 'event.autoHelpReplyVerdict',
  ])('%s is pickable', (field) => {
    expect(builder).toContain(`{ value: '${field}',`);
  });

  test('park kind offers auto_help', () => {
    expect(builder).toContain("{ value: 'ticket.parkKind', label: 'Park kind', type: 'enum', options: ['until_date', 'waiting_on', 'eta', 'auto_help'] }");
  });
});

describe('send-email: When Auto-help will answer: merge', () => {
  test('the option writes autoHelpMerge { enabled, waitMinutes } and caps the wait at 15 minutes', () => {
    expect(panel).toContain('When Auto-help will answer: merge');
    expect(panel).toContain('data-testid="autohelp-merge-controls"');
    expect(panel).toMatch(/autoHelpMerge: \{ \.\.\.\(selectedNode\.data\?\.autoHelpMerge \|\| \{\}\), enabled: event\.target\.checked/);
    expect(panel).toContain('Math.min(15, Math.max(1, Number(event.target.value) || 5))');
  });
});
