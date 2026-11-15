/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

// MEGA 11-14 (A4): the field picker lists what the trigger fills, plus any
// field the rule already uses; the new reply fields get friendly pick-lists
// and "Time since the ticket closed" a number + unit editor.
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
  useWorkspaceOptional: () => ({ currentWorkspace: null }), // no server catalog: the static CG_FIELDS
}));

import ConditionGroupBuilder, { CG_FIELDS, durationUnitFor } from './ConditionGroupBuilder';
import { EVENT_FIELD_TRIGGERS, fieldFitsTrigger, fieldsForTrigger } from '../../utils/conditionFieldTriggers';

afterEach(cleanup);

const group = (...conditions) => ({ logic: 'all', conditions });
const fieldOptions = () => within(screen.getAllByRole('combobox', { name: 'Field' })[0]).getAllByRole('option').map((o) => o.textContent);

describe('fields that fit the trigger', () => {
  test('"Requester replied" lists the reply fields and not the fields-updated or intake ones', () => {
    render(<ConditionGroupBuilder value={group({ field: 'ticket.status', operator: 'is', value: 'Closed' })} onChange={() => {}} triggerType="ticket.reply_received" />);
    const labels = fieldOptions();
    expect(labels).toEqual(expect.arrayContaining(['Reply sent by', 'Reply reads as', 'Time since the ticket closed', 'Reopened by replies in the last 24 hours', 'Reply answers a workflow e-mail', 'Ticket status', 'Requester email']));
    expect(labels).not.toContain('Changed fields (fields_updated)');
    expect(labels).not.toContain('Intake decision');
    expect(labels).not.toContain('Note was written by the system');
  });

  test('"Ticket updated (fields)" lists changed fields and not the reply fields', () => {
    render(<ConditionGroupBuilder value={group({ field: 'ticket.status', operator: 'is', value: 'Open' })} onChange={() => {}} triggerType="ticket.fields_updated" />);
    const labels = fieldOptions();
    expect(labels).toContain('Changed fields (fields_updated)');
    expect(labels).toContain('Time since the ticket closed'); // ticket.* fits every trigger
    expect(labels).not.toContain('Reply sent by');
    expect(labels).not.toContain('Reply reads as');
  });

  test('a field the rule already uses stays, marked "not set by this trigger"', () => {
    render(<ConditionGroupBuilder value={group({ field: 'event.sentBy', operator: 'is', value: 'requester' })} onChange={() => {}} triggerType="ticket.created" />);
    expect(fieldOptions()).toContain('Reply sent by (not set by this trigger)');
    expect(screen.getByTestId('field-not-set-by-trigger')).toHaveTextContent('This field is not set by this trigger, so it has no value here.');
  });

  test('no trigger (or a manual sub-workflow) lists every field', () => {
    render(<ConditionGroupBuilder value={group({ field: 'ticket.status', operator: 'is', value: 'Open' })} onChange={() => {}} />);
    expect(fieldOptions()).toHaveLength(CG_FIELDS.length);
    expect(fieldsForTrigger(CG_FIELDS, 'manual')).toHaveLength(CG_FIELDS.length);
  });

  test('the map: only event.* fields are scoped; unknown ones show everywhere', () => {
    expect(fieldFitsTrigger('ticket.closedMinutes', 'ticket.created')).toBe(true);
    expect(fieldFitsTrigger('requester.email', 'schedule.time')).toBe(true);
    expect(fieldFitsTrigger('event.sentBy', 'ticket.reply_received')).toBe(true);
    expect(fieldFitsTrigger('event.sentBy', 'ticket.note_added')).toBe(false);
    expect(fieldFitsTrigger('event.systemNote', 'ticket.note_added')).toBe(true);
    expect(fieldFitsTrigger('event.somethingNew', 'ticket.created')).toBe(true);
    // Every event.* field in the static catalog is mapped.
    const unmapped = CG_FIELDS.map((f) => f.value).filter((key) => key.startsWith('event.') && !EVENT_FIELD_TRIGGERS[key]);
    expect(unmapped).toEqual([]);
  });
});

