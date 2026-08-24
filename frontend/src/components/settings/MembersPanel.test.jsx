/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import MembersPanel from './MembersPanel';

// Real render coverage for the table rebuild (QA 07-29): the panel must mount,
// resolve data, and actually run the TanStack table path — filters, search,
// sorting. Mount-time bugs (declaration order, bad column defs) only surface
// by rendering.
const MEMBERS = [
  { id: 1, name: 'Adrian Lo', email: 'alo@bgcengineering.ca', location: 'Vancouver', isActive: true, origin: 'freshservice' },
  { id: 2, name: 'Bryan Baker', email: 'bbaker@bgcengineering.ca', location: 'Canada', isActive: false, origin: 'freshservice' },
  { id: 3, name: 'Syd Nezamian', email: 'snezamian@bgcengineering.ca', location: '', isActive: false, origin: 'local' },
  { id: 4, name: 'Gaby Tonnova', email: 'gtonnova@bgcengineering.ca', location: 'Vancouver', isActive: true, origin: 'freshservice', routingGuidance: 'Phones go to Gaby' },
];

// App-access union (Mega 08-23 AC3): Adrian already has viewer; Gaby is the
// technician-only "Marcus case" (accessRole null → No access).
const ACCESS_MEMBERS = [
  { email: 'alo@bgcengineering.ca', name: 'Adrian Lo', photoUrl: null, technicianId: 1, accessRole: 'viewer' },
  { email: 'gtonnova@bgcengineering.ca', name: 'Gaby Tonnova', photoUrl: null, technicianId: 4, accessRole: null },
];

const { mockAuth, workspaceApiMocks } = vi.hoisted(() => ({
  // Default caller: a workspace admin who is NOT a global admin.
  mockAuth: { user: { email: 'wsadmin@bgcengineering.ca', role: 'viewer' } },
  workspaceApiMocks: {
    getMembers: vi.fn(),
    grantAccess: vi.fn(() => Promise.resolve({ success: true })),
    revokeAccess: vi.fn(() => Promise.resolve({ success: true })),
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
}));
vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspace: { id: 1, name: 'IT', slug: 'it' } }),
}));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.user = { email: 'wsadmin@bgcengineering.ca', role: 'viewer' };
  workspaceApiMocks.getMembers.mockResolvedValue({ data: ACCESS_MEMBERS });
  workspaceApiMocks.grantAccess.mockResolvedValue({ success: true });
  workspaceApiMocks.revokeAccess.mockResolvedValue({ success: true });
});

describe('MembersPanel (table rebuild)', () => {
  afterEach(() => cleanup());

  test('defaults to Active filter — disabled members hidden, counts on chips', async () => {
    render(<MembersPanel />);
    await waitFor(() => expect(screen.getByText('Adrian Lo')).toBeInTheDocument());
    // Active members visible, disabled hidden by default (the big declutter).
    expect(screen.getByText('Gaby Tonnova')).toBeInTheDocument();
    expect(screen.queryByText('Bryan Baker')).not.toBeInTheDocument();
    expect(screen.queryByText('Syd Nezamian')).not.toBeInTheDocument();
    // Chips carry live counts: Active 2, Disabled 2, Local 1, All 4.
    expect(screen.getByRole('button', { name: /Active 2/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Disabled 2/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Local 1/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /All 4/ })).toBeInTheDocument();
  });

  test('All filter shows disabled rows with a quiet pill (no red badge)', async () => {
    render(<MembersPanel />);
    await waitFor(() => expect(screen.getByText('Adrian Lo')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /All 4/ }));
    expect(screen.getByText('Bryan Baker')).toBeInTheDocument();
    expect(screen.getAllByText('Disabled').length).toBeGreaterThan(0);
  });

  test('search narrows by name/email/location', async () => {
    render(<MembersPanel />);
    await waitFor(() => expect(screen.getByText('Adrian Lo')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /All 4/ }));
    fireEvent.change(screen.getByLabelText('Search members'), { target: { value: 'syd' } });
    expect(screen.getByText('Syd Nezamian')).toBeInTheDocument();
    expect(screen.queryByText('Adrian Lo')).not.toBeInTheDocument();
  });

  test('sorting by Member toggles without crashing', async () => {
    render(<MembersPanel />);
    await waitFor(() => expect(screen.getByText('Adrian Lo')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Member/ }));
    expect(screen.getByText('Adrian Lo')).toBeInTheDocument();
  });
});

