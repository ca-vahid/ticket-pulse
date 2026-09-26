/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MembersPanel from './MembersPanel';

// QA 09-25 item 6: "Assignable only" toggle for disabled members.
const MEMBERS = [
  { id: 1, name: 'Adrian Lo', email: 'alo@bgcengineering.ca', location: 'Vancouver', isActive: true, origin: 'freshservice' },
  { id: 2, name: 'Bryan Baker', email: 'bbaker@bgcengineering.ca', location: 'Canada', isActive: false, origin: 'freshservice', assignableOnly: true },
  { id: 3, name: 'Syd Nezamian', email: 'snezamian@bgcengineering.ca', location: '', isActive: false, origin: 'local' },
  { id: 4, name: 'Gaby Tonnova', email: 'gtonnova@bgcengineering.ca', location: 'Vancouver', isActive: true, origin: 'freshservice', routingGuidance: 'Phones go to Gaby' },
];

// App-access union (Mega 08-23 AC3): Adrian already has viewer; Gaby is the
// technician-only "Marcus case" (accessRole null → Basic access).
const ACCESS_MEMBERS = [
  { email: 'alo@bgcengineering.ca', name: 'Adrian Lo', photoUrl: null, technicianId: 1, accessRole: 'viewer' },
  { email: 'gtonnova@bgcengineering.ca', name: 'Gaby Tonnova', photoUrl: null, technicianId: 4, accessRole: null },
];

const { mockAuth, workspaceApiMocks, setAssignableSpy } = vi.hoisted(() => ({
  setAssignableSpy: vi.fn(() => Promise.resolve({})),
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
    setTechnicianAssignableOnly: (...a) => setAssignableSpy(...a),
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

describe('MembersPanel — assignable only (QA 09-25 item 6)', () => {
  afterEach(() => cleanup());

  test('disabled members get the toggle; state shows as plain text; clicking calls the endpoint', async () => {
    render(<MembersPanel />);
    await waitFor(() => expect(screen.getByText('Adrian Lo')).toBeInTheDocument());
    // Active members never get the toggle.
    expect(screen.queryByRole('button', { name: 'Assignable only for Adrian Lo' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Disabled 2/ }));
    await waitFor(() => expect(screen.getByText('Bryan Baker')).toBeInTheDocument());
    expect(screen.getByText('Assignable only')).toBeInTheDocument();

    const on = screen.getByRole('button', { name: 'Assignable only for Bryan Baker' });
    expect(on).toHaveAttribute('aria-pressed', 'true');
    const off = screen.getByRole('button', { name: 'Assignable only for Syd Nezamian' });
    expect(off).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(off);
    await waitFor(() => expect(setAssignableSpy).toHaveBeenCalledWith(3, true));
  });
});
