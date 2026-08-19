/** @vitest-environment jsdom */
// QA 08-18 #1 — the workflows "Custom emails" field ate commas because the old
// controlled input round-tripped split(',')→join(', ') on every keystroke.
// EmailChipsInput replaces it: committed chips + tolerant paste splitting.
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import EmailChipsInput from './EmailChipsInput';

afterEach(() => cleanup());

/** Controlled harness — mirrors updateNodeData({ customEmails: list }). */
function Harness({ initial = [], onListChange = () => {}, ...props }) {
  const [value, setValue] = useState(initial);
  return (
    <EmailChipsInput
      value={value}
      onChange={(list) => { setValue(list); onListChange(list); }}
      label="Custom email recipients"
      {...props}
    />
  );
}

const input = () => screen.getByRole('textbox', { name: 'Custom email recipients' });

describe('EmailChipsInput', () => {
  test('typing addresses with comma + paste with mixed separators → five chips, five-element list', () => {
    const onListChange = vi.fn();
    render(<Harness onListChange={onListChange} />);

    // Comma commits mid-typing — the exact keystroke the old input ate.
    fireEvent.change(input(), { target: { value: 'a@x.io' } });
    fireEvent.keyDown(input(), { key: ',' });
    expect(screen.getByText('a@x.io')).toBeInTheDocument();

    fireEvent.change(input(), { target: { value: 'b@x.io' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(screen.getByText('b@x.io')).toBeInTheDocument();

    // Tolerant paste split: semicolons AND bare whitespace separate.
    fireEvent.paste(input(), {
      clipboardData: { getData: () => 'c@x.io; d@x.io e@x.io' },
    });

    for (const email of ['a@x.io', 'b@x.io', 'c@x.io', 'd@x.io', 'e@x.io']) {
      expect(screen.getByText(email)).toBeInTheDocument();
    }
    expect(onListChange).toHaveBeenLastCalledWith(['a@x.io', 'b@x.io', 'c@x.io', 'd@x.io', 'e@x.io']);
  });

  test('semicolon commits too, and blur commits a fully-typed address', () => {
    const onListChange = vi.fn();
    render(<Harness onListChange={onListChange} />);
    fireEvent.change(input(), { target: { value: 'ops@example.com' } });
    fireEvent.keyDown(input(), { key: ';' });
    expect(onListChange).toHaveBeenLastCalledWith(['ops@example.com']);

    fireEvent.change(input(), { target: { value: 'lead@example.com' } });
    fireEvent.blur(input());
    expect(onListChange).toHaveBeenLastCalledWith(['ops@example.com', 'lead@example.com']);
  });

  test('duplicates are dropped case-insensitively', () => {
    const onListChange = vi.fn();
    render(<Harness initial={['a@x.io']} onListChange={onListChange} />);
    fireEvent.paste(input(), { clipboardData: { getData: () => 'A@X.IO, b@x.io, B@x.io' } });
    expect(onListChange).toHaveBeenLastCalledWith(['a@x.io', 'b@x.io']);
    expect(screen.getAllByText('a@x.io')).toHaveLength(1);
  });

  test('invalid fragments stay in the input with a hint instead of vanishing', () => {
    const onListChange = vi.fn();
    render(<Harness onListChange={onListChange} />);
    fireEvent.change(input(), { target: { value: 'not-an-email ok@x.io' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    // The valid part became a chip; the invalid part is still editable.
    expect(onListChange).toHaveBeenLastCalledWith(['ok@x.io']);
    expect(input()).toHaveValue('not-an-email');
    expect(screen.getByText(/Not a valid email address yet/)).toBeInTheDocument();
  });

  test('Backspace on an empty input removes the last chip; X removes a specific one', () => {
    const onListChange = vi.fn();
    render(<Harness initial={['a@x.io', 'b@x.io']} onListChange={onListChange} />);
    fireEvent.keyDown(input(), { key: 'Backspace' });
    expect(onListChange).toHaveBeenLastCalledWith(['a@x.io']);

    fireEvent.click(screen.getByRole('button', { name: 'Remove a@x.io' }));
    expect(onListChange).toHaveBeenLastCalledWith([]);
  });

  test('max caps the list and disables further input', () => {
    render(<Harness initial={['a@x.io']} max={2} />);
    fireEvent.paste(input(), { clipboardData: { getData: () => 'b@x.io c@x.io d@x.io' } });
    expect(screen.getByText('b@x.io')).toBeInTheDocument();
    expect(screen.queryByText('c@x.io')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Max 2 addresses')).toBeDisabled();
  });

  test('no typeahead combobox semantics unless a search fn is provided (opt-in)', () => {
    render(<Harness />);
    expect(input()).not.toHaveAttribute('role', 'combobox');
  });
});
