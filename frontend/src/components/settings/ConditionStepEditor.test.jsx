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
import { conditionStepView, describeStep, stepRuleConversionPatch } from '../../utils/conditionStepView';

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
  test('the seeded reopen rule shows the sentence, the rows and the thank-you switch — no code', () => {
    render(<ConditionStepEditor data={{ label: 'Reopen?', rule: REOPEN_RULE }} triggerType="ticket.reply_received" onPatch={() => {}} />);
    // MEGA 11-14: the old Auto-help guard reads as the new thank-you switch.
    expect(screen.getByTestId('condition-sentence')).toHaveTextContent(
      'Continues when the ticket status is Resolved or Closed, except a thank-you or out-of-office reply.',
    );
    expect(screen.getByRole('button', { name: 'Values: Resolved, Closed' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /Don't reopen on a thank-you/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('rule-as-code-notice')).not.toBeInTheDocument();
    expect(screen.queryByText(/JSONLogic/i)).not.toBeInTheDocument();
  });

  test('an edit carries the conversion: rows + switch saved, the raw rule dropped', () => {
    const onPatch = vi.fn();
    render(<ConditionStepEditor data={{ rule: REOPEN_RULE }} triggerType="ticket.reply_received" onPatch={onPatch} />);
    fireEvent.click(screen.getByRole('button', { name: 'Values: Resolved, Closed' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Open' }));
    const patch = onPatch.mock.calls.at(-1)[0];
    // The conversion writes the shared module's key (old or new name); the switch reads both.
    expect(patch).toMatchObject({ rule: undefined });
    expect(patch.ignoreAutoHelpThanks === true || patch.ignoreThanks === true).toBe(true);
    expect(patch.conditionGroup.conditions[0]).toEqual({ field: 'ticket.status', operator: 'in', value: ['Open', 'Resolved', 'Closed'] });
  });

  test('the old noise rule opens as the Skip noise switch with no conditions', () => {
    render(<ConditionStepEditor data={{ rule: { '!=': [v('ticket.isNoise'), true] } }} triggerType="ticket.created" onPatch={() => {}} />);
    expect(screen.getByTestId('condition-sentence')).toHaveTextContent('Every ticket continues, except noise or spam.');
    expect(screen.getByRole('switch', { name: 'Skip noise tickets' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/No conditions/)).toBeInTheDocument();
    // Not a reply workflow: the reply switches are not offered.
    expect(screen.queryByTestId('thanks-switch')).not.toBeInTheDocument();
    expect(screen.queryByTestId('loop-guard-switch')).not.toBeInTheDocument();
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

describe('the reply step switches (MEGA 11-14)', () => {
  const EMPTY = { conditionGroup: { logic: 'all', conditions: [] } };
  const thanks = () => screen.getByRole('switch', { name: "Don't reopen on a thank-you or out-of-office reply" });
  const loop = () => screen.getByRole('switch', { name: 'Stop after 3 reopens by replies in a day' });

  test('on "Requester replied" steps both switches show and write their own keys', () => {
    const onPatch = vi.fn();
    render(<ConditionStepEditor data={EMPTY} triggerType="ticket.reply_received" onPatch={onPatch} />);
    expect(thanks()).toHaveAttribute('aria-checked', 'false');
    expect(loop()).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(thanks());
    expect(onPatch).toHaveBeenLastCalledWith({ ignoreThanks: true, ignoreAutoHelpThanks: undefined });
    fireEvent.click(loop());
    expect(onPatch).toHaveBeenLastCalledWith({ replyLoopGuard: true });
  });

  test('the legacy ignoreAutoHelpThanks key shows the thank-you switch on; the first toggle writes ignoreThanks and drops the old key', () => {
    const onPatch = vi.fn();
    render(<ConditionStepEditor data={{ ...EMPTY, ignoreAutoHelpThanks: true }} triggerType="ticket.reply_received" onPatch={onPatch} />);
    expect(thanks()).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(thanks());
    const patch = onPatch.mock.calls.at(-1)[0];
    expect(patch).toEqual({ ignoreThanks: false, ignoreAutoHelpThanks: undefined });
    // Saved as JSON, the old key is gone.
    expect(JSON.parse(JSON.stringify({ ...EMPTY, ignoreAutoHelpThanks: true, ...patch }))).toEqual({ ...EMPTY, ignoreThanks: false });
  });

  test('the sentence names both switches', () => {
    render(<ConditionStepEditor data={{ conditionGroup: { logic: 'all', conditions: [{ field: 'ticket.status', operator: 'in', value: ['Resolved', 'Closed'] }] }, ignoreThanks: true, replyLoopGuard: true, skipNoise: true }} triggerType="ticket.reply_received" onPatch={() => {}} />);
    expect(screen.getByTestId('condition-sentence')).toHaveTextContent(
      'Continues when the ticket status is Resolved or Closed, except noise or spam and a thank-you or out-of-office reply. Stops after 3 reopens by replies in a day.',
    );
    expect(thanks()).toHaveAttribute('aria-checked', 'true');
    expect(loop()).toHaveAttribute('aria-checked', 'true');
  });

  test('the new reply fields read as words in the sentence, not codes', () => {
    render(<ConditionStepEditor data={{ conditionGroup: { logic: 'all', conditions: [
      { field: 'event.replyVerdict', operator: 'not_in', value: ['new_request', 'auto_reply'] },
      { field: 'ticket.closedMinutes', operator: 'lt', value: 20160 },
    ] } }} triggerType="ticket.reply_received" onPatch={() => {}} />);
    const sentence = screen.getByTestId('condition-sentence').textContent;
    expect(sentence).toContain('is not new request or out-of-office');
    expect(sentence).toContain('is less than 14 days');
    expect(sentence).not.toMatch(/new_request|auto_reply|20160/);
  });

  test('on another trigger a switch shows only while it is on, so it can be turned off', () => {
    render(<ConditionStepEditor data={{ ...EMPTY, replyLoopGuard: true }} triggerType="ticket.created" onPatch={() => {}} />);
    expect(loop()).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('thanks-switch')).not.toBeInTheDocument();
  });
});

describe('Resolve when the requester confirms it\'s done (waiting tickets), 19 Nov 2026', () => {
  const EMPTY = { conditionGroup: { logic: 'all', conditions: [] } };
  const group = () => screen.getByRole('radiogroup', { name: "Resolve when the requester confirms it's done (waiting tickets)" });
  const choice = (name) => screen.getByRole('radio', { name });

  test('on "Requester replied" steps: Off / Shadow / Live, an old step reads Off; a pick writes resolveConfirmedDone', () => {
    const onPatch = vi.fn();
    render(<ConditionStepEditor data={EMPTY} triggerType="ticket.reply_received" onPatch={onPatch} />);
    expect(group()).toBeInTheDocument();
    expect(choice('Off')).toHaveAttribute('aria-checked', 'true');
    expect(choice('Shadow')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('confirmed-done-switch')).toHaveTextContent('goes on to the conditions below, as before');
    fireEvent.click(choice('Shadow'));
    expect(onPatch).toHaveBeenLastCalledWith({ resolveConfirmedDone: 'shadow' });
    fireEvent.click(choice('Live'));
    expect(onPatch).toHaveBeenLastCalledWith({ resolveConfirmedDone: 'live' });
    // Picking the one already chosen writes nothing.
    onPatch.mockClear();
    fireEvent.click(choice('Off'));
    expect(onPatch).not.toHaveBeenCalled();
  });

  test('it sits next to the thank-you switch and its line says what each mode does', () => {
    const { rerender } = render(<ConditionStepEditor data={{ ...EMPTY, ignoreThanks: true, resolveConfirmedDone: 'shadow' }} triggerType="ticket.reply_received" onPatch={() => {}} />);
    const thanksRow = screen.getByTestId('thanks-switch');
    expect(thanksRow.nextElementSibling).toBe(screen.getByTestId('confirmed-done-switch'));
    expect(choice('Shadow')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('confirmed-done-switch')).toHaveTextContent('Waiting tickets still reopen. The ticket history records each one it would have resolved.');
    rerender(<ConditionStepEditor data={{ ...EMPTY, resolveConfirmedDone: 'live' }} triggerType="ticket.reply_received" onPatch={() => {}} />);
    expect(screen.getByTestId('confirmed-done-switch')).toHaveTextContent('No e-mail goes to the requester.');
    expect(screen.getByTestId('confirmed-done-switch')).toHaveTextContent('the workflow stops here');
    expect(screen.getByTestId('confirmed-done-switch')).toHaveTextContent('FreshService-born tickets are only recorded.');
    expect(screen.getByTestId('condition-sentence')).toHaveTextContent('A waiting ticket is resolved instead when the requester confirms it\'s done.');
  });

  test('on another trigger it shows only while it is not Off; an unknown value reads Off', () => {
    render(<ConditionStepEditor data={EMPTY} triggerType="ticket.created" onPatch={() => {}} />);
    expect(screen.queryByTestId('confirmed-done-switch')).not.toBeInTheDocument();
    cleanup();
    render(<ConditionStepEditor data={{ ...EMPTY, resolveConfirmedDone: 'live' }} triggerType="ticket.created" onPatch={() => {}} />);
    expect(choice('Live')).toHaveAttribute('aria-checked', 'true');
    cleanup();
    render(<ConditionStepEditor data={{ ...EMPTY, resolveConfirmedDone: 'bogus' }} triggerType="ticket.reply_received" onPatch={() => {}} />);
    expect(choice('Off')).toHaveAttribute('aria-checked', 'true');
  });

  test('the sentence names Shadow; Off adds nothing', () => {
    expect(describeStep({ ...EMPTY, resolveConfirmedDone: 'shadow' })).toBe('Every ticket continues. Shadow: records when a waiting ticket\'s requester confirms it\'s done.');
    expect(describeStep({ ...EMPTY, resolveConfirmedDone: 'off' })).toBe('Every ticket continues.');
  });
});

describe('the step sentence and canvas caption (describeStep)', () => {
  test('short form for the canvas; null for code', () => {
    expect(describeStep({ conditionGroup: { logic: 'all', conditions: [] }, ignoreThanks: true }, { short: true })).toBe('All but a thank-you or out-of-office reply');
    expect(describeStep({ conditionGroup: { logic: 'all', conditions: [] } })).toBe('Every ticket continues.');
    expect(describeStep({ rule: CODE_RULE })).toBeNull();
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
