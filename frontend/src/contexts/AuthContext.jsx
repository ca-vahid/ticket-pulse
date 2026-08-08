import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useMsal } from '@azure/msal-react';
import { InteractionStatus } from '@azure/msal-browser';
import { authAPI, setAuthToken, clearAuthToken, registerAuthTokenRefresher } from '../services/api';
import { loginRequest } from '../config/msalConfig';

const AuthContext = createContext(null);

// Silent-recovery budget (QA 08-07 #15). Attempts reset on any successful
// auth, so 6 covers a genuinely flaky network without hammering AAD; the
// cooldown doubles per attempt (2s, 4s, 8s, 16s, 32s, 64s) so a hard outage
// backs off instead of burning the budget in seconds.
//
// Token storage decision (recorded in plans/FR_2026-08-07_PLAN.md Phase 2):
// MSAL's cache AND our JWT stay in sessionStorage — tab-scoped by design, so
// tokens never outlive the tab and never touch localStorage (security
// posture). The cost is that a brand-new tab starts with no token; it
// bootstraps from the 7-day ROLLING httpOnly session cookie (source of truth)
// via /auth/session, then MSAL silent SSO mints a fresh JWT without any
// visible prompt. Users should no longer see 2-3 sign-outs a day: the old 8h
// absolute clocks (cookie + JWT) are now a 7d sliding cookie + 7d JWT.
const MAX_RECOVERY_ATTEMPTS = 6;
const RECOVERY_COOLDOWN_BASE_MS = 2000;
const POST_LOGIN_SUPPRESS_MS = 5000;

