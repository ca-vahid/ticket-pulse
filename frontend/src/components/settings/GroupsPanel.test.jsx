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

const settingsAPI = {
  getGroups: vi.fn(() => Promise.resolve({ data: GROUPS.map((g) => ({ ...g })) })),
  getTechnicians: vi.fn(() => Promise.resolve({ data: [] })),
  setDefaultGroup: vi.fn(() => Promise.resolve({ data: { defaultInternalGroupId: 9 } })),
  updateGroup: vi.fn(() => Promise.resolve({})),
  createInternalGroup: vi.fn(() => Promise.resolve({})),
  getGroupMembers: vi.fn(() => Promise.resolve({ data: [] })),
  setGroupMembers: vi.fn(() => Promise.resolve({ data: { memberCount: 0, members: [] } })),
};

vi.mock('../../services/api', () => ({ settingsAPI }));
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