describe('MembersPanel — App access column (Mega 08-23 AC3)', () => {
  afterEach(() => cleanup());

  test('renders per-member roles: granted members show their role, technician-only rows show No access', async () => {
    render(<MembersPanel />);
    // Column header (sortable button) — the info line also says "App access".
    await waitFor(() => expect(screen.getByRole('button', { name: /App access/ })).toBeInTheDocument());
    const adrianSelect = await screen.findByLabelText('App access for Adrian Lo');
    expect(adrianSelect).toHaveValue('viewer');
    // Gaby has no workspace_access row — the Marcus case.
    expect(screen.getByLabelText('App access for Gaby Tonnova')).toHaveValue('');
  });

  test('granting a technician-only member fires the API and updates optimistically', async () => {
    render(<MembersPanel />);
    const gabySelect = await screen.findByLabelText('App access for Gaby Tonnova');
    fireEvent.change(gabySelect, { target: { value: 'reviewer' } });
    // Optimistic: the dropdown reflects the new role before the API resolves.
    expect(gabySelect).toHaveValue('reviewer');
    await waitFor(() => expect(workspaceApiMocks.grantAccess)
      .toHaveBeenCalledWith(1, 'gtonnova@bgcengineering.ca', 'reviewer'));
    await waitFor(() => expect(screen.getByText(/can now sign in as reviewer/)).toBeInTheDocument());
  });

  test('selecting No access revokes', async () => {
    render(<MembersPanel />);
    const adrianSelect = await screen.findByLabelText('App access for Adrian Lo');
    fireEvent.change(adrianSelect, { target: { value: '' } });
    expect(adrianSelect).toHaveValue('');
    await waitFor(() => expect(workspaceApiMocks.revokeAccess)
      .toHaveBeenCalledWith(1, 'alo@bgcengineering.ca'));
  });

  test('a failed grant rolls the optimistic update back and surfaces the error', async () => {
    workspaceApiMocks.grantAccess.mockRejectedValue(
      Object.assign(new Error('Request failed'), { response: { data: { message: 'Only a global admin can grant the admin role or change an existing admin' } } }),
    );
    render(<MembersPanel />);
    const gabySelect = await screen.findByLabelText('App access for Gaby Tonnova');
    fireEvent.change(gabySelect, { target: { value: 'reviewer' } });
    await waitFor(() => expect(screen.getByText(/Only a global admin/)).toBeInTheDocument());
    // Re-query: the table row re-renders on rollback.
    await waitFor(() => expect(screen.getByLabelText('App access for Gaby Tonnova')).toHaveValue(''));
  });

  test('the Admin option is disabled for a workspace admin with the global-admin hint', async () => {
    render(<MembersPanel />);
    const gabySelect = await screen.findByLabelText('App access for Gaby Tonnova');
    const adminOption = within(gabySelect).getByRole('option', { name: /Admin \(global admin only\)/ });
    expect(adminOption).toBeDisabled();
  });

  test('a GLOBAL admin gets an enabled Admin option', async () => {
    mockAuth.user = { email: 'root@bgcengineering.ca', role: 'admin' };
    render(<MembersPanel />);
    const gabySelect = await screen.findByLabelText('App access for Gaby Tonnova');
    const adminOption = within(gabySelect).getByRole('option', { name: 'Admin' });
    expect(adminOption).not.toBeDisabled();
  });

  test('the column is hidden entirely when the access list is not available (403)', async () => {
    workspaceApiMocks.getMembers.mockRejectedValue(new Error('forbidden'));
    render(<MembersPanel />);
    await waitFor(() => expect(screen.getByText('Adrian Lo')).toBeInTheDocument());
    expect(screen.queryByText('App access')).not.toBeInTheDocument();
  });
});
