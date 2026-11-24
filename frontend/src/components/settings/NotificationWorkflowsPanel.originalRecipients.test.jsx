/** @vitest-environment jsdom */
// eslint-disable-next-line no-unused-vars
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// 24 Nov 2026: the `original_ccs` recipient is now "Everyone on the original
// e-mail" (To + Cc, less our mailboxes, our agents, the requester and automated addresses).

vi.mock('@monaco-editor/react', () => ({ default: () => <div data-testid="monaco-editor" /> }));
vi.mock('@xyflow/react', () => ({
  Background: () => null,
  Controls: () => null,
  ReactFlow: ({ children }) => <div data-testid="react-flow">{children}</div>,
}));
vi.mock('@tiptap/react', () => ({ EditorContent: () => null, useEditor: () => null }));
vi.mock('@tiptap/starter-kit', () => ({ default: {} }));
vi.mock('react-resizable-panels', () => ({
  Group: ({ children }) => <div>{children}</div>,
  Panel: ({ children }) => <div>{children}</div>,
  Separator: () => <div />,
  useDefaultLayout: () => ({ defaultLayout: undefined, onLayoutChanged: vi.fn() }),
}));
vi.mock('../../services/api', () => ({ notificationWorkflowAPI: {}, ticketsAPI: {} }));

const {
  RecipientsNodeEditor, originalRecipientsNote, ORIGINAL_RECIPIENTS_LABEL, ORIGINAL_RECIPIENTS_HELP,
} = await import('./NotificationWorkflowsPanel.jsx');

afterEach(() => cleanup());

describe('the Recipients picker', () => {
  test('offers "Everyone on the original e-mail" with its plain help text', () => {
    render(<RecipientsNodeEditor data={{ to: ['requester'], cc: [] }} onChange={vi.fn()} />);
    const box = screen.getByRole('checkbox', { name: 'Everyone on the original e-mail' });
    expect(box).toHaveAccessibleDescription(
      'Everyone on the original e-mail\'s To and Cc lines, plus anyone added to Cc since. Leaves out our own mailboxes, our agents, the requester and automated addresses.',
    );
    expect(screen.queryByText(/Original CCs/i)).not.toBeInTheDocument();
  });

  test('the token value stays original_ccs for saved workflows', () => {
    const onChange = vi.fn();
    render(<RecipientsNodeEditor data={{ to: ['requester'], cc: [] }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: ORIGINAL_RECIPIENTS_LABEL }));
    expect(onChange).toHaveBeenCalledWith({ cc: ['original_ccs'] });
  });

  test('a saved workflow with original_ccs shows it ticked under the new name', () => {
    render(<RecipientsNodeEditor data={{ to: ['requester'], cc: ['original_ccs'] }} onChange={vi.fn()} />);
    expect(screen.getByRole('checkbox', { name: ORIGINAL_RECIPIENTS_LABEL })).toBeChecked();
  });

  test('the wording', () => {
    expect(ORIGINAL_RECIPIENTS_LABEL).toBe('Everyone on the original e-mail');
    expect(ORIGINAL_RECIPIENTS_HELP).toBe('Everyone on the original e-mail\'s To and Cc lines, plus anyone added to Cc since. Leaves out our own mailboxes, our agents, the requester and automated addresses.');
  });
});

describe('Preview and Shadow run line', () => {
  test('the design lead\'s example', () => {
    expect(originalRecipientsNote({ count: 4, leftOff: { ownMailbox: 1, requester: 1 } }))
      .toBe('Everyone on the original e-mail: 4 people (left out: 1 of our mailboxes, the requester)');
  });

  test('says how many people and who was left out, agents included', () => {
    expect(originalRecipientsNote({
      count: 4,
      leftOff: { ownMailbox: 1, agent: 2, requester: 1, automated: 0, unattended: 0, removedByAgent: 1 },
    })).toBe('Everyone on the original e-mail: 4 people (left out: 1 of our mailboxes, 2 of our agents, the requester, 1 person an agent took off the Cc)');
  });

  test('one person, nobody left off', () => {
    expect(originalRecipientsNote({ count: 1, leftOff: {} })).toBe('Everyone on the original e-mail: 1 person');
  });

  test('the recipient cap and non-people on our domain are named', () => {
    expect(originalRecipientsNote({ count: 24, leftOff: { overRecipientLimit: 6, notAPerson: 2 } }))
      .toBe('Everyone on the original e-mail: 24 people (left out: 2 addresses on our domain that are not a person, 6 over the 25-recipient limit)');
  });

  test('says why the To line was not used', () => {
    expect(originalRecipientsNote({ count: 1, leftOff: {}, toLine: 'not_direct' }))
      .toBe('Everyone on the original e-mail: 1 person. To line not used: the e-mail did not come straight to our mailbox');
    expect(originalRecipientsNote({ count: 2, leftOff: {}, toLine: 'forwarded' }))
      .toBe('Everyone on the original e-mail: 2 people. To line not used: the ticket came from an agent\'s forward');
    expect(originalRecipientsNote({ count: 0, leftOff: {}, toLine: 'too_long' }))
      .toBe('Everyone on the original e-mail: 0 people. To line not used: more than 10 people on it');
  });

  test('an unreadable mailbox list reaches nobody, and says so', () => {
    expect(originalRecipientsNote({ count: 0, leftOff: {}, unavailable: true }))
      .toBe('Everyone on the original e-mail: nobody this time, our mailbox list could not be read');
  });

  test('nothing when the step did not use it', () => {
    expect(originalRecipientsNote(undefined)).toBeNull();
  });
});
