/** @vitest-environment jsdom */
// eslint-disable-next-line no-unused-vars
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// QA 08-06 #1 — the "Default for new tickets" star on internal groups.

const GROUPS = [
  { id: 9, name: 'Accounts Receivable', description: null, origin: 'local', isActive: true, memberCount: 3, isDefault: false },
  { id: 10, name: 'Logistics', description: null, origin: 'local', isActive: true, memberCount: 1, isDefault: false },
  { id: 3, name: 'Service Desk', description: null, origin: 'freshservice', isActive: true, memberCount: 0, isDefault: false },
];

const TECHS = [
  { id: 11, name: 'Priya Nair', email: 'priya@example.com', isActive: true },
  { id: 22, name: 'Sam Okafor', email: 'susan@example.com', isActive: true },
  { id: 33, name: 'Gone Person', email: 'gone@example.com', isActive: false },
];

const settingsAPI = {
  getGroups: vi.fn(() => Promise.resolve({ data: GROUPS.map((g) => ({ ...g })) })),
  getTechnicians: vi.fn(() => Promise.resolve({ data: TECHS.map((t) => ({ ...t })) })),
  setGroupCoordinator: vi.fn(() => Promise.resolve({ data: { changed: true } })),
  setDefaultGroup: vi.fn(() => Promise.resolve({ data: { defaultInternalGroupId: 9 } })),
  updateGroup: vi.fn(() => Promise.resolve({})),
  createInternalGroup: vi.fn(() => Promise.resolve({})),
  getGroupMembers: vi.fn(() => Promise.resolve({ data: [] })),
  setGroupMembers: vi.fn(() => Promise.resolve({ data: { memberCount: 0, members: [] } })),
};

vi.mock('../../services/api', () => ({ settingsAPI }));
vi.mock('../../hooks/useRequesterPhoto', () => ({ useRequesterPhoto: () => null }));
vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspace: { id: 5, name: 'Project Accounting' } }),
}));

const { default: GroupsPanel } = await import('./GroupsPanel.jsx');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('GroupsPanel default group star (QA 08-06 #1)', () => {
  test('shows the "no default" hint and a star per active internal group; FS groups get none', async () => {
    render(<GroupsPanel />);
    await waitFor(() => expect(screen.getByText('Accounts Receivable')).toBeInTheDocument());

    expect(screen.getByTestId('no-default-group-hint')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make Accounts Receivable the default group for new tickets' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make Logistics the default group for new tickets' })).toBeInTheDocument();
    // FreshService groups are read-only — no star.
    expect(screen.queryByRole('button', { name: /Service Desk the default/ })).toBeNull();
  });

  test('clicking the star sets the default and reloads', async () => {
    render(<GroupsPanel />);
    await waitFor(() => expect(screen.getByText('Accounts Receivable')).toBeInTheDocument());

    settingsAPI.getGroups.mockResolvedValueOnce({
      data: GROUPS.map((g) => ({ ...g, isDefault: g.id === 9 })),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Make Accounts Receivable the default group for new tickets' }));

    await waitFor(() => expect(settingsAPI.setDefaultGroup).toHaveBeenCalledWith(9));
    // The reload marks the group as default: chip + "clear" affordance appear.
    await waitFor(() => expect(screen.getByText('Default for new tickets')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Clear Accounts Receivable as default group' })).toBeInTheDocument();
    expect(screen.queryByTestId('no-default-group-hint')).toBeNull();
  });

  test('clicking the filled star clears the default (the "No default" state)', async () => {
    settingsAPI.getGroups.mockResolvedValue({
      data: GROUPS.map((g) => ({ ...g, isDefault: g.id === 9 })),
    });
    render(<GroupsPanel />);
    await waitFor(() => expect(screen.getByText('Default for new tickets')).toBeInTheDocument());

    settingsAPI.getGroups.mockResolvedValueOnce({ data: GROUPS.map((g) => ({ ...g })) });
    fireEvent.click(screen.getByRole('button', { name: 'Clear Accounts Receivable as default group' }));

    await waitFor(() => expect(settingsAPI.setDefaultGroup).toHaveBeenCalledWith(null));
    await waitFor(() => expect(screen.getByTestId('no-default-group-hint')).toBeInTheDocument());
  });
});

// QA 10-14 — "Who is the coordinator?": a coordinator and a backup per group, FreshService groups included.
describe('GroupsPanel group coordinators (QA 10-14)', () => {
  const withCoordinator = () => GROUPS.map((g) => (g.id === 9 ? { ...g, coordinatorTechnicianId: 11, backupTechnicianId: 22 } : { ...g }));

  test('the coordinator line under a group, and a Coordinator button on every row', async () => {
    settingsAPI.getGroups.mockResolvedValueOnce({ data: withCoordinator() });
    render(<GroupsPanel />);
    await waitFor(() => expect(screen.getByTestId('coordinator-line-9')).toHaveTextContent('Coordinator Priya Nair, backup Sam Okafor'));
    expect(screen.queryByTestId('coordinator-line-10')).toBeNull();
    // FreshService groups are read-only, but who coordinates them is Ticket Pulse's own setting.
    for (const name of ['Accounts Receivable', 'Logistics', 'Service Desk']) {
      expect(screen.getByRole('button', { name: `Edit coordinator for ${name}` })).toBeInTheDocument();
    }
  });

  test('pick a coordinator and a backup for a FreshService group and save', async () => {
    render(<GroupsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit coordinator for Service Desk' }));
    const backup = screen.getByRole('combobox', { name: 'Backup for Service Desk' });
    // No backup without a coordinator.
    expect(backup).toBeDisabled();

    fireEvent.click(screen.getByRole('combobox', { name: 'Coordinator for Service Desk' }));
    // Inactive people are not offered.
    expect(screen.queryByRole('option', { name: /Gone Person/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Priya Nair' }));
    expect(backup).not.toBeDisabled();

    fireEvent.click(backup);
    // The coordinator cannot also be the backup.
    expect(screen.getByRole('option', { name: /Priya Nair/ })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('option', { name: 'Sam Okafor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(settingsAPI.setGroupCoordinator).toHaveBeenCalledWith(3, { coordinatorTechnicianId: 11, backupTechnicianId: 22 }));
    await waitFor(() => expect(screen.getByText('Coordinator saved for Service Desk.')).toBeInTheDocument());
    expect(screen.queryByTestId('coordinator-editor-3')).toBeNull();
  });

  test('clearing the coordinator clears the backup too and saves "none"', async () => {
    settingsAPI.getGroups.mockResolvedValueOnce({ data: withCoordinator() });
    render(<GroupsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit coordinator for Accounts Receivable' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Coordinator for Accounts Receivable' }));
    fireEvent.click(screen.getByRole('option', { name: /Nobody/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(settingsAPI.setGroupCoordinator).toHaveBeenCalledWith(9, { coordinatorTechnicianId: null, backupTechnicianId: null }));
  });

  test('a refused save shows the reason and keeps the editor open', async () => {
    settingsAPI.setGroupCoordinator.mockRejectedValueOnce(new Error('Coordinator: pick an active technician of this workspace'));
    render(<GroupsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit coordinator for Logistics' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Coordinator for Logistics' }));
    fireEvent.click(screen.getByRole('option', { name: 'Sam Okafor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('Coordinator: pick an active technician of this workspace')).toBeInTheDocument());
    expect(screen.getByTestId('coordinator-editor-10')).toBeInTheDocument();
  });
});
