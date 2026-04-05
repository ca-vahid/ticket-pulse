import { beforeAll, describe, expect, test } from 'vitest';

beforeAll(() => {
  global.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
});

describe('api auth/workspace helpers', () => {
  test('stores and clears auth token in memory', async () => {
    const { setAuthToken, getAuthToken, clearAuthToken } = await import('./api');
    setAuthToken('token-123');
    expect(getAuthToken()).toBe('token-123');

    clearAuthToken();
    expect(getAuthToken()).toBeNull();
  });

  test('stores workspace id in memory', async () => {
    const { setWorkspaceId, getWorkspaceId } = await import('./api');
    setWorkspaceId(42);
    expect(getWorkspaceId()).toBe(42);
  });
});
