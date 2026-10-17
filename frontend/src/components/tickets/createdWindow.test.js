/** @vitest-environment jsdom */
import { afterEach, describe, expect, test } from 'vitest';
import { DEFAULT_WINDOW, readStoredWindow, resolveCreatedWindow, storeWindow } from './createdWindow';

afterEach(() => localStorage.clear());

describe('resolveCreatedWindow (QA 10-16 #7)', () => {
  test('90 days by default, applied to the list and the cards', () => {
    expect(DEFAULT_WINDOW).toBe('90d');
    expect(resolveCreatedWindow()).toEqual({ key: '90d', custom: false, applied: true, statsKey: '90d', searching: false });
  });

  test('the URL token beats the person\'s default; unknown values fall back', () => {
    expect(resolveCreatedWindow({ token: 'all', pref: '7d' })).toMatchObject({ key: 'all', applied: false, statsKey: null });
    expect(resolveCreatedWindow({ token: '30d', pref: '7d' })).toMatchObject({ key: '30d', applied: true });
    expect(resolveCreatedWindow({ token: 'junk', pref: '7d' })).toMatchObject({ key: '7d' });
    expect(resolveCreatedWindow({ pref: 'junk' })).toMatchObject({ key: '90d' });
  });

  test('a search, explicit dates and the created_* cards step the window aside; the cards still count in it', () => {
    expect(resolveCreatedWindow({ q: 'printer' })).toMatchObject({ applied: false, searching: true, statsKey: '90d' });
    expect(resolveCreatedWindow({ createdFrom: '2026-01-01' })).toMatchObject({ applied: false, custom: true, statsKey: '90d' });
    expect(resolveCreatedWindow({ segment: 'created_month' })).toMatchObject({ applied: false });
  });

  test('the local mirror round-trips and ignores garbage', () => {
    expect(readStoredWindow()).toBe('90d');
    storeWindow('7d');
    expect(readStoredWindow()).toBe('7d');
    localStorage.setItem('tp_queue_created_window', 'forever');
    expect(readStoredWindow()).toBe('90d');
  });
});
