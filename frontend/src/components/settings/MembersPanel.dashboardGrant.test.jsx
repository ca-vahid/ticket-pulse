/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MembersPanel from './MembersPanel';

// QA 11-19 item 2: "Can see the Dashboard" — a per-agent switch an admin turns
// on in Settings → Members. It lets the agent open the Dashboard read only and
// changes nothing else they can do.

const MEMBERS = [
  { id: 12, name: 'Dana Fox', email: 'dana.fox@example.com', location: 'Vancouver', isActive: true, origin: 'freshservice' },
  { id: 13, name: 'Eli Park', email: 'eli.park@example.com', location: 'Calgary', isActive: true, origin: 'local' },
  { id: 14, name: 'Priya Nair', email: 'priya.nair@example.com', location: '', isActive: true, origin: 'freshservice' },
  { id: 15, name: 'Sam Okafor', email: 'sam.okafor@example.com', location: '', isActive: false, origin: 'freshservice' },
];
const ACCESS_MEMBERS = [
  { email: 'dana.fox@example.com', name: 'Dana Fox', technicianId: 12, accessRole: null },
  { email: 'eli.park@example.com', name: 'Eli Park', technicianId: 13, accessRole: 'viewer' },
  { email: 'priya.nair@example.com', name: 'Priya Nair', technicianId: 14, accessRole: 'admin' },
];

const { mockAuth, wsState, workspaceApiMocks, viewerMocks } = vi.hoisted(() => ({
  mockAuth: { user: { email: 'lead@example.com', role: 'viewer' } },
  wsState: {
    currentWorkspace: { id: 1, name: 'IT', slug: 'it' },
    availableWorkspaces: [{ id: 1, role: 'admin' }],
  },
  workspaceApiMocks: {
    getMembers: vi.fn(),
    grantAccess: vi.fn(),
    revokeAccess: vi.fn(),
  },
  viewerMocks: {
    list: vi.fn(),
    set: vi.fn(),
    mine: vi.fn(),
  },
}));

vi.mock('../../services/api', () => ({
  settingsAPI: {
    getTechnicians: vi.fn(() => Promise.resolve({ data: MEMBERS })),
    searchDirectory: vi.fn(() => Promise.resolve({ data: [] })),
    updateTechnician: vi.fn(() => Promise.resolve({})),
    setTechnicianActive: vi.fn(() => Promise.resolve({})),
    createLocalAgent: vi.fn(() => Promise.resolve({})),
  },
  workspaceAPI: workspaceApiMocks,
  dashboardViewersAPI: viewerMocks,
}));
vi.mock('../../contexts/WorkspaceContext', () => ({ useWorkspace: () => wsState }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => mockAuth }));

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.user = { email: 'lead@example.com', role: 'viewer' };
  wsState.availableWorkspaces = [{ id: 1, role: 'admin' }];
  workspaceApiMocks.getMembers.mockResolvedValue({ data: ACCESS_MEMBERS });
  viewerMocks.list.mockResolvedValue({ success: true, data: { technicianIds: [13] } });
  viewerMocks.set.mockImplementation(async (_ws, id, enabled) => ({
    success: true, data: { technicianIds: enabled ? [12, 13] : [13].filter((x) => x !== id) },
  }));
});
afterEach(() => cleanup());

describe('Members → Can see the Dashboard', () => {
  test('an admin sees the column, the one-line explanation and a switch per agent', async () => {
    render(<MembersPanel />);
    const dana = await screen.findByRole('switch', { name: 'Dana Fox can see the Dashboard' });
    expect(dana).toHaveAttribute('aria-checked', 'false');
    expect(dana).not.toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Eli Park can see the Dashboard' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('dashboard-grant-help')).toHaveTextContent(
      "Lets this agent open the Dashboard (read only). It doesn't change anything else they can do.",
    );
    // An admin already sees it: words, not a switch.
    expect(screen.queryByRole('switch', { name: 'Priya Nair can see the Dashboard' })).not.toBeInTheDocument();
    expect(screen.getByText('Already sees it')).toBeInTheDocument();
  });

  test('turning it on calls the API for this workspace and says what happens', async () => {
    render(<MembersPanel />);
    const dana = await screen.findByRole('switch', { name: 'Dana Fox can see the Dashboard' });
    fireEvent.click(dana);
    await waitFor(() => expect(viewerMocks.set).toHaveBeenCalledWith(1, 12, true));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Dana Fox can see the Dashboard' })).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByText(/Dana Fox can now open the Dashboard \(read only\)/)).toBeInTheDocument();
  });

  test('turning it off removes them; a refusal rolls the switch back', async () => {
    render(<MembersPanel />);
    const eli = await screen.findByRole('switch', { name: 'Eli Park can see the Dashboard' });
    fireEvent.click(eli);
    await waitFor(() => expect(viewerMocks.set).toHaveBeenCalledWith(1, 13, false));
    await waitFor(() => expect(screen.getByText('Eli Park can no longer open the Dashboard.')).toBeInTheDocument());

    viewerMocks.set.mockRejectedValueOnce(Object.assign(new Error('x'), { response: { data: { message: 'Admin access required' } } }));
    fireEvent.click(screen.getByRole('switch', { name: 'Dana Fox can see the Dashboard' }));
    await waitFor(() => expect(screen.getByText('Admin access required')).toBeInTheDocument());
    expect(screen.getByRole('switch', { name: 'Dana Fox can see the Dashboard' })).toHaveAttribute('aria-checked', 'false');
  });

  test('a non-admin sees the switches disabled and cannot change them', async () => {
    wsState.availableWorkspaces = [{ id: 1, role: 'viewer' }];
    render(<MembersPanel />);
    const dana = await screen.findByRole('switch', { name: 'Dana Fox can see the Dashboard' });
    expect(dana).toBeDisabled();
    fireEvent.click(dana);
    expect(viewerMocks.set).not.toHaveBeenCalled();
    expect(screen.getByTestId('dashboard-grant-help')).toHaveTextContent('Only an admin can change it.');
  });

  test('the column is hidden when the list is refused (403)', async () => {
    viewerMocks.list.mockRejectedValue(Object.assign(new Error('forbidden'), { response: { status: 403 } }));
    render(<MembersPanel />);
    await waitFor(() => expect(screen.getByText('Dana Fox')).toBeInTheDocument());
    expect(screen.queryByRole('switch', { name: /can see the Dashboard/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-grant-help')).not.toBeInTheDocument();
  });
});
