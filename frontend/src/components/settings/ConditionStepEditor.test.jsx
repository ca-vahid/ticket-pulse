/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ types: [], activeTypes: [], defaultType: null, typeByName: () => null, loading: false, refresh: () => {} }),
  invalidateTicketTypesCache: () => {},
}));
vi.mock('../../services/api', () => ({
  ticketsAPI: { customFieldDefinitions: vi.fn().mockResolvedValue({ data: [] }) },
  notificationWorkflowAPI: { conditionFields: vi.fn().mockResolvedValue({ data: [] }) },
}));
vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspace: { id: 1 } }),
  useWorkspaceOptional: () => ({ currentWorkspace: { id: 1 } }),
}));

import ConditionStepEditor from './ConditionStepEditor';
import { conditionStepView, stepRuleConversionPatch } from '../../utils/conditionStepView';

/**
 * Workflow conditions without code (14 Oct 2026): Vahid opened "Reopen on
 * requester reply" and saw an EMPTY builder; the rule that mattered sat in a
 * raw JSONLogic box below. A step now reads as a sentence, opens as rows, and
 * shows code only when it can not be rows.
 */
afterEach(cleanup);

const v = (path) => ({ var: path });
const REOPEN_RULE = { and: [{ in: [v('ticket.status'), ['Resolved', 'Closed']] }, { '!': { in: [v('event.extra.autoHelpReplyVerdict'), ['confirmed', 'auto_reply']] } }] };
const CODE_RULE = { '===': [v('ticket.status'), 'Closed'] };

