/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import GroupsSection from './GroupsSection';
import { availabilityAPI } from '../../../services/api';

vi.mock('../../../services/api', () => ({
  availabilityAPI: { saveGroup: vi.fn(), deleteGroup: vi.fn() },
}));

/**
 * QA 10-13 #9: typing in the approval group editor lost the cursor after every
 * letter, and people could only be added by typing an e-mail address.
 */

const config = {
  groups: [],
  leaveTypes: [
    { id: 1, name: 'Vacation', isActive: true, tracksBalance: true, requiresApproval: true },
    { id: 3, name: 'Working from home', isActive: true },
  ],
  people: [
    { email: 'gtonnova@bgc.ca', name: 'Gaby Tonnova', inWorkspace: true },
    { email: 'rzaim@bgc.ca', name: 'Reza Zaim', inWorkspace: true },
    { email: 'alexa@bgc.ca', name: 'Alexa Park', inWorkspace: false },
  ],
};

function open() {
  const reload = vi.fn();
  const toast = vi.fn();
  render(<GroupsSection config={config} reload={reload} toast={toast} />);
  fireEvent.click(screen.getByRole('button', { name: /New group/ }));
  return { reload, toast };
}
const type = (el, value) => fireEvent.change(el, { target: { value } });

describe('Approval group editor', () => {
  beforeEach(() => { vi.clearAllMocks(); availabilityAPI.saveGroup.mockResolvedValue({ data: {} }); });
  afterEach(cleanup);

  it('keeps the cursor in the field while typing', () => {
    open();
    const name = screen.getByLabelText('Group name');
    expect(name).toHaveFocus(); // the drawer opens with the cursor in the first field
    for (const value of ['I', 'IT', 'IT ', 'IT V']) {
      type(name, value);
      expect(name).toHaveValue(value);
      expect(name).toHaveFocus(); // each letter used to hand focus to the drawer
    }
  });

  it('adds people by name from a list, with the keyboard or the mouse, and saves them', async () => {
    const { reload } = open();
    type(screen.getByLabelText('Group name'), 'IT');

    const people = screen.getByRole('combobox', { name: 'Add to People' });
    people.focus();
    type(people, 'rez');
    expect(within(screen.getByRole('listbox', { name: 'People' })).getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(people, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Remove Reza Zaim' })).toBeInTheDocument();
    expect(people).toHaveValue('');
    expect(people).toHaveFocus(); // ready for the next person

    const approvers = screen.getByRole('combobox', { name: 'Add to Approvers' });
    fireEvent.focus(approvers);
    fireEvent.mouseDown(within(screen.getByRole('listbox', { name: 'Approvers' })).getByText('Gaby Tonnova'));

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(availabilityAPI.saveGroup).toHaveBeenCalledWith(expect.objectContaining({
      name: 'IT', members: ['rzaim@bgc.ca'], approvers: [expect.objectContaining({ email: 'gtonnova@bgc.ca', isDelegate: false })],
    }));
  });

  it('adds the whole workspace in one go and warns when vacation would skip approval', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Add everyone in this workspace (2)' }));
    expect(screen.getByRole('button', { name: 'Remove Gaby Tonnova' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Alexa Park' })).not.toBeInTheDocument();
    expect(screen.queryByText(/approved without anyone looking/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Every type' }));
    expect(screen.getByText(/Vacation will be approved without anyone looking at it/)).toBeInTheDocument();
  });

  it('asks for people and an approver before saving', () => {
    open();
    type(screen.getByLabelText('Group name'), 'IT');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Add the people this group is for');
    expect(availabilityAPI.saveGroup).not.toHaveBeenCalled();
  });
});
