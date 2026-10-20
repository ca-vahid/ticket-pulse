/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Send, UserCheck } from 'lucide-react';

// QA 09-29 #2: Mail Workflows opens on a full-width list; a workflow opens on
// its own page. QA 10-19 #2–#5: grouped by lifecycle stage and trigger, a
// lifecycle navigation, filter tabs with counts, no noise-check warning on
// the list, and every row a real link.
vi.mock('../../contexts/WorkspaceContext', () => ({ useWorkspace: () => ({ currentWorkspace: { id: 1 } }) }));

import WorkflowListPage, { workflowKind } from './WorkflowListPage';
import { groupWorkflowsByStage, stageForTrigger } from '../../utils/workflowStages';

afterEach(cleanup);

const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const NOISE_SIGNAL = { code: 'noise_check_replaced', nodeId: 'cond', message: 'Step "Skip noise tickets" no longer skips noise tickets: its conditions replaced the built-in noise rule.' };
const QUIET_SIGNAL = { code: 'went_quiet', message: 'Ran 5 times in the last 24 hours and sent nothing; it sent 9 e-mails in the seven days before.' };
const WORKFLOWS = [
  { id: 1, name: 'Ticket arrived', triggerType: 'ticket.created', isDefaultVariant: true, isEnabled: true, mockModeEnabled: false, publishedVersion: 4, runs: [{ status: 'completed', startedAt: hoursAgo(2) }], watchSignals: [NOISE_SIGNAL] },
  { id: 2, name: 'Ticket arrived after-hours', description: 'Night and holiday acknowledgement', triggerType: 'ticket.created', routingRule: { field: 'x' }, isEnabled: true, mockModeEnabled: true, publishedVersion: 8, runs: [] },
  { id: 3, name: 'Ticket assigned', triggerType: 'ticket.assigned', isDefaultVariant: true, isEnabled: true, publishedVersion: 20, runs: [{ status: 'failed', startedAt: hoursAgo(1) }] },
  { id: 4, name: 'Nobody picked this up', triggerType: 'ticket.unassigned_for', isEnabled: false, publishedVersion: 0, runs: [] },
  { id: 5, name: 'Closed survey', triggerType: 'ticket.resolved_closed', isDefaultVariant: true, isEnabled: true, publishedVersion: 2, runs: [], watchSignals: [QUIET_SIGNAL] },
  { id: 6, name: 'Weekly digest', triggerType: 'schedule.time', isEnabled: false, publishedVersion: 1, runs: [] },
  { id: 7, name: 'Old variant', triggerType: 'ticket.created', archivedAt: hoursAgo(48), isEnabled: false, publishedVersion: 1, runs: [] },
];
const LABELS = {
  'ticket.created': 'Ticket arrived',
  'ticket.assigned': 'Ticket assigned',
  'ticket.unassigned_for': 'Ticket unassigned for N hours',
  'ticket.resolved_closed': 'Resolved or closed',
  'schedule.time': 'On a schedule (digest)',
};
const visuals = (t) => ({ icon: t === 'ticket.assigned' ? UserCheck : Send });

const renderList = (props = {}) => {
  const onOpen = vi.fn();
  render(<WorkflowListPage workflows={WORKFLOWS} onOpen={onOpen} onCreate={vi.fn()} eventLabels={LABELS} getVisuals={visuals} {...props} />);
  return { onOpen };
};
const rowFor = (name) => screen.getAllByTestId('workflow-list-row').find((row) => within(row).getByRole('link').textContent.startsWith(name));

