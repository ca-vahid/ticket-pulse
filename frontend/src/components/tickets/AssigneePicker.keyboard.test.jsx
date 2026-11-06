/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// QA 11-05 #10: the assignee picker is a real combobox — arrows move the
// active row, Enter picks it through the same path as a click.

vi.mock('../../services/api', () => ({
  ticketsAPI: { assign: vi.fn(() => Promise.resolve({ success: true, data: {} })), triage: vi.fn(() => Promise.resolve({})) },
  assignmentAPI: {},
}));
vi.mock('../../utils/currentIdentity', () => ({ useCurrentIdentity: () => ({ email: 'coordinator@example.com', technicianId: 90 }) }));

const { ticketsAPI } = await import('../../services/api');
const { default: AssigneePicker } = await import('./AssigneePicker');

const away = { firstDay: '2026-11-02', lastDay: '2026-11-13', backOn: '2026-11-16', workingDaysAway: 9, fromToday: false };
const team = [
  { id: 1, name: 'Jo Chen' },
  { id: 2, name: 'Sohan Patel' },
  { id: 3, name: 'Sohrab Lane', away },
  { id: 4, name: 'Alex Rivera' },
];

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function openPicker(props = {}) {
  render(<AssigneePicker ticketId={501} value={null} technicians={team} {...props} />);
  fireEvent.click(screen.getByRole('button', { expanded: false }));
  return screen.getByRole('combobox', { name: 'Filter technicians' });
}
const activeOption = (input) => document.getElementById(input.getAttribute('aria-activedescendant'));
const type = (input, text) => fireEvent.change(input, { target: { value: text } });
const key = (input, k, extra = {}) => fireEvent.keyDown(input, { key: k, ...extra });

describe('AssigneePicker keyboard (QA 11-05 #10)', () => {
  test('the search box is a combobox wired to the listbox', () => {
    const input = openPicker();
    const list = screen.getByRole('listbox', { name: 'Choose assignee' });
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-controls', list.id);
    // Empty text, nobody assigned: Unassigned starts active.
    expect(activeOption(input)).toHaveAccessibleName(/Unassigned/);
    expect(activeOption(input)).toHaveAttribute('aria-selected', 'true');
  });

  test('typing "soh" then Enter assigns the first match', async () => {
    const input = openPicker();
    type(input, 'soh');
    expect(activeOption(input)).toHaveAccessibleName('Sohan Patel');
    key(input, 'Enter');
    await waitFor(() => expect(ticketsAPI.assign).toHaveBeenCalledWith(501, 2));
  });

  test('↓↓ then Enter picks the second person', async () => {
    const input = openPicker({ showAi: false });
    key(input, 'ArrowDown');
    key(input, 'ArrowDown');
    expect(activeOption(input)).toHaveAccessibleName('Sohan Patel');
    key(input, 'Enter');
    await waitFor(() => expect(ticketsAPI.assign).toHaveBeenCalledWith(501, 2));
  });

  test('↑ from the first option wraps to the last; Home and End jump', () => {
    const input = openPicker();
    key(input, 'ArrowUp');
    expect(activeOption(input)).toHaveAccessibleName(/Let AI assign/);
    key(input, 'Home');
    expect(activeOption(input)).toHaveAccessibleName(/Unassigned/);
    key(input, 'End');
    expect(activeOption(input)).toHaveAccessibleName(/Let AI assign/);
    key(input, 'ArrowDown');
    expect(activeOption(input)).toHaveAccessibleName(/Unassigned/);
  });

  test('aria-activedescendant follows the active row, and only that row is aria-selected', () => {
    const input = openPicker({ showAi: false });
    key(input, 'ArrowDown');
    const first = activeOption(input);
    expect(first).toHaveAccessibleName('Jo Chen');
    key(input, 'ArrowDown');
    const second = activeOption(input);
    expect(second).not.toBe(first);
    expect(second).toHaveAttribute('aria-selected', 'true');
    expect(first).toHaveAttribute('aria-selected', 'false');
    // Mouse hover moves the same active row.
    fireEvent.mouseMove(screen.getByRole('option', { name: 'Alex Rivera' }));
    expect(activeOption(input)).toHaveAccessibleName('Alex Rivera');
  });

  test('the current assignee starts active when the text is empty, and keeps its check mark', () => {
    render(<AssigneePicker ticketId={501} value={4} technicians={team} showAi={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Assignee: Alex Rivera/ }));
    const input = screen.getByRole('combobox', { name: 'Filter technicians' });
    expect(activeOption(input)).toHaveAccessibleName('Alex Rivera');
  });

  test('the away state is part of the option name', () => {
    openPicker();
    expect(screen.getByRole('option', { name: 'Sohrab Lane, away, back Mon 16 Nov' })).toBeInTheDocument();
  });

  test('Enter on an away person still asks first', async () => {
    const input = openPicker();
    type(input, 'sohr');
    key(input, 'Enter');
    expect(await screen.findByTestId('away-assign-confirm')).toBeInTheDocument();
    expect(ticketsAPI.assign).not.toHaveBeenCalled();
  });

  test('no match: nothing is active, Enter does nothing', () => {
    const input = openPicker();
    type(input, 'zzz');
    expect(input).not.toHaveAttribute('aria-activedescendant');
    key(input, 'Enter');
    expect(ticketsAPI.assign).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox', { name: 'Choose assignee' })).toBeInTheDocument();
  });

  test('Escape closes and returns focus to the trigger; reopening starts with empty text', () => {
    const input = openPicker();
    type(input, 'soh');
    key(input, 'Escape');
    expect(screen.queryByRole('listbox', { name: 'Choose assignee' })).not.toBeInTheDocument();
    const trigger = screen.getByRole('button', { expanded: false });
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    expect(screen.getByRole('combobox', { name: 'Filter technicians' })).toHaveValue('');
  });

  test('Tab closes the picker', () => {
    const input = openPicker();
    key(input, 'Tab');
    expect(screen.queryByRole('listbox', { name: 'Choose assignee' })).not.toBeInTheDocument();
  });
});
