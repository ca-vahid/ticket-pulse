/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Send, UserCheck } from 'lucide-react';

// QA 09-29 #2: Mail Workflows opens on a full-width list, grouped by trigger;
// a workflow opens on its own page.
vi.mock('../../contexts/WorkspaceContext', () => ({ useWorkspace: () => ({ currentWorkspace: { id: 1 } }) }));

import WorkflowListPage, { workflowKind } from './WorkflowListPage';

afterEach(cleanup);

const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const WORKFLOWS = [
  { id: 1, name: 'Ticket arrived', triggerType: 'ticket.created', isDefaultVariant: true, isEnabled: true, mockModeEnabled: false, publishedVersion: 4, runs: [{ status: 'completed', startedAt: hoursAgo(2) }] },
  { id: 2, name: 'Ticket arrived after-hours', description: 'Night and holiday acknowledgement', triggerType: 'ticket.created', routingRule: { field: 'x' }, isEnabled: true, mockModeEnabled: true, publishedVersion: 8, runs: [] },
  { id: 3, name: 'Ticket assigned', triggerType: 'ticket.assigned', isDefaultVariant: true, isEnabled: true, publishedVersion: 20, runs: [{ status: 'failed', startedAt: hoursAgo(1) }] },
  { id: 4, name: 'Nobody picked this up', triggerType: 'ticket.unassigned_for', isEnabled: false, publishedVersion: 0, runs: [] },
];
const LABELS = { 'ticket.created': 'Ticket arrived', 'ticket.assigned': 'Ticket assigned', 'ticket.unassigned_for': 'Ticket unassigned for N hours' };
const visuals = (t) => ({ icon: t === 'ticket.assigned' ? UserCheck : Send });

const renderList = (props = {}) => {
  const onOpen = vi.fn();
  render(<WorkflowListPage workflows={WORKFLOWS} onOpen={onOpen} onCreate={vi.fn()} eventLabels={LABELS} getVisuals={visuals} {...props} />);
  return { onOpen };
};

describe('Mail Workflows list page', () => {
  test('every workflow, grouped by trigger in ticket-life order, with state, kind, version and last run', () => {
    renderList();
    const groups = screen.getAllByTestId('workflow-list-group');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Ticket arrived', 'Ticket assigned', 'Ticket unassigned for N hours']);
    const rows = within(groups[0]).getAllByTestId('workflow-list-row');
    // The default variant leads its group.
    expect(rows[0]).toHaveTextContent('Ticket arrived');
    expect(rows[0]).toHaveTextContent('Enabled');
    expect(rows[0]).toHaveTextContent('Default');
    expect(rows[0]).toHaveTextContent('v4');
    expect(rows[0]).toHaveTextContent('Ran 2h ago');
    expect(rows[1]).toHaveTextContent('Night and holiday acknowledgement');
    expect(rows[1]).toHaveTextContent('Shadow');
    expect(rows[1]).toHaveTextContent('Routed');
    expect(within(groups[1]).getByTestId('workflow-list-row')).toHaveTextContent('Failed 1h ago');
    expect(within(groups[2]).getByTestId('workflow-list-row')).toHaveTextContent('draft');
    expect(screen.getByRole('heading', { name: /Workflows\s*4/ })).toBeInTheDocument();
  });

  test('clicking a workflow opens it (its own page)', () => {
    const { onOpen } = renderList();
    fireEvent.click(screen.getByRole('button', { name: /Ticket assigned/ }));
    expect(onOpen).toHaveBeenCalledWith(3);
  });

  test('search and filters narrow the list', () => {
    renderList();
    fireEvent.change(screen.getByLabelText('Search workflows'), { target: { value: 'holiday' } });
    expect(screen.getAllByTestId('workflow-list-row')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    fireEvent.click(screen.getByRole('button', { name: 'Failing' }));
    expect(screen.getAllByTestId('workflow-list-row').map((r) => r.getAttribute('data-state'))).toEqual(['failing']);
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    expect(screen.getAllByTestId('workflow-list-row')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Shadow' }));
    expect(screen.getAllByTestId('workflow-list-row')[0]).toHaveTextContent('after-hours');
  });

  test('nothing matches → says so', () => {
    renderList();
    fireEvent.change(screen.getByLabelText('Search workflows'), { target: { value: 'zzz' } });
    expect(screen.getByText('No workflows match.')).toBeInTheDocument();
  });

  test('New workflow, per-trigger new, and the actions slot are there', () => {
    const onCreate = vi.fn();
    const onCreateForTrigger = vi.fn();
    render(<WorkflowListPage workflows={WORKFLOWS} onOpen={vi.fn()} onCreate={onCreate} onCreateForTrigger={onCreateForTrigger} eventLabels={LABELS} getVisuals={visuals} actions={<button type="button">Templates</button>} />);
    fireEvent.click(screen.getByRole('button', { name: 'New workflow' }));
    expect(onCreate).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'New workflow for Ticket assigned' }));
    expect(onCreateForTrigger).toHaveBeenCalledWith('ticket.assigned');
    expect(screen.getByRole('button', { name: 'Templates' })).toBeInTheDocument();
  });

  test('workflowKind names the kind, with after-hours when it is one', () => {
    expect(workflowKind({ isDefaultVariant: true })).toBe('Default');
    expect(workflowKind({ triggerType: 'manual' })).toBe('Sub-workflow');
    expect(workflowKind({ routingRule: {} }, { isAfterHours: () => true })).toBe('Routed · after-hours');
  });
});

// QA 10-01 #2: group headers must not look like a hovered/selected row.
describe('group headers (QA 10-01 #2)', () => {
  test('a title with a hairline rule on the page background — no grey band — and indented members', () => {
    renderList();
    const header = screen.getAllByTestId('workflow-list-group-header')[0];
    expect(header.className).toContain('bg-card');
    expect(header.className).not.toContain('bg-muted');
    expect(header.querySelector('span.h-px')).not.toBeNull();
    const row = screen.getAllByTestId('workflow-list-row')[0].querySelector('button');
    expect(row.className).toContain('pl-10');
  });
});
