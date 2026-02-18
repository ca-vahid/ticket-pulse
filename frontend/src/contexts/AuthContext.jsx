import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useMsal } from '@azure/msal-react';
import { InteractionStatus } from '@azure/msal-browser';
import { authAPI } from '../services/api';
import { loginRequest } from '../config/msalConfig';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const { instance, inProgress, accounts } = useMsal();
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const checkSession = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await authAPI.checkSession();

      if (response.authenticated && response.user) {
        setUser(response.user);
        setIsAuthenticated(true);
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
    if (inProgress !== InteractionStatus.None || !accounts.length) return;

    try {
      const tokenResponse = await instance.acquireTokenSilent({
        ...loginRequest,
        account: accounts[0],
      });

      if (tokenResponse?.idToken) {
        const response = await authAPI.ssoLogin(tokenResponse.idToken);
        if (response.success && response.user) {
          setUser(response.user);
          setIsAuthenticated(true);
          setError(null);
        }
      }
    } catch (err) {
      console.error('Token exchange failed:', err);
      setError(err.message);
    }
  }, [instance, inProgress, accounts]);

  useEffect(() => {
    if (accounts.length > 0 && !isAuthenticated && inProgress === InteractionStatus.None) {
      exchangeTokenForSession();
    }
  }, [accounts, isAuthenticated, inProgress, exchangeTokenForSession]);

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
      setUser(null);
      setIsAuthenticated(false);
      setError(null);
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
