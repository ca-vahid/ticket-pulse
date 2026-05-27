import { beforeAll, describe, expect, test } from 'vitest';

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
      'getAutomationOps',
      'getCategories',
      'getCategoryIntelligence',
      'getDemandFlow',
      'getInsights',
      'getOverview',
      'getQuality',
      'getTeamBalance',
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
