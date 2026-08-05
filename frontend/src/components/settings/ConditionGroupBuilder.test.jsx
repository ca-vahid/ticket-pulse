/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// The builder reads the workspace ticket-type registry for the ticket.ticketType
// enum options — stub it (no WorkspaceProvider in this unit test).
vi.mock('../../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ types: [], activeTypes: [], defaultType: null, typeByName: () => null, loading: false, refresh: () => {} }),
  invalidateTicketTypesCache: () => {},
}));

// Server-resolved condition-field catalog (Phase 8c): ticket.status options
// come from the workspace status registry via the API; the mock serves a
// registry with a custom status so the tests can prove the builder renders
// whatever the API serves.
const conditionFieldsMock = vi.fn();
vi.mock('../../services/api', () => ({
  ticketsAPI: { customFieldDefinitions: vi.fn().mockResolvedValue({ data: [] }) },
  notificationWorkflowAPI: { conditionFields: (...args) => conditionFieldsMock(...args) },
}));
vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspace: { id: 1 } }),
  useWorkspaceOptional: () => ({ currentWorkspace: { id: 1 } }),
}));

import ConditionGroupBuilder, { emptyGroup, invalidateConditionFieldsCache } from './ConditionGroupBuilder';

conditionFieldsMock.mockResolvedValue({
  data: [
    { value: 'ticket.status', label: 'Ticket status', type: 'enum', options: ['Open', 'Pending', 'Resolved', 'Closed', 'Needs Rework'] },
    { value: 'ticket.statusBase', label: 'Ticket status base (Open/Pending/Resolved/Closed)', type: 'enum', options: ['Open', 'Pending', 'Resolved', 'Closed'] },
    { value: 'ticket.priorityLabel', label: 'Priority', type: 'enum', options: ['Low', 'Medium', 'High', 'Urgent'] },
    { value: 'ticket.subject', label: 'Subject', type: 'string' },
    { value: 'assignedAgent.email', label: 'Assigned agent email', type: 'string' },
  ],
});

afterEach(cleanup);

describe('ConditionGroupBuilder', () => {
  test('starts as an offer button and creates a default group when clicked', () => {
    const onChange = vi.fn();
    render(<ConditionGroupBuilder value={null} onChange={onChange} onClear={() => {}} />);
    fireEvent.click(screen.getByText(/build conditions visually/i));
    expect(onChange).toHaveBeenCalledWith(emptyGroup());
  });

  test('renders rows, toggles ALL/ANY, and adds conditions and one-level groups', () => {
    const group = {
      logic: 'all',
      conditions: [{ field: 'ticket.priorityLabel', operator: 'is', value: 'Urgent' }],
    };
    const onChange = vi.fn();
    render(<ConditionGroupBuilder value={group} onChange={onChange} onClear={() => {}} />);

    // ANY toggle
    fireEvent.click(screen.getByRole('radio', { name: 'ANY' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ logic: 'any' }));

    // Add condition
    fireEvent.click(screen.getByRole('button', { name: /^Condition$/i }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      conditions: expect.arrayContaining([expect.objectContaining({ field: 'ticket.status' })]),
    }));

    // Add nested group (root only)
    fireEvent.click(screen.getByRole('button', { name: /^Group$/i }));
    const lastCall = onChange.mock.calls.at(-1)[0];
    expect(lastCall.conditions.at(-1)).toEqual(expect.objectContaining({ logic: 'any', conditions: expect.any(Array) }));
  });

  test('nested groups do not offer a further "Group" button (one-level cap)', () => {
    const group = {
      logic: 'any',
      conditions: [
        { logic: 'all', conditions: [{ field: 'ticket.status', operator: 'is', value: 'Open' }] },
      ],
    };
    render(<ConditionGroupBuilder value={group} onChange={() => {}} onClear={() => {}} />);
    // One "Group" button (root) only — the nested group offers just "Condition".
    expect(screen.getAllByRole('button', { name: /^Group$/i })).toHaveLength(1);
  });

  test('valueless operators hide the value input; enum fields render a select', () => {
    const group = {
      logic: 'all',
      conditions: [
        { field: 'assignedAgent.email', operator: 'is_empty' },
        { field: 'ticket.status', operator: 'is', value: 'Open' },
      ],
    };
    render(<ConditionGroupBuilder value={group} onChange={() => {}} onClear={() => {}} />);
    // Row 1: no value input (dash placeholder); row 2: enum select with Open.
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Open')).toBeInTheDocument();
  });

  test('clear hands control back to the raw rule', () => {
    const onClear = vi.fn();
    render(<ConditionGroupBuilder value={emptyGroup()} onChange={() => {}} onClear={onClear} />);
    fireEvent.click(screen.getByText(/remove & use raw rule/i));
    expect(onClear).toHaveBeenCalled();
  });

  test('ticket.status options come from the workspace registry served by the API (Phase 8c)', async () => {
    invalidateConditionFieldsCache();
    const group = {
      logic: 'all',
      conditions: [{ field: 'ticket.status', operator: 'is', value: 'Open' }],
    };
    render(<ConditionGroupBuilder value={group} onChange={() => {}} onClear={() => {}} />);

    // Once the server catalog lands, the custom status is a pickable option…
    expect(await screen.findByRole('option', { name: 'Needs Rework' })).toBeInTheDocument();
    // …and the derived statusBase field is offered in the field select.
    expect(screen.getByRole('option', { name: 'Ticket status base (Open/Pending/Resolved/Closed)' })).toBeInTheDocument();
    expect(conditionFieldsMock).toHaveBeenCalled();
  });

  test('API failure keeps the static canonical catalog usable (offline fallback)', async () => {
    invalidateConditionFieldsCache();
    conditionFieldsMock.mockRejectedValueOnce(new Error('down'));
    const group = {
      logic: 'all',
      conditions: [{ field: 'ticket.status', operator: 'is', value: 'Open' }],
    };
    render(<ConditionGroupBuilder value={group} onChange={() => {}} onClear={() => {}} />);

    expect(await screen.findByDisplayValue('Open')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Closed' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Needs Rework' })).not.toBeInTheDocument();
  });
});