describe('Mail Workflows list page', () => {
  test('grouped by lifecycle stage, then trigger, with variants indented under their default', () => {
    renderList();
    const stages = screen.getAllByTestId('workflow-stage');
    expect(stages.map((s) => s.getAttribute('data-stage'))).toEqual(['intake', 'ownership', 'closure', 'other']);
    expect(stages[0]).toHaveTextContent('01Intake— New and triaged tickets');
    // Ownership holds both of its triggers, in ticket-life order.
    expect(within(stages[1]).getAllByTestId('workflow-list-group').map((g) => g.getAttribute('aria-label')))
      .toEqual(['Ticket assigned', 'Ticket unassigned for N hours']);
    // A trigger card: "When <trigger> <count>".
    const arrived = within(stages[0]).getByTestId('workflow-list-group');
    expect(within(arrived).getByTestId('workflow-list-group-header')).toHaveTextContent(/When\s*Ticket arrived\s*2/);
    const rows = within(arrived).getAllByTestId('workflow-list-row');
    expect(rows[0]).toHaveTextContent('Ticket arrived');
    expect(rows[0]).not.toHaveAttribute('data-variant');
    expect(rows[1]).toHaveAttribute('data-variant', 'true');
    expect(within(rows[1]).getByRole('link').className).toContain('pl-11');
    // Schedules land in Other.
    expect(within(stages[3]).getByTestId('workflow-list-group')).toHaveAttribute('data-trigger', 'schedule.time');
  });

  test('rows show mode as a dot and a word, routing, version and last run', () => {
    renderList();
    const first = rowFor('Ticket arrived');
    expect(first).toHaveTextContent('Live');
    expect(first).toHaveTextContent('Default');
    expect(first).toHaveTextContent('v4');
    expect(first).toHaveTextContent('Ran 2h ago');
    const variant = rowFor('Ticket arrived after-hours');
    expect(variant).toHaveTextContent('Night and holiday acknowledgement');
    expect(variant).toHaveTextContent('Shadow');
    expect(variant).toHaveTextContent('Routed');
    expect(rowFor('Ticket assigned')).toHaveTextContent('Failed 1h ago');
    expect(rowFor('Nobody picked this up')).toHaveTextContent('draft');
    expect(screen.getByRole('heading', { name: /Workflows\s*6/ })).toBeInTheDocument();
  });

  test('every row is a real link to the workflow page; a plain click opens it in place', () => {
    const { onOpen } = renderList({ getHref: (id) => `/workflows?wf=${id}` });
    const link = within(rowFor('Ticket assigned')).getByRole('link');
    expect(link).toHaveAttribute('href', '/workflows?wf=3');
    const plain = fireEvent.click(link);
    expect(plain).toBe(false); // default prevented: in-app navigation
    expect(onOpen).toHaveBeenCalledWith(3);
  });

  test('Ctrl/Cmd-click and middle-click are left to the browser (new tab)', () => {
    const { onOpen } = renderList();
    const link = within(rowFor('Ticket assigned')).getByRole('link');
    expect(link).toHaveAttribute('href', '?wf=3');
    // Record whether the row let the click through, then stop jsdom from
    // trying to navigate.
    const passedThrough = [];
    const record = (e) => { passedThrough.push(!e.defaultPrevented); e.preventDefault(); };
    window.addEventListener('click', record);
    fireEvent.click(link, { ctrlKey: true });
    fireEvent.click(link, { metaKey: true });
    fireEvent.click(link, { button: 1 });
    window.removeEventListener('click', record);
    expect(passedThrough).toEqual([true, true, true]);
    expect(onOpen).not.toHaveBeenCalled();
  });

  test('the "Skip noise tickets" watch warning is not on the list; other signals are', () => {
    renderList();
    expect(screen.queryByText(/no longer skips noise tickets/)).not.toBeInTheDocument();
    const signals = screen.getAllByTestId('workflow-watch-signal');
    expect(signals).toHaveLength(1);
    expect(signals[0]).toHaveTextContent('sent nothing');
    // The navigation's warning dots count the same way.
    const nav = screen.getByRole('navigation', { name: 'Ticket lifecycle' });
    expect(within(nav).getAllByTestId('workflow-lifecycle-warning')).toHaveLength(1);
    expect(within(nav).getByRole('button', { name: /Resolved or closed/ })).toHaveTextContent('with warnings');
    expect(within(nav).getByRole('button', { name: /Ticket arrived/ })).not.toHaveTextContent('with warnings');
  });

  test('the lifecycle navigation lists stages and triggers with counts, and jumps to a trigger', () => {
    renderList();
    const nav = screen.getByRole('navigation', { name: 'Ticket lifecycle' });
    expect(nav).toHaveTextContent('Jump to workflows by the stage that triggers them');
    const stageKeys = within(nav).getAllByTestId('workflow-lifecycle-stage').map((s) => s.getAttribute('data-stage'));
    expect(stageKeys).toEqual(['intake', 'ownership', 'changes', 'requester', 'closure', 'other']);
    // Short labels in the navigation: "On a schedule (digest)" → "On a schedule".
    const schedule = within(nav).getByRole('button', { name: /On a schedule/ });
    expect(schedule).toHaveTextContent(/^On a schedule1$/);
    const assigned = within(nav).getByRole('button', { name: /Ticket assigned/ });
    expect(assigned).toHaveTextContent('1');
    const scrollIntoView = vi.fn();
    const card = screen.getAllByTestId('workflow-list-group').find((g) => g.getAttribute('data-trigger') === 'ticket.assigned');
    card.scrollIntoView = scrollIntoView;
    fireEvent.click(assigned);
    expect(scrollIntoView).toHaveBeenCalled();
    expect(assigned).toHaveAttribute('aria-current', 'true');
    expect(document.activeElement).toBe(card);
  });

  test('filter tabs carry counts and narrow the list; the filter box searches names and triggers', () => {
    renderList();
    const tabs = screen.getByRole('group', { name: 'Filter workflows' });
    expect(within(tabs).getByRole('button', { name: /^All/ })).toHaveTextContent('All6');
    expect(within(tabs).getByRole('button', { name: /^Enabled/ })).toHaveTextContent('Enabled2');
    expect(within(tabs).getByRole('button', { name: /^Shadow/ })).toHaveTextContent('Shadow1');
    expect(within(tabs).getByRole('button', { name: /^Failing/ })).toHaveTextContent('Failing1');
    expect(within(tabs).getByRole('button', { name: /^Off/ })).toHaveTextContent('Off2');
    expect(within(tabs).getByRole('button', { name: /^Archived/ })).toHaveTextContent('Archived1');

    fireEvent.change(screen.getByLabelText('Filter by name or trigger'), { target: { value: 'holiday' } });
    expect(screen.getAllByTestId('workflow-list-row')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Filter by name or trigger'), { target: { value: 'unassigned' } });
    expect(screen.getAllByTestId('workflow-list-row')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    fireEvent.click(within(tabs).getByRole('button', { name: /^Failing/ }));
    expect(screen.getAllByTestId('workflow-list-row').map((r) => r.getAttribute('data-state'))).toEqual(['failing']);
    fireEvent.click(within(tabs).getByRole('button', { name: /^Off/ }));
    expect(screen.getAllByTestId('workflow-list-row')).toHaveLength(2);
    fireEvent.click(within(tabs).getByRole('button', { name: /^Shadow/ }));
    expect(screen.getAllByTestId('workflow-list-row')[0]).toHaveTextContent('after-hours');
    fireEvent.click(within(tabs).getByRole('button', { name: /^Archived/ }));
    expect(screen.getAllByTestId('workflow-list-row').map((r) => r.getAttribute('data-state'))).toEqual(['archived']);
  });

  test('Archived follows the parent when it manages it', () => {
    const onShowArchivedChange = vi.fn();
    renderList({ showArchived: false, onShowArchivedChange });
    fireEvent.click(screen.getByRole('button', { name: /^Archived/ }));
    expect(onShowArchivedChange).toHaveBeenCalledWith(true);
  });

  test('nothing matches → says so', () => {
    renderList();
    fireEvent.change(screen.getByLabelText('Filter by name or trigger'), { target: { value: 'zzz' } });
    expect(screen.getByText('No workflows match.')).toBeInTheDocument();
  });

  test('stats line, New workflow, per-trigger Add, and the actions slot', () => {
    const onCreate = vi.fn();
    const onCreateForTrigger = vi.fn();
    render(
      <WorkflowListPage
        workflows={WORKFLOWS}
        onOpen={vi.fn()}
        onCreate={onCreate}
        onCreateForTrigger={onCreateForTrigger}
        eventLabels={LABELS}
        getVisuals={visuals}
        stats={{ failedEmailDeliveries24h: 3, workflowAuditRuns7d: 41 }}
        actions={<button type="button">Templates</button>}
      />,
    );
    expect(screen.getByTestId('workflow-list-stats')).toHaveTextContent('4 enabled · 3 failed e-mails in 24h · 41 audit runs in 7d');
    fireEvent.click(screen.getByRole('button', { name: 'New workflow' }));
    expect(onCreate).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Add a workflow for Ticket assigned' }));
    expect(onCreateForTrigger).toHaveBeenCalledWith('ticket.assigned');
    expect(screen.getByRole('button', { name: 'Templates' })).toBeInTheDocument();
  });

  test('workflowKind names the kind, with after-hours when it is one', () => {
    expect(workflowKind({ isDefaultVariant: true })).toBe('Default');
    expect(workflowKind({ triggerType: 'manual' })).toBe('Sub-workflow');
    expect(workflowKind({ routingRule: {} }, { isAfterHours: () => true })).toBe('Routed · after-hours');
  });
});

describe('workflow stage map', () => {
  test('known triggers map to their stage; unknown ones land in Other', () => {
    expect(stageForTrigger('ticket.ready').key).toBe('intake');
    expect(stageForTrigger('ticket.reassigned').key).toBe('ownership');
    expect(stageForTrigger('ticket.fields_updated').key).toBe('changes');
    expect(stageForTrigger('ticket.requester_silent_for').key).toBe('requester');
    expect(stageForTrigger('ticket.reopened').key).toBe('closure');
    expect(stageForTrigger('approval.decided').key).toBe('other');
    expect(stageForTrigger('something.new').key).toBe('other');
  });

  test('a trigger with no default lists every workflow at the top level', () => {
    const [{ triggers }] = groupWorkflowsByStage([
      { id: 1, name: 'B', triggerType: 'ticket.created' },
      { id: 2, name: 'A', triggerType: 'ticket.created' },
    ]);
    expect(triggers[0].parent).toBeNull();
    expect(triggers[0].workflows.map((w) => w.name)).toEqual(['A', 'B']);
  });
});
