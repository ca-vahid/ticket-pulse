/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WorkspaceProvider, workspaceRoleFor } from '../contexts/WorkspaceContext';
import Notifications from './Notifications';

// QA 11-23 #3: a WORKSPACE admin (not a super admin) lost the held e-mail
// digest switch because currentWorkspace is stored without a role.

const authState = vi.hoisted(() => ({ value: null }));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => authState.value,
}));

vi.mock('../services/api', () => ({
  workspaceAPI: {
    getAll: vi.fn(() => Promise.resolve({ data: [] })),
    select: vi.fn(() => Promise.resolve({ data: {} })),
  },
  setWorkspaceId: vi.fn(),
  setAuthToken: vi.fn(),
}));

vi.mock('../components/agent/NotificationSettingsPanel', () => ({ default: () => <div /> }));
vi.mock('../components/agent/AgentAlertsPanel', () => ({ default: () => <div /> }));
vi.mock('../components/agent/TeamsNotificationsPanel', () => ({ default: () => <div /> }));
vi.mock('../components/agent/DevicePushPanel', () => ({ default: () => <div /> }));
vi.mock('../components/agent/HeldDigestPanel', () => ({
  default: ({ receives, workspaceId }) => (
    <div>{receives ? `digest switch for ws ${workspaceId}` : 'no digest switch'}</div>
  ),
}));

function renderWith({ userRole, wsRole }) {
  authState.value = {
    user: { email: 'dana.fox@example.com', role: userRole },
    logout: vi.fn(),
    isAuthenticated: true,
    isLoading: false,
    workspaceData: {
      selectedWorkspaceId: 2,
      availableWorkspaces: [
        { id: 1, name: 'Accounting', slug: 'ap', role: 'viewer', nativeTicketingEnabled: true },
        { id: 2, name: 'IT', slug: 'it', role: wsRole, nativeTicketingEnabled: true },
      ],
    },
  };
  return render(
    <MemoryRouter>
      <WorkspaceProvider>
        <Notifications />
      </WorkspaceProvider>
    </MemoryRouter>,
  );
}

describe('held e-mail digest switch (QA 11-23 #3)', () => {
  beforeEach(() => {
    // The persisted copy carries no role — the case that broke.
    localStorage.setItem('tp_selectedWorkspace', JSON.stringify({ id: 2, name: 'IT', slug: 'it' }));
  });
  afterEach(() => { cleanup(); localStorage.clear(); });

  test('a workspace admin whose currentWorkspace has no role gets the switch', () => {
    renderWith({ userRole: 'coordinator', wsRole: 'admin' });
    expect(screen.getByText('digest switch for ws 2')).toBeInTheDocument();
  });

  test('a coordinator in the workspace does not', () => {
    renderWith({ userRole: 'coordinator', wsRole: 'coordinator' });
    expect(screen.getByText('no digest switch')).toBeInTheDocument();
  });

  test('a super admin always does', () => {
    renderWith({ userRole: 'admin', wsRole: 'viewer' });
    expect(screen.getByText('digest switch for ws 2')).toBeInTheDocument();
  });
});

describe('workspaceRoleFor', () => {
  test('reads the role from the workspace list, not the current object', () => {
    expect(workspaceRoleFor({ id: 2 }, [{ id: 2, role: 'Admin' }])).toBe('admin');
    expect(workspaceRoleFor({ id: '2' }, [{ id: 2, role: 'coordinator' }])).toBe('coordinator');
  });
  test('falls back to a role on the current object, else null', () => {
    expect(workspaceRoleFor({ id: 3, role: 'admin' }, [])).toBe('admin');
    expect(workspaceRoleFor({ id: 3 }, [])).toBeNull();
    expect(workspaceRoleFor(null, [{ id: 3, role: 'admin' }])).toBeNull();
  });
});
