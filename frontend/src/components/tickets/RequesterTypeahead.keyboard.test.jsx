/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// QA 11-05 #10: the requester typeahead (Edit ticket, New ticket) gets the
// same keys as the assignee picker.

vi.mock('../../services/api', () => ({
  ticketsAPI: {
    requesterSearch: vi.fn(() => Promise.resolve({
      data: {
        requesters: [{ id: 41, name: 'Sam Ortiz', email: 'sam@example.com' }, { id: 42, name: 'Sami Lane', email: 'sami@example.com' }],
        directory: [{ name: 'Samira Cole', email: 'samira@example.com' }],
      },
    })),
    requesterPhoto: vi.fn(() => Promise.resolve({ data: { photo: null } })),
    requesterStats: vi.fn(() => Promise.resolve({ data: { total: 1 } })),
  },
}));

const { default: RequesterTypeahead } = await import('./RequesterTypeahead');

afterEach(() => cleanup());

async function typed(onChange) {
  render(<RequesterTypeahead value={null} onChange={onChange} />);
  const input = screen.getByRole('combobox', { name: 'Requester' });
  fireEvent.change(input, { target: { value: 'sam' } });
  await screen.findByRole('listbox', { name: 'Matching people' }, { timeout: 2000 });
  return input;
}
const active = (input) => document.getElementById(input.getAttribute('aria-activedescendant'));

describe('RequesterTypeahead keyboard (QA 11-05 #10)', () => {
  test('first hit active; Enter picks it', async () => {
    const onChange = vi.fn();
    const input = await typed(onChange);
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);
    expect(active(input)).toHaveTextContent('Sam Ortiz');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: 41, email: 'sam@example.com' }));
  });

  test('↓ moves into the directory hits, ↑ wraps, Home/End jump', async () => {
    const onChange = vi.fn();
    const input = await typed(onChange);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(active(input)).toHaveTextContent('Samira Cole');
    fireEvent.keyDown(input, { key: 'Home' });
    expect(active(input)).toHaveTextContent('Sam Ortiz');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(active(input)).toHaveTextContent('Sami Lane');
    expect(active(input)).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'End' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ email: 'samira@example.com', fromDirectory: true }));
  });

  test('Escape closes the list without picking', async () => {
    const onChange = vi.fn();
    const input = await typed(onChange);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(onChange).not.toHaveBeenCalled();
  });
});