export function AuthProvider({ children }) {
  const { instance, inProgress, accounts } = useMsal();
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [workspaceData, setWorkspaceData] = useState(null);
  const isExchangingRef = useRef(false);
  const recoveryAttemptsRef = useRef(0);
  const recoveryCooldownRef = useRef(null);
  const lastAuthSuccessRef = useRef(0);

  const applyAuthenticatedResponse = useCallback((response) => {
    if (response.success && response.user) {
      if (response.authToken) {
        setAuthToken(response.authToken);
      }
      lastAuthSuccessRef.current = Date.now();
      setUser(response.user);
      setIsAuthenticated(true);
      setError(null);
      recoveryAttemptsRef.current = 0;
      setWorkspaceData({
        availableWorkspaces: response.availableWorkspaces || [],
        selectedWorkspaceId: response.selectedWorkspaceId || null,
        selectedWorkspaceName: response.selectedWorkspaceName || null,
        selectedWorkspaceSlug: response.selectedWorkspaceSlug || null,
      });
      return true;
    }
    return false;
  }, []);

  const checkSession = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await authAPI.checkSession();

      if (response.authenticated && response.user) {
        setUser(response.user);
        setIsAuthenticated(true);
        recoveryAttemptsRef.current = 0;
        setWorkspaceData({
          availableWorkspaces: response.availableWorkspaces || [],
          selectedWorkspaceId: response.selectedWorkspaceId || null,
          selectedWorkspaceName: response.selectedWorkspaceName || null,
          selectedWorkspaceSlug: response.selectedWorkspaceSlug || null,
        });
      } else {
        setUser(null);
        setIsAuthenticated(false);
      }
    } catch (err) {
      console.error('Session check failed:', err);
      setUser(null);
      setIsAuthenticated(false);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  const exchangeTokenForSession = useCallback(async () => {
    if (inProgress !== InteractionStatus.None || !accounts.length) return false;
    if (isExchangingRef.current) return false;
    isExchangingRef.current = true;

    try {
      const tokenResponse = await instance.acquireTokenSilent({
        ...loginRequest,
        account: accounts[0],
      });

      if (tokenResponse?.idToken) {
        const response = await authAPI.ssoLogin(tokenResponse.idToken);
        return applyAuthenticatedResponse(response);
      }
      return false;
    } catch (err) {
      console.error('Token exchange failed:', err);
      setError(err.message);
      return false;
    } finally {
      isExchangingRef.current = false;
    }
  }, [instance, inProgress, accounts, applyAuthenticatedResponse]);

  useEffect(() => {
    if (accounts.length > 0 && !isAuthenticated && inProgress === InteractionStatus.None) {
      exchangeTokenForSession();
    }
  }, [accounts, isAuthenticated, inProgress, exchangeTokenForSession]);

  // Expose the silent-recovery path to non-axios consumers (the SSE
  // EventSource) so useSSE can mint a fresh JWT before reconnecting instead
  // of 401-looping with an expired token. See refreshAuthToken() in api.js.
  useEffect(() => {
    registerAuthTokenRefresher(exchangeTokenForSession);
    return () => registerAuthTokenRefresher(null);
  }, [exchangeTokenForSession]);

  useEffect(() => {
    const handleUnauthorized = async () => {
      if (isExchangingRef.current) return;
      // Within the post-login window, the API interceptor handles retries —
      // suppress full auth recovery to avoid creating new sessions.
      if (lastAuthSuccessRef.current && Date.now() - lastAuthSuccessRef.current < POST_LOGIN_SUPPRESS_MS) {
        return;
      }
      if (recoveryAttemptsRef.current >= MAX_RECOVERY_ATTEMPTS) {
        console.warn(`Auth recovery exhausted (${MAX_RECOVERY_ATTEMPTS} attempts). Redirecting to login.`);
        setUser(null);
        setIsAuthenticated(false);
        setIsLoading(false);
        return;
      }
      if (recoveryCooldownRef.current) return;

      recoveryAttemptsRef.current++;
      // Exponential cooldown: 2s, 4s, 8s ... per consecutive failed attempt.
      const cooldownMs = RECOVERY_COOLDOWN_BASE_MS * (2 ** (recoveryAttemptsRef.current - 1));
      recoveryCooldownRef.current = setTimeout(() => {
        recoveryCooldownRef.current = null;
      }, cooldownMs);

      setIsLoading(true);
      try {
        const recovered = await exchangeTokenForSession();
        if (!recovered) {
          setUser(null);
          setIsAuthenticated(false);
          setError(null);
        }
      } finally {
        setIsLoading(false);
      }
    };

    window.addEventListener('auth:unauthorized', handleUnauthorized);
    return () => {
      window.removeEventListener('auth:unauthorized', handleUnauthorized);
      if (recoveryCooldownRef.current) clearTimeout(recoveryCooldownRef.current);
    };
  }, [exchangeTokenForSession]);

  const loginWithSSO = async () => {
    try {
      setError(null);
      await instance.loginRedirect(loginRequest);
    } catch (err) {
      setError(err.message || 'SSO login failed');
    }
  };

  const loginWithDevBypass = async () => {
    if (!import.meta.env.DEV) {
      setError('Development login is only available in local development.');
      return;
    }
    try {
      setError(null);
      setIsLoading(true);
      const response = await authAPI.devLogin();
      if (!applyAuthenticatedResponse(response)) {
        setError('Development login failed');
      }
    } catch (err) {
      setError(err.message || 'Development login failed');
    } finally {
      setIsLoading(false);
    }
  };

  const logout = async () => {
    try {
      await authAPI.logout();
    } catch (err) {
      console.error('Logout error:', err);
    } finally {
      clearAuthToken();
      setUser(null);
      setIsAuthenticated(false);
      setError(null);
      setWorkspaceData(null);
      try { sessionStorage.clear(); } catch (_) { /* ignore */ }
      try { localStorage.removeItem('tp_selectedWorkspace'); } catch (_) { /* ignore */ }
      try {
        await instance.logoutRedirect({ postLogoutRedirectUri: '/' });
      } catch (err) {
        console.error('MSAL logout error:', err);
      }
    }
  };

  const value = {
    user,
    isAuthenticated,
    isLoading,
    error,
    workspaceData,
    loginWithSSO,
    loginWithDevBypass,
    logout,
    checkSession,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
