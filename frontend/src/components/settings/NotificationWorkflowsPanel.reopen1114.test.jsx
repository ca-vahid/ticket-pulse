/** @vitest-environment jsdom */
// MEGA 11-14, Part A (editor side): the reopen-on-reply workflow. The list and
// the editor of a reply workflow show the reopen check; an older reopen
// workflow offers its update as a draft; "New ticket from this reply" is a
// step only on the reply trigger; the preview tries the workflow on a past
// reply. API shapes follow qa/evidence-1114/CONTRACT_PART_A.md.
// eslint-disable-next-line no-unused-vars
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';

vi.mock('@monaco-editor/react', () => ({ default: () => <div data-testid="monaco-editor" /> }));
vi.mock('@xyflow/react', () => ({
  Background: () => null,
  BaseEdge: () => null,
  Controls: () => null,
  EdgeLabelRenderer: ({ children }) => <>{children}</>,
  Handle: () => null,
  MiniMap: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  ReactFlow: ({ children }) => <div data-testid="react-flow">{children}</div>,
  getSmoothStepPath: () => ['', 0, 0],
}));
vi.mock('@tiptap/react', () => ({ EditorContent: () => null, useEditor: () => null }));
vi.mock('@tiptap/starter-kit', () => ({ default: {} }));
vi.mock('react-resizable-panels', () => ({
  Group: ({ children }) => <div>{children}</div>,
  Panel: ({ children }) => <div>{children}</div>,
  Separator: () => <div />,
  useDefaultLayout: () => ({ defaultLayout: undefined, onLayoutChanged: vi.fn() }),
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));

const REPLY = 'ticket.reply_received';

const replyDefinition = () => ({
  version: 1,
  nodes: [
    { id: 'trigger', type: 'trigger', data: { triggerType: REPLY } },
    { id: 'is-closed', type: 'condition', data: { label: 'Closed?', conditionGroup: { logic: 'all', conditions: [{ field: 'ticket.status', operator: 'in', value: ['Resolved', 'Closed'] }] } } },
    { id: 'reopen', type: 'update_ticket', data: { label: 'Reopen', status: 'Open' } },
    { id: 'stop', type: 'stop', data: {} },
  ],
  edges: [
    { id: 'e1', source: 'trigger', target: 'is-closed' },
    { id: 'e2', source: 'is-closed', sourceHandle: 'true', target: 'reopen' },
    { id: 'e3', source: 'is-closed', sourceHandle: 'false', target: 'stop' },
    { id: 'e4', source: 'reopen', target: 'stop' },
  ],
  metadata: {},
});
const createdDefinition = () => ({
  version: 1,
  nodes: [
    { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
    { id: 'note', type: 'add_note', data: { mode: 'text', body: '<p>Hello</p>' } },
    { id: 'stop', type: 'stop', data: {} },
  ],
  edges: [{ id: 'e1', source: 'trigger', target: 'note' }, { id: 'e2', source: 'note', target: 'stop' }],
  metadata: {},
});

const base = { description: null, isDefaultVariant: true, isEnabled: true, mockModeEnabled: false, publishedVersion: 2, routingMode: 'exclusive', routingPriority: 1, routingRule: null, hasUnpublishedChanges: false, draftState: null };
const reopenWorkflow = () => ({ ...base, id: 20, key: 'reply', name: 'Reopen on requester reply', triggerType: REPLY, draftDefinition: replyDefinition(), publishedDefinition: replyDefinition() });
const arrivedWorkflow = () => ({ ...base, id: 12, key: 'intake', name: 'Intake acknowledgement', triggerType: 'ticket.created', draftDefinition: createdDefinition(), publishedDefinition: createdDefinition() });
const rows = () => [reopenWorkflow(), arrivedWorkflow()];

const WARNINGS = [
  { code: 'two_reopen_workflows', message: 'Two enabled workflows both reopen a ticket on a reply: “Reopen on requester reply” and “Reopen for the lab”.' },
];

const api = vi.hoisted(() => ({ overrides: {} }));
vi.mock('../../services/api', () => {
  const handler = {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      if (!api.overrides[prop]) api.overrides[prop] = vi.fn(async () => ({ data: null }));
      return api.overrides[prop];
    },
  };
  return { notificationWorkflowAPI: new Proxy({}, handler), ticketsAPI: new Proxy({}, handler) };
});

const { default: NotificationWorkflowsPanel, addableNodeTypesFor, validateWorkflowDefinitionClient } = await import('./NotificationWorkflowsPanel.jsx');

function renderPanel() {
  return render(
    <BrowserRouter>
      <Routes>
        <Route path="/workflows" element={<NotificationWorkflowsPanel workspaceId={5} hideTabBar />} />
      </Routes>
    </BrowserRouter>,
  );
}

beforeEach(() => {
  for (const key of Object.keys(api.overrides)) delete api.overrides[key];
  api.overrides.list = vi.fn(async () => ({ data: rows() }));
  api.overrides.get = vi.fn(async (id) => ({ data: rows().find((w) => String(w.id) === String(id)) }));
  api.overrides.reopenCheck = vi.fn(async () => ({ success: true, data: { reopenWorkflows: [{ id: 20, name: 'Reopen on requester reply', isEnabled: true }], warnings: WARNINGS } }));
  api.overrides.getReopenUpgrade = vi.fn(async () => ({ success: true, data: { available: true, changes: ['Adds “Reply sent by is not an agent”.', 'Turns on “Don\'t reopen on a thank-you or out-of-office reply”.'] } }));
  api.overrides.applyReopenUpgrade = vi.fn(async () => ({ success: true, data: { draftDefinition: replyDefinition(), changes: [] } }));
  api.overrides.conditionFields = vi.fn(async () => ({ data: [{ value: 'ticket.status', label: 'Ticket status', type: 'enum', options: ['Open', 'Pending', 'Resolved', 'Closed', 'Waiting on vendor'] }] }));
  window.localStorage.clear();
  window.history.replaceState(null, '', '/workflows');
});

afterEach(() => cleanup());

describe('the reopen check (contract §4 reopen-check)', () => {
  test('the list shows the warning above the workflows', async () => {
    renderPanel();
    const page = await screen.findByTestId('workflow-list-page');
    const notice = await within(page).findByTestId('reopen-check-notice');
    expect(notice).toHaveTextContent('Two enabled workflows both reopen a ticket on a reply');
    expect(notice.querySelector('[data-code="two_reopen_workflows"]')).toBeTruthy();
  });

  test('"no workflow reopens" shows too; no warnings = no notice', async () => {
    api.overrides.reopenCheck = vi.fn(async () => ({ data: { reopenWorkflows: [], warnings: [{ code: 'no_reopen_workflow', message: 'No enabled workflow reopens a ticket when the requester replies.' }] } }));
    renderPanel();
    expect(await screen.findByTestId('reopen-check-notice')).toHaveTextContent('No enabled workflow reopens a ticket when the requester replies.');
    cleanup();
    api.overrides.reopenCheck = vi.fn(async () => ({ data: { reopenWorkflows: [], warnings: [] } }));
    renderPanel();
    await screen.findByTestId('workflow-list-page');
    await waitFor(() => expect(api.overrides.reopenCheck).toHaveBeenCalled());
    expect(screen.queryByTestId('reopen-check-notice')).not.toBeInTheDocument();
  });

  test('the editor of a reply workflow shows it; another workflow does not', async () => {
    window.history.replaceState(null, '', '/workflows?wf=20');
    renderPanel();
    expect(await screen.findByTestId('reopen-check-notice')).toHaveTextContent('Two enabled workflows');
    cleanup();
    window.history.replaceState(null, '', '/workflows?wf=12');
    renderPanel();
    await screen.findByTestId('workflow-back-to-list');
    await waitFor(() => expect(api.overrides.get).toHaveBeenCalledWith(12));
    expect(screen.queryByTestId('reopen-check-notice')).not.toBeInTheDocument();
  });
});

describe('the upgrade offer (contract §4 reopen-upgrade)', () => {
  test('an older reopen workflow says it can be updated; the button writes a draft and opens it, never publishes', async () => {
    window.history.replaceState(null, '', '/workflows?wf=20');
    renderPanel();
    const banner = await screen.findByTestId('reopen-upgrade-banner');
    expect(api.overrides.getReopenUpgrade).toHaveBeenCalledWith(20);
    expect(banner).toHaveTextContent('This workflow can be updated');
    expect(banner).toHaveTextContent('Adds “Reply sent by is not an agent”.');
    expect(banner).toHaveTextContent('It lands as a draft. Nothing changes until you publish it.');
    const getsBefore = api.overrides.get.mock.calls.length;
    fireEvent.click(within(banner).getByRole('button', { name: 'Update as a draft' }));
    await waitFor(() => expect(api.overrides.applyReopenUpgrade).toHaveBeenCalledWith(20));
    // The editor loads the workflow again, now holding the draft.
    await waitFor(() => expect(api.overrides.get.mock.calls.length).toBeGreaterThan(getsBefore));
    expect(await screen.findByText('The update is in the draft. Check it, then Save & publish.')).toBeInTheDocument();
    expect(api.overrides.publish).toBeUndefined(); // never touched
    await waitFor(() => expect(screen.queryByTestId('reopen-upgrade-banner')).not.toBeInTheDocument());
  });

  test('nothing to update = no banner; a non-reply workflow never asks', async () => {
    api.overrides.getReopenUpgrade = vi.fn(async () => ({ data: { available: false, changes: [] } }));
    window.history.replaceState(null, '', '/workflows?wf=20');
    renderPanel();
    await screen.findByTestId('workflow-back-to-list');
    await waitFor(() => expect(api.overrides.getReopenUpgrade).toHaveBeenCalledWith(20));
    expect(screen.queryByTestId('reopen-upgrade-banner')).not.toBeInTheDocument();
    cleanup();
    api.overrides.getReopenUpgrade = vi.fn(async () => ({ data: { available: true, changes: ['x'] } }));
    window.history.replaceState(null, '', '/workflows?wf=12');
    renderPanel();
    await screen.findByTestId('workflow-back-to-list');
    await waitFor(() => expect(api.overrides.get).toHaveBeenCalledWith(12));
    expect(api.overrides.getReopenUpgrade).not.toHaveBeenCalled();
  });
});

describe('"New ticket from this reply" (contract §3)', () => {
  const openPalette = async () => {
    fireEvent.click(await screen.findByRole('button', { name: /Add step/ }));
  };

  test('the step is in the palette on the reply trigger only', async () => {
    window.history.replaceState(null, '', '/workflows?wf=20');
    renderPanel();
    await openPalette();
    expect(screen.getByRole('button', { name: /New ticket from this reply/ })).toBeInTheDocument();
    cleanup();
    window.history.replaceState(null, '', '/workflows?wf=12');
    renderPanel();
    await openPalette();
    expect(screen.getByRole('button', { name: /Create child ticket/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New ticket from this reply/ })).not.toBeInTheDocument();
  });

  test('addableNodeTypesFor and the publish check agree', () => {
    expect(addableNodeTypesFor(REPLY)).toContain('create_ticket_from_reply');
    expect(addableNodeTypesFor('ticket.created')).not.toContain('create_ticket_from_reply');
    expect(addableNodeTypesFor(null)).not.toContain('create_ticket_from_reply');
    const withStep = (triggerType) => ({
      ...replyDefinition(),
      nodes: [...replyDefinition().nodes.map((n) => (n.type === 'trigger' ? { ...n, data: { triggerType } } : n)), { id: 'split', type: 'create_ticket_from_reply', data: { label: 'New ticket from this reply' } }],
      edges: [...replyDefinition().edges, { id: 'e5', source: 'is-closed', sourceHandle: 'true', target: 'split' }],
    });
    expect(validateWorkflowDefinitionClient(withStep(REPLY), REPLY).join(' ')).not.toMatch(/New ticket from this reply/);
    expect(validateWorkflowDefinitionClient(withStep('ticket.created'), 'ticket.created')).toContain('"New ticket from this reply" works only on "Requester replied" workflows.');
  });
});

describe('"Try it on a past reply" (contract §4 /test + reply-candidates)', () => {
  test('pick a ticket, pick a reply, as if Closed, AI off: the verdict is one line above the step results', async () => {
    api.overrides.getPreviewTickets = vi.fn(async () => ({ data: { items: [{ id: 101, displayRef: 'TP-101', subject: 'Printer on floor 3', status: 'Closed', priorityLabel: 'Low', createdAt: '2026-11-10T17:00:00Z', requester: { name: 'Alex Rivera' } }], page: 1, pageSize: 25, total: 1, totalPages: 1 } }));
    api.overrides.replyCandidates = vi.fn(async () => ({ success: true, data: [
      { id: 555, occurredAt: '2026-11-12T17:14:00Z', fromEmail: 'alex.rivera@example.com', fromName: 'Alex Rivera', preview: 'Thanks, all working now!' },
      { id: 554, occurredAt: '2026-11-11T17:00:00Z', fromEmail: 'alex.rivera@example.com', fromName: 'Alex Rivera', preview: 'It is still jamming.' },
    ] }));
    api.overrides.test = vi.fn(async () => ({ success: true, data: { runId: 9, status: 'completed', steps: [], replyPreview: { sentBy: 'requester', replyVerdict: 'thanks', closedMinutes: 4320, replyToWorkflowEmail: false, outcome: 'stays_closed', why: 'Reply read as a thank-you; the ticket stays closed.' } } }));
    window.history.replaceState(null, '', '/workflows?wf=20');
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /^Preview$/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pick TP-101' }));
    const bar = await screen.findByTestId('reply-trial-bar');
    await waitFor(() => expect(api.overrides.replyCandidates).toHaveBeenCalledWith(101));
    const reply = await within(bar).findByRole('combobox', { name: 'Reply' });
    expect(within(reply).getAllByRole('option')).toHaveLength(2);
    expect(reply).toHaveValue('555');
    const status = within(bar).getByRole('combobox', { name: 'As if the ticket was' });
    expect(status).toHaveValue('Closed');
    await waitFor(() => expect(within(status).getByRole('option', { name: 'Waiting on vendor' })).toBeInTheDocument());
    expect(within(bar).getByRole('checkbox', { name: 'Use AI' })).not.toBeChecked();
    expect(api.overrides.test).not.toHaveBeenCalled(); // picking runs nothing

    fireEvent.change(reply, { target: { value: '554' } });
    fireEvent.click(within(bar).getByRole('button', { name: 'Try it' }));
    await waitFor(() => expect(api.overrides.test).toHaveBeenCalledTimes(1));
    expect(api.overrides.test.mock.calls[0][0]).toMatchObject({ workflowId: 20, ticketId: 101, replyEntryId: 554, asStatus: 'Closed', executeLlm: false });
    const outcome = await screen.findByTestId('reply-outcome');
    expect(outcome).toHaveTextContent('Would stay closed');
    expect(outcome).toHaveTextContent('Reply read as a thank-you; the ticket stays closed.');
    expect(outcome).toHaveTextContent('Sent by Requester · Reads as Thanks · Closed 3 days');
  });

  test('"Use AI" ticked asks for the AI reading; another status is sent as picked', async () => {
    api.overrides.getPreviewTickets = vi.fn(async () => ({ data: { items: [{ id: 101, displayRef: 'TP-101', subject: 'Printer', status: 'Open' }], page: 1, pageSize: 25, total: 1, totalPages: 1 } }));
    api.overrides.replyCandidates = vi.fn(async () => ({ data: [{ id: 555, occurredAt: '2026-11-12T17:14:00Z', fromEmail: 'sam.ortiz@example.com', preview: 'Still broken' }] }));
    api.overrides.test = vi.fn(async () => ({ data: { runId: 9, status: 'completed', steps: [], replyPreview: { outcome: 'reopen', why: 'Reply reads as still not fixed.' } } }));
    window.history.replaceState(null, '', '/workflows?wf=20');
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /^Preview$/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pick TP-101' }));
    const bar = await screen.findByTestId('reply-trial-bar');
    await within(bar).findByRole('combobox', { name: 'Reply' });
    fireEvent.change(within(bar).getByRole('combobox', { name: 'As if the ticket was' }), { target: { value: 'Resolved' } });
    fireEvent.click(within(bar).getByRole('checkbox', { name: 'Use AI' }));
    fireEvent.click(within(bar).getByRole('button', { name: 'Try it' }));
    await waitFor(() => expect(api.overrides.test).toHaveBeenCalledTimes(1));
    expect(api.overrides.test.mock.calls[0][0]).toMatchObject({ replyEntryId: 555, asStatus: 'Resolved', executeLlm: true });
    expect(await screen.findByTestId('reply-outcome')).toHaveTextContent('Would reopen');
  });

  test('a ticket with no replies says so and can still run plainly', async () => {
    api.overrides.getPreviewTickets = vi.fn(async () => ({ data: { items: [{ id: 101, displayRef: 'TP-101', subject: 'Printer', status: 'Open' }], page: 1, pageSize: 25, total: 1, totalPages: 1 } }));
    api.overrides.replyCandidates = vi.fn(async () => ({ data: [] }));
    api.overrides.test = vi.fn(async () => ({ data: { runId: 9, status: 'completed', steps: [] } }));
    window.history.replaceState(null, '', '/workflows?wf=20');
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /^Preview$/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pick TP-101' }));
    const bar = await screen.findByTestId('reply-trial-bar');
    expect(await within(bar).findByText('This ticket has no replies from the requester yet.')).toBeInTheDocument();
    fireEvent.click(within(bar).getByRole('button', { name: 'Run without a reply' }));
    await waitFor(() => expect(api.overrides.test).toHaveBeenCalledTimes(1));
    expect(api.overrides.test.mock.calls[0][0].replyEntryId).toBeUndefined();
    expect(api.overrides.test.mock.calls[0][0].executeLlm).toBe(true);
  });
});
