/** @vitest-environment jsdom */
import { beforeEach, describe, expect, test } from 'vitest';
import {
  POST_LOGIN_PATH_KEY, consumePostLoginPath, isSafeInternalPath, peekPostLoginPath, rememberPostLoginPath,
} from './postLoginRedirect';

describe('postLoginRedirect — a deep link survives the SSO round trip', () => {
  beforeEach(() => window.sessionStorage.clear());

  test('remembers path + query + hash and hands it back once', () => {
    expect(rememberPostLoginPath({ pathname: '/tickets/44797', search: '?tab=history', hash: '#top' })).toBe(true);
    expect(peekPostLoginPath()).toBe('/tickets/44797?tab=history#top');
    expect(consumePostLoginPath()).toBe('/tickets/44797?tab=history#top');
    expect(consumePostLoginPath()).toBeNull();
  });

  test('never remembers the bounce targets or the root', () => {
    for (const p of ['/', '/login', '/auth/callback', '/workspace', '/login?x=1']) {
      expect(rememberPostLoginPath(p)).toBe(false);
    }
    expect(peekPostLoginPath()).toBeNull();
  });

  test('refuses anything that is not a same-app path', () => {
    for (const p of ['https://evil.example/', '//evil.example/x', '/\\evil', 'tickets/1', '', null, '/javascript:alert(1)', '/a\nb']) {
      expect(isSafeInternalPath(p)).toBe(false);
      expect(rememberPostLoginPath(p)).toBe(false);
    }
    // A tampered stored value is ignored too.
    window.sessionStorage.setItem(POST_LOGIN_PATH_KEY, 'https://evil.example/');
    expect(consumePostLoginPath()).toBeNull();
  });

  test('survives a throwing sessionStorage', () => {
    const real = window.sessionStorage;
    Object.defineProperty(window, 'sessionStorage', { configurable: true, get() { throw new Error('blocked'); } });
    expect(rememberPostLoginPath('/tickets/1')).toBe(false);
    expect(consumePostLoginPath()).toBeNull();
    Object.defineProperty(window, 'sessionStorage', { configurable: true, value: real });
  });
});