describe('the new reply fields', () => {
  test('"Reply sent by" is a pick-list in plain words, storing the codes', () => {
    const onChange = vi.fn();
    render(<ConditionGroupBuilder value={group({ field: 'event.sentBy', operator: 'is', value: 'cc' })} onChange={onChange} triggerType="ticket.reply_received" />);
    const value = screen.getByRole('combobox', { name: 'Value' });
    expect(within(value).getAllByRole('option').map((o) => o.textContent)).toEqual(['Requester', 'Someone Cc\'d', 'Someone a workflow e-mailed', 'Someone else']);
    expect(value).toHaveValue('cc');
    fireEvent.change(value, { target: { value: 'workflow_recipient' } });
    expect(onChange.mock.calls.at(-1)[0].conditions[0]).toEqual({ field: 'event.sentBy', operator: 'is', value: 'workflow_recipient' });
  });

  test('"Reply reads as" with "is any of" is a tick list of the six readings', () => {
    const onChange = vi.fn();
    render(<ConditionGroupBuilder value={group({ field: 'event.replyVerdict', operator: 'in', value: ['thanks', 'auto_reply'] })} onChange={onChange} triggerType="ticket.reply_received" />);
    const button = screen.getByRole('button', { name: 'Values: Thanks, Out-of-office' });
    fireEvent.click(button);
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.map((b) => b.closest('label').textContent)).toEqual(['Thanks', 'Out-of-office', 'Still not fixed', 'New request', 'Question', 'Other reply']);
    fireEvent.click(screen.getByRole('checkbox', { name: 'New request' }));
    expect(onChange.mock.calls.at(-1)[0].conditions[0].value).toEqual(['thanks', 'auto_reply', 'new_request']);
  });

  test('"Time since the ticket closed" reads in days and stores minutes', () => {
    const onChange = vi.fn();
    render(<ConditionGroupBuilder value={group({ field: 'ticket.closedMinutes', operator: 'gt', value: 20160 })} onChange={onChange} triggerType="ticket.reply_received" />);
    const amount = screen.getByRole('spinbutton', { name: 'Time since the ticket closed (days)' });
    expect(amount).toHaveValue(14);
    expect(screen.getByRole('combobox', { name: 'Time since the ticket closed unit' })).toHaveValue('days');
    fireEvent.change(amount, { target: { value: '7' } });
    expect(onChange.mock.calls.at(-1)[0].conditions[0]).toEqual({ field: 'ticket.closedMinutes', operator: 'gt', value: 10080 });
    fireEvent.change(screen.getByRole('combobox', { name: 'Time since the ticket closed unit' }), { target: { value: 'hours' } });
    expect(onChange.mock.calls.at(-1)[0].conditions[0].value).toBe(14 * 60);
  });

  test('"Ticket age" uses the same editor; the unit follows the value', () => {
    render(<ConditionGroupBuilder value={group({ field: 'ticket.ageMinutes', operator: 'gt', value: 90 })} onChange={() => {}} triggerType="ticket.created" />);
    expect(screen.getByRole('spinbutton', { name: 'Ticket age (minutes)' })).toHaveValue(90);
    expect(durationUnitFor(120)).toBe('hours');
    expect(durationUnitFor(2880)).toBe('days');
    expect(durationUnitFor(0)).toBe('minutes');
  });

  test('"Reopened by replies in the last 24 hours" is a number', () => {
    render(<ConditionGroupBuilder value={group({ field: 'event.replyReopens24h', operator: 'gte', value: 3 })} onChange={() => {}} triggerType="ticket.reply_received" />);
    expect(screen.getByRole('spinbutton', { name: 'Number' })).toHaveValue(3);
  });
});
