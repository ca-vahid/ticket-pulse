/** @vitest-environment jsdom */
// eslint-disable-next-line no-unused-vars
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('@monaco-editor/react', () => ({
  default: () => <div data-testid="monaco-editor" />,
}));

vi.mock('@xyflow/react', () => ({
  Background: () => null,
  Controls: () => null,
  ReactFlow: ({ children }) => <div data-testid="react-flow">{children}</div>,
}));

vi.mock('@tiptap/react', () => ({
  EditorContent: () => null,
  useEditor: () => null,
}));

vi.mock('@tiptap/starter-kit', () => ({
  default: {},
}));

vi.mock('react-resizable-panels', () => ({
  Group: ({ children }) => <div>{children}</div>,
  Panel: ({ children }) => <div>{children}</div>,
  Separator: () => <div />,
  useDefaultLayout: () => ({
    defaultLayout: undefined,
    onLayoutChanged: vi.fn(),
  }),
}));

vi.mock('../../services/api', () => ({
  notificationWorkflowAPI: {},
  ticketsAPI: {},
}));

const { RecipientsNodeEditor, WebhookNodeEditor } = await import('./NotificationWorkflowsPanel.jsx');

afterEach(() => cleanup());

const DEFS = [
  { key: 'to_recipients', label: 'To recipients', type: 'text' },
  { key: 'cc_recipients', label: 'CC recipients', type: 'text' },
  { key: 'bcc_recipients', label: 'BCC recipients', type: 'text' },
];

// QA 10-01 #7: "Add to_recipients, cc_recipients, bcc_recipients or any future
// custom fields as selection options in workflows."
describe('RecipientsNodeEditor — From custom fields', () => {
  test('every custom field is offered under To, Cc and Bcc', () => {
    render(<RecipientsNodeEditor data={{ to: ['requester'] }} onChange={vi.fn()} customFieldDefs={DEFS} />);
    for (const key of ['to', 'cc', 'bcc']) {
      const box = screen.getByTestId(`recipients-custom-fields-${key}`);
      expect(within(box).getAllByRole('checkbox')).toHaveLength(3);
    }
  });

  test('ticking a field adds a custom_field token to that list only', () => {
    const onChange = vi.fn();
    render(<RecipientsNodeEditor data={{ to: ['requester'], cc: [] }} onChange={onChange} customFieldDefs={DEFS} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Cc Recipients: custom field CC recipients' }));
    expect(onChange).toHaveBeenCalledWith({ cc: ['custom_field:cc_recipients'] });
  });

  test('a token for a field that was deleted stays visible and can be removed', () => {
    const onChange = vi.fn();
    render(<RecipientsNodeEditor data={{ to: ['custom_field:old_list'] }} onChange={onChange} customFieldDefs={DEFS} />);
    const box = screen.getByTestId('recipients-custom-fields-to');
    expect(within(box).getByText('old_list (field no longer defined)')).toBeInTheDocument();
    fireEvent.click(within(box).getAllByRole('checkbox')[3]);
    expect(onChange).toHaveBeenCalledWith({ to: [] });
  });

  test('no custom fields defined: the section is not shown', () => {
    render(<RecipientsNodeEditor data={{}} onChange={vi.fn()} customFieldDefs={[]} />);
    expect(screen.queryByTestId('recipients-custom-fields-to')).toBeNull();
  });
});

// QA 10-01 #10: "In the Call webhook step, surface the variables list."
describe('WebhookNodeEditor — variables', () => {
  const VARS = [
    { path: 'ticket.subject', token: '{{ ticket.subject }}', label: 'Subject', group: 'Ticket' },
    { path: 'ticket.url', token: '{{ ticket.url }}', label: 'Ticket link (agents)', group: 'Ticket' },
  ];

  test('the variables list sits under the body and a click inserts at the end of an untouched body', () => {
    const onChange = vi.fn();
    render(<WebhookNodeEditor data={{ bodyTemplate: '{"link": ' }} onChange={onChange} variables={VARS} />);
    const panel = screen.getByTestId('webhook-variables');
    fireEvent.click(within(panel).getByText('Ticket link (agents)'));
    expect(onChange).toHaveBeenCalledWith({ bodyTemplate: '{"link": {{ ticket.url }}' });
  });

  test('search narrows the list', () => {
    render(<WebhookNodeEditor data={{}} onChange={vi.fn()} variables={VARS} />);
    fireEvent.change(screen.getByPlaceholderText('Search variables'), { target: { value: 'link' } });
    const panel = screen.getByTestId('webhook-variables');
    expect(within(panel).queryByText('Subject')).toBeNull();
    expect(within(panel).getByText('Ticket link (agents)')).toBeInTheDocument();
  });
});

describe('WebhookNodeEditor — insert at the cursor once placed', () => {
  test('after clicking into the body, the variable goes where the cursor is', () => {
    const onChange = vi.fn();
    render(<WebhookNodeEditor data={{ bodyTemplate: '{"a": , "b": 1}' }} onChange={onChange} variables={[{ path: 'ticket.id', token: '{{ ticket.id }}', label: 'Internal ticket id', group: 'Ticket' }]} />);
    const body = screen.getByRole('textbox', { name: /Body template/ });
    fireEvent.focus(body);
    body.setSelectionRange(6, 6);
    fireEvent.click(screen.getByText('Internal ticket id'));
    expect(onChange).toHaveBeenCalledWith({ bodyTemplate: '{"a": {{ ticket.id }}, "b": 1}' });
  });
});

// QA 10-05 #3: the custom-field list is collapsed until something is picked.
describe('RecipientsNodeEditor — custom fields collapse', () => {
  const defs = [{ key: 'approver_email', label: 'Approver e-mail' }, { key: 'site_contact', label: 'Site contact' }];
  test('closed with a count when nothing is picked; open with "1 selected" when one is', () => {
    const { unmount } = render(<RecipientsNodeEditor data={{ to: ['requester'] }} onChange={() => {}} customFieldDefs={defs} />);
    const closed = screen.getByTestId('recipients-custom-fields-to');
    expect(closed.tagName).toBe('DETAILS');
    expect(closed).not.toHaveAttribute('open');
    expect(closed).toHaveTextContent('2 available');
    unmount();
    render(<RecipientsNodeEditor data={{ to: ['requester', 'custom_field:approver_email'] }} onChange={() => {}} customFieldDefs={defs} />);
    const open = screen.getByTestId('recipients-custom-fields-to');
    expect(open).toHaveAttribute('open');
    expect(open).toHaveTextContent('1 selected');
  });
});
