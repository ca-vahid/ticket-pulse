import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useMsal } from '@azure/msal-react';
import { InteractionStatus } from '@azure/msal-browser';
import { authAPI, setAuthToken, clearAuthToken } from '../services/api';
import { loginRequest } from '../config/msalConfig';

const AuthContext = createContext(null);

const MAX_RECOVERY_ATTEMPTS = 3;
const RECOVERY_COOLDOWN_MS = 2000;
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
      }
      return false;
    } catch (err) {
      console.error('Token exchange failed:', err);
      setError(err.message);
      return false;
    } finally {
      isExchangingRef.current = false;
    }
  }, [instance, inProgress, accounts]);

  useEffect(() => {
    if (accounts.length > 0 && !isAuthenticated && inProgress === InteractionStatus.None) {
      exchangeTokenForSession();
    }
  }, [accounts, isAuthenticated, inProgress, exchangeTokenForSession]);

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
      recoveryCooldownRef.current = setTimeout(() => {
        recoveryCooldownRef.current = null;
      }, RECOVERY_COOLDOWN_MS);

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
