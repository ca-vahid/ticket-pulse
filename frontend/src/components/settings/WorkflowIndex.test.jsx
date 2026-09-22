/** @vitest-environment jsdom */
// eslint-disable-next-line no-unused-vars
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspace: { id: 1 } }),
}));

const { default: WorkflowIndex, workflowState, workflowMeta } = await import('./WorkflowIndex.jsx');

const GroupIcon = (props) => <svg data-testid="group-icon" {...props} />;

const WORKFLOWS = [
  {
    id: 1,
    name: 'Assignment notice',
    triggerType: 'ticket.assigned',
    isDefaultVariant: true,
    isEnabled: true,
    publishedVersion: 3,
    _count: { runs: 12 },
    runs: [{ status: 'completed', startedAt: new Date(Date.now() - 6 * 3600e3).toISOString() }],
  },
  {
    id: 2,
    name: 'VIP variant',
    triggerType: 'ticket.assigned',
    isDefaultVariant: false,
    isEnabled: false,
    publishedVersion: 0,
    routingRule: { field: 'x' },
    _count: { runs: 0 },
    runs: [],
  },
  {
    id: 3,
    name: 'After-hours arrival',
    triggerType: 'ticket.created',
    isDefaultVariant: true,
    isEnabled: true,
    mockModeEnabled: true,
    publishedVersion: 17,
    _count: { runs: 4 },
    runs: [{ status: 'completed', startedAt: new Date(Date.now() - 2 * 86400e3).toISOString() }],
  },
];

function renderIndex(overrides = {}) {
  const props = {
    workflows: WORKFLOWS,
    selectedId: 1,
    onSelect: vi.fn(),
    onToggleEnabled: vi.fn(),
    togglingId: null,
    onCreateForTrigger: vi.fn(),
    getDisplayName: (workflow) => workflow.name,
    getVisuals: () => ({ icon: GroupIcon }),
    eventLabels: { 'ticket.assigned': 'Ticket assigned', 'ticket.created': 'Ticket arrived', 'ticket.resolved_closed': 'Resolved or closed' },
    isAfterHours: (w) => w.id === 3,
    ...overrides,
  };
  render(<WorkflowIndex {...props} />);
  return props;
}

const rowFor = (name) => screen.getByText(name).closest('[data-testid="workflow-row"]');

