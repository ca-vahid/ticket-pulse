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

// QA 11-18 #1: "Allow custom emails to be added as BCC recipients or CC recipients."
describe('RecipientsNodeEditor — custom emails per section', () => {
  test('Cc and Bcc each have their own box inside their section; To shows its box only when ticked', () => {
    render(<RecipientsNodeEditor data={{ to: ['requester'] }} onChange={vi.fn()} />);
    expect(screen.queryByTestId('recipients-custom-emails-to')).toBeNull();
    expect(within(screen.getByTestId('recipients-custom-emails-cc')).getByRole('textbox', { name: 'Cc custom email recipients' })).toBeInTheDocument();
    expect(within(screen.getByTestId('recipients-custom-emails-bcc')).getByRole('textbox', { name: 'Bcc custom email recipients' })).toBeInTheDocument();
  });

  test('typing into Cc saves ccCustomEmails', () => {
    const onChange = vi.fn();
    render(<RecipientsNodeEditor data={{ to: ['requester'] }} onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Cc custom email recipients' });
    fireEvent.change(input, { target: { value: 'Priya.Nair@example.com' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith({ ccCustomEmails: ['priya.nair@example.com'] });
  });

  test('pasting into Bcc saves bccCustomEmails, split on commas, semicolons and spaces', () => {
    const onChange = vi.fn();
    render(<RecipientsNodeEditor data={{ to: ['requester'], bccCustomEmails: ['audit@example.com'] }} onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Bcc custom email recipients' });
    fireEvent.paste(input, { clipboardData: { getData: () => 'sam.okafor@example.com; eli.park@example.com dana.fox@example.com' } });
    expect(onChange).toHaveBeenCalledWith({
      bccCustomEmails: ['audit@example.com', 'sam.okafor@example.com', 'eli.park@example.com', 'dana.fox@example.com'],
    });
  });

  test('old data (customEmails + the Custom emails tick) renders in the To section and still saves customEmails', () => {
    const onChange = vi.fn();
    render(<RecipientsNodeEditor data={{ to: ['requester', 'custom_emails'], customEmails: ['ops@example.com'] }} onChange={onChange} />);
    const toBox = screen.getByTestId('recipients-custom-emails-to');
    expect(within(toBox).getByText('ops@example.com')).toBeInTheDocument();
    expect(within(screen.getByTestId('recipients-custom-emails-cc')).queryByText('ops@example.com')).toBeNull();
    const input = within(toBox).getByRole('textbox', { name: 'Custom email recipients' });
    fireEvent.change(input, { target: { value: 'lead@example.com' } });
    fireEvent.keyDown(input, { key: ',' });
    expect(onChange).toHaveBeenCalledWith({ customEmails: ['ops@example.com', 'lead@example.com'] });
  });

  test('review fix: a running total of custom addresses across To (when ticked), Cc and Bcc', () => {
    const { unmount } = render(<RecipientsNodeEditor
      data={{ to: ['requester', 'custom_emails'], customEmails: ['ops@example.com'], ccCustomEmails: ['lead@example.com', 'OPS@example.com'], bccCustomEmails: ['audit@example.com'] }}
      onChange={vi.fn()}
    />);
    expect(screen.getByTestId('recipients-custom-emails-total')).toHaveTextContent('3 of 25 custom addresses');
    unmount();
    // The To list does not count while its box is unticked (it is not sent).
    render(<RecipientsNodeEditor data={{ to: ['requester'], customEmails: ['ops@example.com'], ccCustomEmails: ['lead@example.com'] }} onChange={vi.fn()} />);
    expect(screen.getByTestId('recipients-custom-emails-total')).toHaveTextContent('1 of 25 custom addresses');
  });

  test('review fix: with the budget used up the boxes take no more, and an over-budget list says what to remove', () => {
    const list = (n, p) => Array.from({ length: n }, (_, i) => `${p}${i}@example.com`);
    const onChange = vi.fn();
    const { unmount } = render(<RecipientsNodeEditor data={{ to: ['requester'], ccCustomEmails: list(20, 'c'), bccCustomEmails: list(4, 'b') }} onChange={onChange} />);
    const bcc = screen.getByRole('textbox', { name: 'Bcc custom email recipients' });
    fireEvent.paste(bcc, { clipboardData: { getData: () => 'x1@example.com x2@example.com' } });
    expect(onChange).toHaveBeenCalledWith({ bccCustomEmails: [...list(4, 'b'), 'x1@example.com'] });
    unmount();
    render(<RecipientsNodeEditor data={{ to: ['requester'], ccCustomEmails: list(20, 'c'), bccCustomEmails: list(7, 'b') }} onChange={vi.fn()} />);
    expect(screen.getByTestId('recipients-custom-emails-total')).toHaveTextContent('27 of 25 custom addresses — remove 2 before saving');
  });

  test('review fix: "Dana Fox <dana@example.com>" pasted into Cc saves the bare address', () => {
    const onChange = vi.fn();
    render(<RecipientsNodeEditor data={{ to: ['requester'] }} onChange={onChange} />);
    fireEvent.paste(screen.getByRole('textbox', { name: 'Cc custom email recipients' }), { clipboardData: { getData: () => 'Dana Fox <Dana.Fox@example.com>' } });
    expect(onChange).toHaveBeenCalledWith({ ccCustomEmails: ['dana.fox@example.com'] });
  });

  test('saved Cc/Bcc addresses render in their own sections', () => {
    render(<RecipientsNodeEditor data={{ to: ['requester'], ccCustomEmails: ['lead@example.com'], bccCustomEmails: ['audit@example.com'] }} onChange={vi.fn()} />);
    expect(within(screen.getByTestId('recipients-custom-emails-cc')).getByText('lead@example.com')).toBeInTheDocument();
    expect(within(screen.getByTestId('recipients-custom-emails-bcc')).getByText('audit@example.com')).toBeInTheDocument();
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
