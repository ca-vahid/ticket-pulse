/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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

import ConditionGroupBuilder, { CG_FIELDS, emptyGroup, invalidateConditionFieldsCache, withOperator } from './ConditionGroupBuilder';
import { ticketsAPI } from '../../services/api';

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
    fireEvent.click(screen.getByText(/add a condition/i));
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

  // 14 Oct 2026: no hidden raw rule behind the builder any more.
  test('there is no "use raw rule" escape hatch', () => {
    render(<ConditionGroupBuilder value={emptyGroup()} onChange={() => {}} />);
    expect(screen.queryByText(/raw rule/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/advanced rule/i)).not.toBeInTheDocument();
  });

  test('"is any of" on a field with values is a tick list; the pick reads as plain text', async () => {
    invalidateConditionFieldsCache();
    const onChange = vi.fn();
    const group = { logic: 'all', conditions: [{ field: 'ticket.status', operator: 'in', value: ['Resolved', 'Closed'] }] };
    render(<ConditionGroupBuilder value={group} onChange={onChange} />);
    const button = await screen.findByRole('button', { name: 'Values: Resolved, Closed' });
    expect(screen.queryByLabelText('Values (comma-separated)')).not.toBeInTheDocument();
    fireEvent.click(button);
    // The custom status arrives with the server catalog.
    await screen.findByRole('checkbox', { name: 'Needs Rework' });
    expect(screen.getByRole('checkbox', { name: 'Resolved' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Open' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Needs Rework' }));
    expect(onChange).toHaveBeenLastCalledWith({ logic: 'all', conditions: [{ field: 'ticket.status', operator: 'in', value: ['Resolved', 'Closed', 'Needs Rework'] }] });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Resolved' }));
    expect(onChange.mock.calls.at(-1)[0].conditions[0].value).toEqual(['Closed']);
  });

  test('a picked value the workspace no longer offers stays listed and ticked', async () => {
    invalidateConditionFieldsCache();
    const group = { logic: 'all', conditions: [{ field: 'ticket.status', operator: 'not_in', value: ['Pending Response'] }] };
    render(<ConditionGroupBuilder value={group} onChange={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Values: Pending Response' }));
    expect(screen.getByRole('checkbox', { name: /Pending Response/ })).toBeChecked();
    expect(screen.getByText('not offered here now')).toBeInTheDocument();
  });

  test('switching between "is" and "is any of" keeps the value in the right shape', () => {
    expect(withOperator({ field: 'ticket.status', operator: 'is', value: 'Open' }, 'in')).toEqual({ field: 'ticket.status', operator: 'in', value: ['Open'] });
    expect(withOperator({ field: 'ticket.status', operator: 'in', value: ['Closed', 'Open'] }, 'is')).toEqual({ field: 'ticket.status', operator: 'is', value: 'Closed' });
    expect(withOperator({ field: 'ticket.status', operator: 'in', value: [] }, 'is', { type: 'enum', options: ['Open'] }).value).toBe('Open');
    expect(withOperator({ field: 'ticket.status', operator: 'in', value: ['x'] }, 'is_empty').value).toBeUndefined();
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

  // FR 08-05 Phase 1b: custom fields arrive TYPED from the server catalog —
  // number/date/boolean fields get their operators and matching inputs.
  describe('typed custom-field conditions', () => {
    const TYPED_CATALOG = {
      data: [
        { value: 'ticket.status', label: 'Ticket status', type: 'enum', options: ['Open', 'Pending', 'Resolved', 'Closed'] },
        { value: 'custom:budget', label: 'Custom: Budget', type: 'number' },
        { value: 'custom:kickoff_date', label: 'Custom: Kickoff Date', type: 'date' },
        { value: 'custom:is_billable', label: 'Custom: Is Billable', type: 'boolean' },
        { value: 'custom:tier', label: 'Custom: Tier', type: 'enum', options: ['Gold', 'Silver'] },
      ],
    };

    test('number fields render numeric operators and a number input', async () => {
      invalidateConditionFieldsCache();
      conditionFieldsMock.mockResolvedValueOnce(TYPED_CATALOG);
      const group = { logic: 'all', conditions: [{ field: 'custom:budget', operator: 'gt', value: 1000 }] };
      render(<ConditionGroupBuilder value={group} onChange={() => {}} onClear={() => {}} />);

      expect(await screen.findByRole('option', { name: 'Custom: Budget' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'more than' })).toBeInTheDocument();
      const input = screen.getByLabelText('Number');
      expect(input).toHaveAttribute('type', 'number');
      expect(input).toHaveValue(1000);
    });

    test('date fields render before/after operators and a date input', async () => {
      invalidateConditionFieldsCache();
      conditionFieldsMock.mockResolvedValueOnce(TYPED_CATALOG);
      const group = { logic: 'all', conditions: [{ field: 'custom:kickoff_date', operator: 'before', value: '2026-09-01' }] };
      render(<ConditionGroupBuilder value={group} onChange={() => {}} onClear={() => {}} />);

      expect(await screen.findByRole('option', { name: 'is before' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'is after' })).toBeInTheDocument();
      const input = screen.getByLabelText('Date');
      expect(input).toHaveAttribute('type', 'date');
      expect(input).toHaveValue('2026-09-01');
    });

    test('boolean fields offer valueless is true / is false; select defs render enum options', async () => {
      invalidateConditionFieldsCache();
      conditionFieldsMock.mockResolvedValueOnce(TYPED_CATALOG);
      const group = {
        logic: 'all',
        conditions: [
          { field: 'custom:is_billable', operator: 'is_true' },
          { field: 'custom:tier', operator: 'is', value: 'Gold' },
        ],
      };
      render(<ConditionGroupBuilder value={group} onChange={() => {}} onClear={() => {}} />);

      expect(await screen.findByRole('option', { name: 'is true' })).toBeInTheDocument();
      expect(screen.getByText('—')).toBeInTheDocument(); // valueless boolean row
      expect(screen.getByRole('option', { name: 'Gold' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Silver' })).toBeInTheDocument();
    });

    test('a custom field unknown to the catalog stays a string field (fallback)', async () => {
      invalidateConditionFieldsCache();
      conditionFieldsMock.mockResolvedValueOnce(TYPED_CATALOG);
      const group = { logic: 'all', conditions: [{ field: 'custom:mystery', operator: 'is', value: 'x' }] };
      render(<ConditionGroupBuilder value={group} onChange={() => {}} onClear={() => {}} />);

      expect(await screen.findByRole('option', { name: 'contains' })).toBeInTheDocument();
      expect(screen.getByDisplayValue('x')).toBeInTheDocument();
    });
  });
});

// MEGA 09-01 Phase TU (TU-7): the fields_updated condition fields mirror the
// backend catalog (KEEP IN SYNC with notificationConditionModel.js).
describe('fields_updated condition fields (TU-7)', () => {
  test('static catalog carries changedFields (list), actorKind (enum), source, changedCount, reopened', () => {
    const byValue = Object.fromEntries(CG_FIELDS.map((f) => [f.value, f]));
    expect(byValue['event.changedFields']).toEqual(expect.objectContaining({ type: 'list' }));
    expect(byValue['event.changedFields'].options).toEqual(expect.arrayContaining(['priority', 'dueBy', 'ccEmails', 'internalCategoryId']));
    expect(byValue['event.actorKind']).toEqual(expect.objectContaining({ type: 'enum', options: ['human', 'api', 'system', 'workflow', 'freshservice'] }));
    expect(byValue['event.source'].type).toBe('string');
    expect(byValue['event.changedCount'].type).toBe('number');
    expect(byValue['event.reopened'].type).toBe('boolean');
  });

  test('a changedFields row renders the list operators and a tick list of the known fields', async () => {
    invalidateConditionFieldsCache();
    conditionFieldsMock.mockResolvedValueOnce({ data: [] }); // fall back to the static catalog
    const group = { logic: 'all', conditions: [{ field: 'event.changedFields', operator: 'has_any', value: ['priority'] }] };
    render(<ConditionGroupBuilder value={group} onChange={vi.fn()} onClear={() => {}} />);
    expect(await screen.findByRole('option', { name: 'has any of' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'has none of' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Values: priority' })).toBeInTheDocument();
  });

  test('a list field without known values (tags, offline) keeps the comma input', async () => {
    invalidateConditionFieldsCache();
    conditionFieldsMock.mockResolvedValueOnce({ data: [] });
    const group = { logic: 'all', conditions: [{ field: 'ticket.tags', operator: 'has_any', value: ['vip', 'exec'] }] };
    render(<ConditionGroupBuilder value={group} onChange={vi.fn()} />);
    expect(await screen.findByLabelText('Values (comma-separated)')).toHaveValue('vip, exec');
  });
});


// QA 10-06 #7: a custom field added in Ticket Ops never reached an open
// workflow editor — the list was fetched once per browser session.
describe('ConditionGroupBuilder — custom fields stay current', () => {
  test('a saved custom field appears without a reload', async () => {
    invalidateConditionFieldsCache();
    ticketsAPI.customFieldDefinitions.mockResolvedValue({ data: [{ key: 'client_name', label: 'Client Name', type: 'text' }] });
    render(<ConditionGroupBuilder value={emptyGroup()} onChange={() => {}} onClear={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole('option', { name: 'Custom: Client Name' }).length).toBeGreaterThan(0));
    expect(screen.queryByRole('option', { name: 'Custom: BST Number' })).not.toBeInTheDocument();

    ticketsAPI.customFieldDefinitions.mockResolvedValue({ data: [
      { key: 'client_name', label: 'Client Name', type: 'text' },
      { key: 'bst_number', label: 'BST Number', type: 'text' },
    ] });
    act(() => { window.dispatchEvent(new CustomEvent('tp:condition-fields-changed')); });
    await waitFor(() => expect(screen.getAllByRole('option', { name: 'Custom: BST Number' }).length).toBeGreaterThan(0));
  });
});