describe('WorkflowIndex sidebar (L2, 22 Sep 2026)', () => {
  afterEach(() => { cleanup(); window.localStorage.clear(); });

  test('opens folded except the selected workflow’s group; Collapse all / Expand all flips every group', () => {
    renderIndex();
    expect(screen.getByRole('button', { name: /^Ticket assigned/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /^Ticket arrived/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('After-hours arrival')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.queryByText('Assignment notice')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getByText('After-hours arrival')).toBeInTheDocument();
    expect(screen.getByText('Assignment notice')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse all' })).toBeInTheDocument();
  });

  test('rows are one line each: a state dot, the name, one muted meta line — no pills', () => {
    renderIndex();
    fireEvent.click(screen.getByRole('button', { name: /^Ticket arrived/ }));
    const row = rowFor('Assignment notice');
    expect(row).toHaveAttribute('data-state', 'on');
    expect(within(row).getByText('Default · v3 · ran 6h ago')).toBeInTheDocument();
    expect(screen.queryByText('Observe-only')).toBeNull();
    expect(screen.queryByText('Routed')).toBeNull();
    // the same facts live in the meta line and the state, not in chips
    expect(rowFor('VIP variant')).toHaveAttribute('data-state', 'draft');
    expect(within(rowFor('VIP variant')).getByText('Routed · draft · no runs')).toBeInTheDocument();
    expect(rowFor('After-hours arrival')).toHaveAttribute('data-state', 'observe');
    expect(within(rowFor('After-hours arrival')).getByText('Default · After-hours · v17 · ran 2d ago')).toBeInTheDocument();
  });

  test('the selected row carries the inset primary bar and the name goes bold', () => {
    renderIndex();
    const row = rowFor('Assignment notice');
    expect(row.className).toContain('shadow-[inset_3px_0_0');
    expect(within(row).getByText('Assignment notice')).toHaveClass('font-semibold');
    expect(row.querySelector('[aria-current="true"]')).not.toBeNull();
    expect(rowFor('VIP variant').className).not.toContain('shadow-[inset_3px_0_0');
  });

  test('groups are collapsible with a plain count; the enable switch and row menu exist per row', () => {
    window.localStorage.removeItem('tp_wf_collapsed_1');
    const props = renderIndex({ onRowAction: vi.fn() });
    const group = screen.getByRole('button', { name: /^Ticket assigned/ });
    expect(group).toHaveAttribute('aria-expanded', 'true');
    expect(within(group).getByLabelText('2 workflows')).toHaveTextContent('2');
    fireEvent.click(group);
    expect(group).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Assignment notice')).toBeNull();
    fireEvent.click(group);
    // switch
    fireEvent.click(screen.getByRole('switch', { name: 'Disable Assignment notice' }));
    expect(props.onToggleEnabled).toHaveBeenCalledWith(WORKFLOWS[0]);
    expect(screen.getByRole('switch', { name: 'Enable VIP variant' })).toBeDisabled(); // draft
    // row menu
    fireEvent.click(screen.getByRole('button', { name: 'More actions for VIP variant' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    expect(props.onRowAction).toHaveBeenCalledWith(WORKFLOWS[1], 'archive');
  });

  test('filters are text: Enabled narrows, Failing shows a count only when something fails, Archived is a toggle', () => {
    const props = renderIndex({ onShowArchivedChange: vi.fn(), archivedCount: 4 });
    expect(screen.getByRole('button', { name: 'Failing' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enabled' }));
    expect(screen.queryByText('VIP variant')).toBeNull();
    expect(screen.getByText('Assignment notice')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Archived 4' }));
    expect(props.onShowArchivedChange).toHaveBeenCalledWith(true);
  });

  test('icon-collapse mode folds the panel to a rail of trigger icons with counts', () => {
    const props = renderIndex({ collapsed: true, onToggleCollapsed: vi.fn(), footer: <span>health</span> });
    expect(screen.getByTestId('workflow-sidebar-rail')).toBeInTheDocument();
    expect(screen.queryByText('Assignment notice')).toBeNull();
    expect(screen.getByRole('button', { name: 'Ticket assigned, 2 workflows' })).toBeInTheDocument();
    expect(screen.getByText('health')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Expand workflows/ }));
    expect(props.onToggleCollapsed).toHaveBeenCalled();
  });

  test('groups follow the ticket lifecycle: arrived before assigned, closed near the end, unknown types last', () => {
    renderIndex({ workflows: [...WORKFLOWS, { id: 9, name: 'Closing note', triggerType: 'ticket.resolved_closed', isDefaultVariant: true, isEnabled: false, publishedVersion: 1, runs: [] }, { id: 10, name: 'Mystery', triggerType: 'zzz.custom', isDefaultVariant: true, isEnabled: false, publishedVersion: 1, runs: [] }] });
    const groups = screen.getAllByRole('button', { name: /workflows$/ }).map((b) => b.querySelector('span.truncate').textContent);
    expect(groups).toEqual(['Ticket arrived', 'Ticket assigned', 'Resolved or closed', 'zzz.custom']);
  });

  test('workflowState / workflowMeta read the same facts the old chips did', () => {
    expect(workflowState({ archivedAt: '2026-09-01' }).key).toBe('archived');
    expect(workflowState({ isEnabled: true, runs: [{ status: 'failed' }] }).key).toBe('failing');
    expect(workflowState({ isEnabled: true, mockModeEnabled: true }).key).toBe('observe');
    expect(workflowState({ isEnabled: false, publishedVersion: 2 }).key).toBe('off');
    expect(workflowMeta({ isDefaultVariant: false, triggerType: 'manual', publishedVersion: 2, runs: [] })).toBe('Sub-workflow · v2 · no runs');
  });
});
