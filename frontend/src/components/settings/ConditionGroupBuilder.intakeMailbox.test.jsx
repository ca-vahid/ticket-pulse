/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/**
 * QA 11-24 item 11: "Intake mailbox" — which connected mailbox the ticket came
 * in through. A pick-list of the workspace's mailbox connections, never a
 * typed value. Accounting: "Intake mailbox is not ar@…" skips AR's e-mails.
 */
vi.mock('../../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ types: [], activeTypes: [], defaultType: null, typeByName: () => null, loading: false, refresh: () => {} }),
  invalidateTicketTypesCache: () => {},
}));
vi.mock('../../services/api', () => ({
  ticketsAPI: { customFieldDefinitions: vi.fn().mockResolvedValue({ data: [] }) },
  notificationWorkflowAPI: { conditionFields: vi.fn().mockResolvedValue({ data: [] }) },
}));
vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspace: { id: 2 } }),
  useWorkspaceOptional: () => ({ currentWorkspace: { id: 2 } }),
}));

import ConditionGroupBuilder, { CG_FIELDS } from './ConditionGroupBuilder';
import { RULE_FIELDS } from '../../utils/conditionRuleShared';

afterEach(cleanup);

const MAILBOXES = [
  { value: 'ap@example.com', label: 'Accounts Payable (ap@example.com)' },
  { value: 'ar@example.com', label: 'Accounts Receivable (ar@example.com)' },
];
const fieldsWith = (options) => [
  { value: 'ticket.status', label: 'Ticket status', type: 'enum', options: ['Open', 'Closed'] },
  { value: 'ticket.intakeMailbox', label: 'Intake mailbox', type: 'enum', options },
];

describe('Intake mailbox condition field', () => {
  test('is in the offline catalogue and the shared rule fields', () => {
    expect(CG_FIELDS.find((f) => f.value === 'ticket.intakeMailbox')).toMatchObject({ label: 'Intake mailbox', type: 'enum' });
    expect(RULE_FIELDS['ticket.intakeMailbox']).toMatchObject({ path: 'ticket.intakeMailbox', type: 'enum' });
  });

  test('picking the field offers is / is not and the mailboxes by name; no text box', () => {
    const onChange = vi.fn();
    const group = { logic: 'all', conditions: [{ field: 'ticket.intakeMailbox', operator: 'is_not', value: 'ar@example.com' }] };
    render(<ConditionGroupBuilder value={group} onChange={onChange} fields={fieldsWith(MAILBOXES)} />);

    const operator = screen.getByRole('combobox', { name: 'Operator' });
    const operatorWords = within(operator).getAllByRole('option').map((o) => o.textContent);
    expect(operatorWords).toEqual(expect.arrayContaining(['is', 'is not']));

    const value = screen.getByRole('combobox', { name: 'Value' });
    expect(within(value).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Accounts Payable (ap@example.com)', 'Accounts Receivable (ar@example.com)',
    ]);
    expect(value).toHaveValue('ar@example.com');
    expect(screen.queryByRole('textbox')).toBeNull();

    fireEvent.change(value, { target: { value: 'ap@example.com' } });
    expect(onChange).toHaveBeenLastCalledWith({
      logic: 'all', conditions: [{ field: 'ticket.intakeMailbox', operator: 'is_not', value: 'ap@example.com' }],
    });
  });

  test('choosing the field in a row starts on the first mailbox', () => {
    const onChange = vi.fn();
    const group = { logic: 'all', conditions: [{ field: 'ticket.status', operator: 'is', value: 'Open' }] };
    render(<ConditionGroupBuilder value={group} onChange={onChange} fields={fieldsWith(MAILBOXES)} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Field' }), { target: { value: 'ticket.intakeMailbox' } });
    expect(onChange).toHaveBeenLastCalledWith({
      logic: 'all', conditions: [{ field: 'ticket.intakeMailbox', operator: 'is', value: 'ap@example.com' }],
    });
  });

  test('a workspace with no mailbox says so instead of offering a text box', () => {
    const group = { logic: 'all', conditions: [{ field: 'ticket.intakeMailbox', operator: 'is', value: undefined }] };
    render(<ConditionGroupBuilder value={group} onChange={() => {}} fields={fieldsWith([])} />);
    const value = screen.getByRole('combobox', { name: 'Value' });
    expect(value).toBeDisabled();
    expect(value).toHaveTextContent('No mailbox is connected in this workspace');
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
