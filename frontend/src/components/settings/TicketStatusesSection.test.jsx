/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TicketStatusesSection from './TicketStatusesSection';
import { settingsAPI } from '../../services/api';

// Settings → Ticket Ops → Ticket statuses (Phase 8a): the per-workspace
// status vocabulary manager. System rows are locked (no retire, base fixed);
// custom rows add/rename/recolor/retire/reactivate with a confirm step.

const DEFS = [
  { id: 1, name: 'Open', baseStatus: 'Open', color: 'blue', sortOrder: 0, isSystem: true, isActive: true },
  { id: 2, name: 'Pending', baseStatus: 'Pending', color: 'amber', sortOrder: 1, isSystem: true, isActive: true },
  { id: 3, name: 'Resolved', baseStatus: 'Resolved', color: 'emerald', sortOrder: 2, isSystem: true, isActive: true },
  { id: 4, name: 'Closed', baseStatus: 'Closed', color: 'slate', sortOrder: 3, isSystem: true, isActive: true },
  { id: 5, name: 'Waiting on vendor', baseStatus: 'Pending', color: 'violet', sortOrder: 4, isSystem: false, isActive: true },
  { id: 6, name: 'Needs Rework', baseStatus: 'Open', color: 'orange', sortOrder: 5, isSystem: false, isActive: false },
];

vi.mock('../../services/api', () => ({
  settingsAPI: {
    getTicketStatuses: vi.fn(() => Promise.resolve({ data: { data: DEFS } })),
    createTicketStatus: vi.fn(() => Promise.resolve({})),
    updateTicketStatus: vi.fn(() => Promise.resolve({})),
    deactivateTicketStatus: vi.fn(() => Promise.resolve({})),
    reactivateTicketStatus: vi.fn(() => Promise.resolve({})),
  },
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function renderLoaded() {
  render(<TicketStatusesSection />);
  await waitFor(() => expect(screen.getByText('Waiting on vendor')).toBeInTheDocument());
}

describe('TicketStatusesSection', () => {
  test('renders active definitions with base chips, system locks, and the retired list', async () => {
    await renderLoaded();
    // Active rows in sort order with base chips ('Open' shows as a row name
    // AND as base chips, so count, don't getBy).
    expect(screen.getAllByText('Open').length).toBeGreaterThanOrEqual(2);
    const pendingChips = screen.getAllByText('Pending');
    expect(pendingChips.length).toBeGreaterThanOrEqual(2); // system row + custom row's base chip
    // System rows are locked: 4 locks, no Retire button for them.
    expect(screen.getAllByText('system')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: 'Retire status Open' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retire status Waiting on vendor' })).toBeInTheDocument();
    // Retired row renders struck-through with a Reactivate action.
    expect(screen.getByText('Needs Rework')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reactivate/ })).toBeInTheDocument();
    // The origin-awareness banner is always visible.
    expect(screen.getByText(/FreshService-born tickets keep FreshService statuses/)).toBeInTheDocument();
  });

  test('add form posts name + base status + color', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: /New status/ }));
    fireEvent.change(screen.getByLabelText('Status name'), { target: { value: 'On hold' } });
    fireEvent.change(screen.getByLabelText('Base status'), { target: { value: 'Pending' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Color cyan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add status' }));

    await waitFor(() => expect(settingsAPI.createTicketStatus).toHaveBeenCalledWith({
      name: 'On hold', baseStatus: 'Pending', color: 'cyan',
    }));
    // The list reloads after a successful create.
    expect(settingsAPI.getTicketStatuses).toHaveBeenCalledTimes(2);
  });

  test('retire asks for confirmation ("tickets keep this label") before calling deactivate', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Retire status Waiting on vendor' }));
    expect(settingsAPI.deactivateTicketStatus).not.toHaveBeenCalled();
    expect(screen.getByText(/Tickets keep this label/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Confirm retire/ }));
    await waitFor(() => expect(settingsAPI.deactivateTicketStatus).toHaveBeenCalledWith(5));
  });

  test('reactivate calls the reactivate endpoint', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: /Reactivate/ }));
    await waitFor(() => expect(settingsAPI.reactivateTicketStatus).toHaveBeenCalledWith(6));
  });

  test('editing a system row disables the base select; rename shows the relabel note and PATCHes', async () => {
    await renderLoaded();
    const openRow = screen.getByRole('button', { name: 'Move Open up' }).closest('li');
    fireEvent.click(Array.from(openRow.querySelectorAll('button')).find((b) => b.textContent === 'Edit'));
    expect(screen.getByLabelText('Base status')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Status name'), { target: { value: 'New' } });
    expect(screen.getByText(/will be relabeled/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(settingsAPI.updateTicketStatus).toHaveBeenCalledWith(1, { name: 'New' }));
  });

  test('base change on a custom row needs a second confirming Save (sends confirmBaseChange)', async () => {
    await renderLoaded();
    const row = screen.getByText('Waiting on vendor').closest('li');
    fireEvent.click(Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Edit'));
    const baseSelect = screen.getByLabelText('Base status');
    expect(baseSelect).not.toBeDisabled();
    fireEvent.change(baseSelect, { target: { value: 'Open' } });

    // First Save arms the warning, nothing sent yet.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(settingsAPI.updateTicketStatus).not.toHaveBeenCalled();
    expect(screen.getByText(/Click Save again to confirm/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(settingsAPI.updateTicketStatus).toHaveBeenCalledWith(5, {
      baseStatus: 'Open', confirmBaseChange: true,
    }));
  });

  test('up/down reorder renumbers the swapped rows', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Move Waiting on vendor up' }));
    // Waiting on vendor (idx 4) swaps with Closed (idx 3): each gets its new index.
    await waitFor(() => expect(settingsAPI.updateTicketStatus).toHaveBeenCalledWith(5, { sortOrder: 3 }));
    expect(settingsAPI.updateTicketStatus).toHaveBeenCalledWith(4, { sortOrder: 4 });
  });
});
