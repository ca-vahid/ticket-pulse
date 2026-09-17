/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import FancySelect from './FancySelect';

afterEach(cleanup);

const OPTIONS = [
  { value: 'Open', label: 'Open', dot: 'bg-blue-500' },
  { value: 'Pending', label: 'Pending' },
  { value: 'Resolved', label: 'Resolved', disabled: true },
  { value: 'int:4', label: 'Service Desk', group: 'Internal groups' },
];

describe('FancySelect (16 Sep 2026)', () => {
  test('shows the current label, opens an animated listbox and reports the picked value as a string', () => {
    const onChange = vi.fn();
    render(<FancySelect value="Open" onChange={onChange} options={OPTIONS} aria-label="Ticket status" />);
    const btn = screen.getByRole('combobox', { name: 'Ticket status' });
    expect(btn).toHaveTextContent('Open');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.click(btn);
    const list = screen.getByRole('listbox', { name: 'Ticket status' });
    expect(list.className).toMatch(/animate-popIn/);
    expect(screen.getByText('Internal groups')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Pending' }));
    expect(onChange).toHaveBeenCalledWith('Pending');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  test('keyboard: ArrowDown opens, arrows skip disabled rows, Enter picks, Escape closes', () => {
    const onChange = vi.fn();
    render(<FancySelect value="Open" onChange={onChange} options={OPTIONS} aria-label="Ticket status" />);
    const btn = screen.getByRole('combobox', { name: 'Ticket status' });
    fireEvent.keyDown(btn, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(btn, { key: 'ArrowDown' }); // Open → Pending
    fireEvent.keyDown(btn, { key: 'ArrowDown' }); // skips Resolved (disabled) → Service Desk
    fireEvent.keyDown(btn, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('int:4');
    fireEvent.keyDown(btn, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  test('disabled never opens; picking the current value is a no-op', () => {
    const onChange = vi.fn();
    const { rerender } = render(<FancySelect value="Open" onChange={onChange} options={OPTIONS} aria-label="S" disabled />);
    fireEvent.click(screen.getByRole('combobox', { name: 'S' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    rerender(<FancySelect value="Open" onChange={onChange} options={OPTIONS} aria-label="S" />);
    fireEvent.click(screen.getByRole('combobox', { name: 'S' }));
    fireEvent.click(screen.getByRole('option', { name: 'Open' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
