import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

beforeAll(() => {
  const sessionStore = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => sessionStore.get(key) ?? null,
    setItem: (key, value) => { sessionStore.set(key, String(value)); },
    removeItem: (key) => { sessionStore.delete(key); },
    clear: () => { sessionStore.clear(); },
  };
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
});

describe('api auth/workspace helpers', () => {
  test('stores and clears auth token for the current tab session', async () => {
    const { setAuthToken, getAuthToken, clearAuthToken } = await import('./api');
    setAuthToken('token-123');
    expect(getAuthToken()).toBe('token-123');
    expect(sessionStorage.getItem('tp_authToken')).toBe('token-123');

    clearAuthToken();
    expect(getAuthToken()).toBeNull();
    expect(sessionStorage.getItem('tp_authToken')).toBeNull();
  });

  test('stores workspace id in memory', async () => {
    const { setWorkspaceId, getWorkspaceId } = await import('./api');
    setWorkspaceId(42);
    expect(getWorkspaceId()).toBe(42);
  });

  test('exports analytics client methods', async () => {
    const { analyticsAPI } = await import('./api');
    expect(Object.keys(analyticsAPI).sort()).toEqual([
      'deleteReport',
      'generateReport',
      'getAutomationOps',
      'getCategories',
      'getCategoryIntelligence',
      'getDemandFlow',
      'getInsights',
      'getOverview',
      'getQuality',
      'getReport',
      'getTeamBalance',
      'listReports',
      'renameReport',
    ]);
  });

  test('exports AI provider client methods', async () => {
    const { aiProviderAPI } = await import('./api');
    expect(Object.keys(aiProviderAPI).sort()).toEqual([
      'getHealth',
      'getModels',
      'getSettings',
      'testProvider',
      'updateSettings',
    ]);
  });
});

// Minimal unsigned JWT shape — isAuthTokenExpiring only reads the payload.
function fakeJwt(expSecondsFromNow) {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `header.${payload}.sig`;
}

describe('isAuthTokenExpiring (Phase A1 SSE token edge)', () => {
  afterEach(async () => {
    const { clearAuthToken } = await import('./api');
    clearAuthToken();
  });

  test('returns TRUE when no token exists — a new tab must pre-refresh before SSE connects', async () => {
    const { clearAuthToken, isAuthTokenExpiring } = await import('./api');
    clearAuthToken();
    expect(isAuthTokenExpiring()).toBe(true);
  });

  test('returns false for a token expiring far in the future', async () => {
    const { setAuthToken, isAuthTokenExpiring } = await import('./api');
    setAuthToken(fakeJwt(3600));
    expect(isAuthTokenExpiring(60000)).toBe(false);
  });

  test('returns true for a token inside the expiry slack window', async () => {
    const { setAuthToken, isAuthTokenExpiring } = await import('./api');
    setAuthToken(fakeJwt(30));
    expect(isAuthTokenExpiring(60000)).toBe(true);
  });

  test('an undecodable token stays false (nothing to pre-refresh)', async () => {
    const { setAuthToken, isAuthTokenExpiring } = await import('./api');
    setAuthToken('not-a-jwt');
    expect(isAuthTokenExpiring()).toBe(false);
  });
});

describe('refreshAuthToken settle-timeout (Phase A1, relocated from R1)', () => {
  afterEach(async () => {
    const { registerAuthTokenRefresher, clearAuthToken } = await import('./api');
    registerAuthTokenRefresher(null);
    clearAuthToken();
    vi.useRealTimers();
  });

  test('a refresher that never settles resolves null after 5s and clears the in-flight slot', async () => {
    vi.useFakeTimers();
    const {
      registerAuthTokenRefresher, refreshAuthToken, setAuthToken, AUTH_REFRESH_SETTLE_TIMEOUT_MS,
    } = await import('./api');

    registerAuthTokenRefresher(() => new Promise(() => {})); // stuck MSAL call
    const stuck = refreshAuthToken();
    await vi.advanceTimersByTimeAsync(AUTH_REFRESH_SETTLE_TIMEOUT_MS + 1);
    await expect(stuck).resolves.toBeNull();

    // The stuck attempt must NOT poison the next refresh: a healthy refresher
    // registered afterwards succeeds immediately.
    registerAuthTokenRefresher(() => { setAuthToken('fresh-token'); return Promise.resolve(true); });
    await expect(refreshAuthToken()).resolves.toBe('fresh-token');
  });

  test('concurrent callers coalesce into one attempt', async () => {
    const { registerAuthTokenRefresher, refreshAuthToken, setAuthToken } = await import('./api');
    const refresher = vi.fn(async () => { setAuthToken('tok'); return true; });
    registerAuthTokenRefresher(refresher);
    const [a, b] = await Promise.all([refreshAuthToken(), refreshAuthToken()]);
    expect(a).toBe('tok');
    expect(b).toBe('tok');
    expect(refresher).toHaveBeenCalledTimes(1);
  });

  test('resolves null when no refresher is registered', async () => {
    const { registerAuthTokenRefresher, refreshAuthToken } = await import('./api');
    registerAuthTokenRefresher(null);
    await expect(refreshAuthToken()).resolves.toBeNull();
  });
});

describe('interceptor discipline (Phase A1: 401 recovers, 403 never does)', () => {
  test('only genuine 401s dispatch auth:unauthorized', async () => {
    const { shouldDispatchUnauthorized } = await import('./api');
    expect(shouldDispatchUnauthorized(401, '/dashboard')).toBe(true);
    expect(shouldDispatchUnauthorized(401, '/sse/status')).toBe(true);
  });

  test('403 (and other statuses) never trigger recovery', async () => {
    const { shouldDispatchUnauthorized } = await import('./api');
    expect(shouldDispatchUnauthorized(403, '/analytics/overview')).toBe(false);
    expect(shouldDispatchUnauthorized(403, '/dashboard')).toBe(false);
    expect(shouldDispatchUnauthorized(500, '/dashboard')).toBe(false);
  });

  test('auth/public endpoints and speculative requests are exempt even on 401', async () => {
    const { shouldDispatchUnauthorized } = await import('./api');
    expect(shouldDispatchUnauthorized(401, '/auth/session')).toBe(false);
    expect(shouldDispatchUnauthorized(401, '/auth/sso')).toBe(false);
    expect(shouldDispatchUnauthorized(401, '/summit/public/vote')).toBe(false);
    expect(shouldDispatchUnauthorized(401, '/ticket-status/public/x')).toBe(false);
    expect(shouldDispatchUnauthorized(401, '/dashboard', { _speculative: true })).toBe(false);
  });

  test('noteForbidden surfaces once per endpoint per session (deduped)', async () => {
    const { noteForbidden } = await import('./api');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(noteForbidden('/analytics/overview?range=7d', 'no access', 'workspace_access_denied')).toBe(true);
      expect(noteForbidden('/analytics/overview?range=30d', 'no access', 'workspace_access_denied')).toBe(false);
      expect(noteForbidden('/noise-rules', 'no access', 'admin_required')).toBe(true);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});