describe('a raw-rule step opens as rows', () => {
  test('the seeded reopen rule shows the sentence, the rows and the Auto-help switch — no code', () => {
    render(<ConditionStepEditor data={{ label: 'Reopen?', rule: REOPEN_RULE }} triggerType="ticket.reply_received" onPatch={() => {}} />);
    expect(screen.getByTestId('condition-sentence')).toHaveTextContent(
      'Continues when the ticket status is Resolved or Closed, except a thank-you or out-of-office reply after an Auto-help close.',
    );
    expect(screen.getByRole('button', { name: 'Values: Resolved, Closed' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /Ignore a thank-you/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('rule-as-code-notice')).not.toBeInTheDocument();
    expect(screen.queryByText(/JSONLogic/i)).not.toBeInTheDocument();
  });

  test('an edit carries the conversion: rows + switch saved, the raw rule dropped', () => {
    const onPatch = vi.fn();
    render(<ConditionStepEditor data={{ rule: REOPEN_RULE }} triggerType="ticket.reply_received" onPatch={onPatch} />);
    fireEvent.click(screen.getByRole('button', { name: 'Values: Resolved, Closed' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Open' }));
    const patch = onPatch.mock.calls.at(-1)[0];
    expect(patch).toMatchObject({ ignoreAutoHelpThanks: true, rule: undefined });
    expect(patch.conditionGroup.conditions[0]).toEqual({ field: 'ticket.status', operator: 'in', value: ['Open', 'Resolved', 'Closed'] });
  });

  test('the old noise rule opens as the Skip noise switch with no conditions', () => {
    render(<ConditionStepEditor data={{ rule: { '!=': [v('ticket.isNoise'), true] } }} triggerType="ticket.created" onPatch={() => {}} />);
    expect(screen.getByTestId('condition-sentence')).toHaveTextContent('Every ticket continues, except noise or spam.');
    expect(screen.getByRole('switch', { name: 'Skip noise tickets' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/No conditions/)).toBeInTheDocument();
    // Not a reply workflow: the Auto-help switch is not offered.
    expect(screen.queryByTestId('auto-help-thanks-switch')).not.toBeInTheDocument();
  });
});

describe('a rule that can not be rows', () => {
  test('shows the notice, what it reads and the code read-only; "Edit as code" is only here', () => {
    const onPatch = vi.fn();
    render(<ConditionStepEditor data={{ rule: CODE_RULE }} triggerType="ticket.created" onPatch={onPatch} />);
    const notice = screen.getByTestId('rule-as-code-notice');
    expect(notice).toHaveTextContent('This step uses a rule written as code');
    expect(notice).toHaveTextContent('It reads the ticket status.');
    expect(screen.getByLabelText('Rule as code (read-only)')).toHaveTextContent('"===":');
    expect(screen.queryByText('Conditions')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Edit as code'));
    // Code that converts turns the step into rows.
    fireEvent.change(screen.getByLabelText('Rule as code'), { target: { value: JSON.stringify({ '==': [v('ticket.status'), 'Closed'] }) } });
    fireEvent.click(screen.getByText('Apply'));
    expect(onPatch).toHaveBeenLastCalledWith({ conditionGroup: { logic: 'all', conditions: [{ field: 'ticket.status', operator: 'is', value: 'Closed' }] }, rule: undefined });
  });

  test('bad JSON changes nothing and says so', () => {
    const onPatch = vi.fn();
    render(<ConditionStepEditor data={{ rule: CODE_RULE }} onPatch={onPatch} />);
    fireEvent.click(screen.getByText('Edit as code'));
    fireEvent.change(screen.getByLabelText('Rule as code'), { target: { value: '{ nope' } });
    fireEvent.click(screen.getByText('Apply'));
    expect(onPatch).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('not valid JSON');
  });
});

describe('the Auto-help thank-you switch', () => {
  test('on "Requester replied" steps it is offered and toggles the step flag', () => {
    const onPatch = vi.fn();
    render(<ConditionStepEditor data={{ conditionGroup: { logic: 'all', conditions: [] } }} triggerType="ticket.reply_received" onPatch={onPatch} />);
    const sw = screen.getByRole('switch', { name: /Ignore a thank-you/ });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(sw);
    expect(onPatch).toHaveBeenCalledWith({ ignoreAutoHelpThanks: true });
  });
});

describe('the draft conversion the panel applies when a step opens (= what Publish saves)', () => {
  test('a condition step: the saved draft holds conditionGroup and no rule', () => {
    const node = { id: 'is-resolved', type: 'condition', data: { label: 'Reopen?', rule: REOPEN_RULE } };
    const patch = stepRuleConversionPatch(node);
    // The panel merges the patch into node.data; saveDraft sends the JSON.
    const saved = JSON.parse(JSON.stringify({ ...node, data: { ...node.data, ...patch } }));
    expect(saved.data).toEqual({
      label: 'Reopen?',
      conditionGroup: { logic: 'all', conditions: [{ field: 'ticket.status', operator: 'in', value: ['Resolved', 'Closed'] }] },
      ignoreAutoHelpThanks: true,
    });
  });

  test('a branch step converts each branch it can; code stays code', () => {
    const node = { id: 'b', type: 'branch', data: { branches: [
      { key: 'urgent', label: 'Urgent', rule: { '==': [v('ticket.priorityLabel'), 'Urgent'] } },
      { key: 'odd', label: 'Odd', rule: CODE_RULE },
      { key: 'rows', label: 'Rows', conditionGroup: { logic: 'all', conditions: [] } },
    ] } };
    const { branches } = stepRuleConversionPatch(node);
    expect(branches[0]).toEqual({ key: 'urgent', label: 'Urgent', conditionGroup: { logic: 'all', conditions: [{ field: 'ticket.priorityLabel', operator: 'is', value: 'Urgent' }] } });
    expect(branches[1]).toEqual(node.data.branches[1]);
    expect(branches[2]).toBe(node.data.branches[2]);
  });

  test('nothing to convert = no patch; a step with rows is left alone', () => {
    expect(stepRuleConversionPatch({ type: 'condition', data: { conditionGroup: { logic: 'all', conditions: [] }, rule: CODE_RULE } })).toBeNull();
    expect(stepRuleConversionPatch({ type: 'condition', data: { rule: CODE_RULE } })).toBeNull();
    expect(conditionStepView({ rule: CODE_RULE }).mode).toBe('code');
    expect(conditionStepView({ rule: true }).mode).toBe('rows');
  });
});

describe('the panel no longer shows hidden code', () => {
  const panel = readFileSync(resolve(globalThis.process.cwd(), 'src/components/settings/NotificationWorkflowsPanel.jsx'), 'utf8');
  test('no always-visible "Advanced JSONLogic Rule" box; new condition steps start as rows', () => {
    expect(panel).not.toContain('Advanced JSONLogic Rule');
    expect(panel).not.toContain('conditionText');
    expect(panel).toContain("conditionGroup: { logic: 'all', conditions: [{ field: 'ticket.status', operator: 'is', value: 'Open' }] },");
    expect(panel).toContain('stepRuleConversionPatch(selectedNode)');
  });
});
