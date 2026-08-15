/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from './AuthContext';

/**
 * Phase A1 — session-bootstrap token round-trip. GET /auth/session now
 * returns a fresh authToken on the cookie branch; checkSession must store it
 * via setAuthToken so a brand-new tab (cookie, empty sessionStorage) can run
 * SSE/Bearer requests before MSAL silent SSO completes.
 */

const mocks = vi.hoisted(() => ({
  checkSession: vi.fn(),
  setAuthToken: vi.fn(),
  clearAuthToken: vi.fn(),
  registerAuthTokenRefresher: vi.fn(),
}));

vi.mock('@azure/msal-react', () => ({
  useMsal: () => ({ instance: {}, inProgress: 'none', accounts: [] }),
}));
vi.mock('@azure/msal-browser', () => ({
  InteractionStatus: { None: 'none' },
}));
vi.mock('../config/msalConfig', () => ({ loginRequest: {} }));
vi.mock('../services/api', () => ({
  authAPI: { checkSession: mocks.checkSession },
  setAuthToken: mocks.setAuthToken,
  clearAuthToken: mocks.clearAuthToken,
  registerAuthTokenRefresher: mocks.registerAuthTokenRefresher,
}));

function Probe() {
  const { isAuthenticated, user } = useAuth();
  return <div data-testid="probe">{isAuthenticated ? `in:${user?.email}` : 'out'}</div>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AuthContext.checkSession', () => {
  test('stores the bootstrapped authToken from /auth/session', async () => {
    mocks.checkSession.mockResolvedValue({
      success: true,
      authenticated: true,
      authToken: 'cookie-minted-jwt',
      user: { email: 'user@bgc.ca', role: 'viewer' },
      availableWorkspaces: [{ id: 1 }],
      selectedWorkspaceId: 1,
    });

    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('in:user@bgc.ca'));
    expect(mocks.setAuthToken).toHaveBeenCalledWith('cookie-minted-jwt');
  });

  test('a token-less session response still authenticates without touching the stored token', async () => {
    mocks.checkSession.mockResolvedValue({
      success: true,
      authenticated: true,
      user: { email: 'user@bgc.ca', role: 'viewer' },
      availableWorkspaces: [],
    });

    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('in:user@bgc.ca'));
    expect(mocks.setAuthToken).not.toHaveBeenCalled();
  });

  test('an unauthenticated response leaves the user signed out', async () => {
    mocks.checkSession.mockResolvedValue({ success: true, authenticated: false });
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('out'));
    expect(mocks.setAuthToken).not.toHaveBeenCalled();
  });
});
