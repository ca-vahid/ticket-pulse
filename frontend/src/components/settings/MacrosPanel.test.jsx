/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import MacrosPanel from './MacrosPanel';
import { settingsAPI, ticketsAPI } from '../../services/api';

// QA 11-05 #2: Macros are their own Settings tab with an ordered action list,
// the composer's editor for the note/reply, and "Insert variable".

vi.mock('../../services/api', () => ({
  settingsAPI: {
    getMacros: vi.fn(), createMacro: vi.fn(), updateMacro: vi.fn(), deleteMacro: vi.fn(),
    getTicketTypes: vi.fn(), getCustomFields: vi.fn(),
  },
  ticketsAPI: { meta: vi.fn() },
}));

const META = {
  statuses: [{ name: 'Open' }, { name: 'Closed' }],
  categoryTree: [{ id: 10, name: 'Security', subcategories: [{ id: 11, name: 'Phishing' }] }],
  groups: [{ id: 5, name: 'Service Desk', origin: 'local' }],
  technicians: [{ id: 42, name: 'Sam Ortiz' }],
  tags: [{ id: 7, name: 'phish' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  settingsAPI.getMacros.mockResolvedValue({ data: { data: [
    // Stored in the OLD key shape: still listed in plain words.
    { id: 1, name: 'Resolve as no-fault', description: 'Nothing was wrong', isActive: true, actions: { setPriority: 1, setStatus: 'Closed' } },
  ] } });
  settingsAPI.createMacro.mockResolvedValue({ data: { data: { id: 2 } } });
  settingsAPI.updateMacro.mockResolvedValue({ data: { data: {} } });
  settingsAPI.getTicketTypes.mockResolvedValue({ data: { data: [{ id: 1, name: 'Incident', isActive: true }] } });
  settingsAPI.getCustomFields.mockResolvedValue({ data: { data: [] } });
  ticketsAPI.meta.mockResolvedValue({ success: true, data: META });
});
afterEach(cleanup);

describe('Settings → Macros', () => {
  test('lists macros in the shared list layout: switch, name, a plain summary of the actions', async () => {
    render(<MacrosPanel />);
    expect(await screen.findByText('Resolve as no-fault')).toBeInTheDocument();
    expect(screen.getByText('Set priority to Low · Set status to Closed')).toBeInTheDocument();
    const sw = screen.getByRole('switch', { name: /Turn off Resolve as no-fault/ });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    await waitFor(() => expect(settingsAPI.updateMacro).toHaveBeenCalledWith(1, { isActive: false }));
  });

  test('a new macro: add actions, insert a variable into the note, pick a category, save the ordered steps', async () => {
    render(<MacrosPanel />);
    await screen.findByText('Resolve as no-fault');
    fireEvent.click(screen.getByRole('button', { name: /New macro/ }));
    const form = screen.getByTestId('macro-form');
    fireEvent.change(within(form).getByLabelText('Macro name'), { target: { value: 'Spam / phishing' } });

    const addAction = (label) => {
      fireEvent.click(within(form).getByRole('button', { name: /Add action/ }));
      fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${label}`) }));
    };
    addAction('Add an internal note');
    addAction('Set category');
    addAction('Set status');

    // Insert variable → the token lands in the note editor.
    fireEvent.click(within(screen.getByTestId('macro-note-body')).getByRole('button', { name: /Insert variable/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Requester first name/ }));
    expect(screen.getByRole('textbox', { name: 'Internal note' }).textContent).toContain('{{requester.firstName}}');

    fireEvent.change(within(form).getByLabelText('Category'), { target: { value: '10' } });
    fireEvent.change(within(form).getByLabelText('Subcategory'), { target: { value: '11' } });
    fireEvent.change(within(form).getByLabelText('Status'), { target: { value: 'Closed' } });

    // Order shows as numbered rows; group / type / custom fields say they skip FS tickets (no pills).
    expect(within(screen.getByTestId('macro-steps')).getAllByRole('listitem')).toHaveLength(3);

    fireEvent.click(within(form).getByRole('button', { name: /Create macro/ }));
    await waitFor(() => expect(settingsAPI.createMacro).toHaveBeenCalled());
    const payload = settingsAPI.createMacro.mock.calls[0][0];
    expect(payload.name).toBe('Spam / phishing');
    expect(payload.actions.steps.map((s) => s.type)).toEqual(['note', 'category', 'status']);
    expect(payload.actions.steps[0].html).toContain('{{requester.firstName}}');
    expect(payload.actions.steps[1]).toEqual(expect.objectContaining({ categoryId: 10, subcategoryId: 11 }));
    expect(payload.actions.steps[2]).toEqual(expect.objectContaining({ status: 'Closed' }));
  });

  test('editing an old-shape macro opens it as steps and saves the new shape', async () => {
    render(<MacrosPanel />);
    await screen.findByText('Resolve as no-fault');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Resolve as no-fault' }));
    const form = screen.getByTestId('macro-form');
    expect(within(form).getByLabelText('Priority')).toHaveValue('1');
    expect(within(form).getByLabelText('Status')).toHaveValue('Closed');
    // Move status above priority, then save.
    fireEvent.click(within(form).getByRole('button', { name: /Move “Set status” up/ }));
    fireEvent.click(within(form).getByRole('button', { name: 'Save macro' }));
    await waitFor(() => expect(settingsAPI.updateMacro).toHaveBeenCalled());
    const [id, payload] = settingsAPI.updateMacro.mock.calls[0];
    expect(id).toBe(1);
    expect(payload.actions.steps.map((s) => s.type)).toEqual(['status', 'priority']);
  });
});
