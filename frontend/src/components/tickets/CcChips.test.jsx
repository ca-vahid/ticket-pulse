/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import CcChips from './CcChips';

afterEach(cleanup);

describe('CcChips', () => {
  test('Enter commits a valid email as a chip', () => {
    const onChange = vi.fn();
    render(<CcChips value={[]} onChange={onChange} />);
    const input = screen.getByLabelText('Cc recipients');
    fireEvent.change(input, { target: { value: 'person@example.com' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['person@example.com']);
  });

  test('blur commits valid addresses and keeps the invalid one editable', () => {
    const onChange = vi.fn();
    render(<CcChips value={[]} onChange={onChange} />);
    const input = screen.getByLabelText('Cc recipients');
    fireEvent.change(input, { target: { value: 'a@x.io, not-an-email, b@y.io' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(['a@x.io', 'b@y.io']);
    expect(input).toHaveValue('not-an-email');
  });

  test('Backspace on an empty input removes the last chip', () => {
    const onChange = vi.fn();
    render(<CcChips value={['a@x.io', 'b@y.io']} onChange={onChange} />);
    fireEvent.keyDown(screen.getByLabelText('Cc recipients'), { key: 'Backspace' });
    expect(onChange).toHaveBeenCalledWith(['a@x.io']);
  });

  test('chip remove button works and the count badge shows', () => {
    const onChange = vi.fn();
    render(<CcChips value={['a@x.io', 'b@y.io']} onChange={onChange} />);
    expect(screen.getByText('2')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Remove a@x.io from Cc'));
    expect(onChange).toHaveBeenCalledWith(['b@y.io']);
  });

  test('duplicates are not re-added', () => {
    const onChange = vi.fn();
    render(<CcChips value={['a@x.io']} onChange={onChange} />);
    const input = screen.getByLabelText('Cc recipients');
    fireEvent.change(input, { target: { value: 'a@x.io' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });

  test('an in-progress invalid address shows the inline hint', () => {
    render(<CcChips value={[]} onChange={() => {}} />);
    fireEvent.change(screen.getByLabelText('Cc recipients'), { target: { value: 'nope@' } });
    expect(screen.getByText(/Not a valid email address yet/)).toBeInTheDocument();
  });
});
