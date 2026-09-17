/** @vitest-environment jsdom */
import { beforeEach, describe, expect, test } from 'vitest';
import { canPrefetchOps, readRoleHint, writeRoleHint } from './roleHint';

describe('role hint (17 Sep 2026)', () => {
  beforeEach(() => { window.localStorage.clear(); });

  test('unknown role keeps the speculative dashboard prefetch (admins on a cold browser)', () => {
    expect(canPrefetchOps(null)).toBe(true);
    expect(canPrefetchOps(undefined)).toBe(true);
  });

  test('admins and read-only observers may prefetch; viewers, reviewers and agents may not', () => {
    expect(canPrefetchOps('admin')).toBe(true);
    expect(canPrefetchOps('readonly')).toBe(true);
    for (const r of ['viewer', 'reviewer', 'agent']) expect(canPrefetchOps(r)).toBe(false);
  });

  test('the hint round-trips and only writes on change', () => {
    expect(readRoleHint()).toBeNull();
    writeRoleHint('viewer');
    expect(readRoleHint()).toBe('viewer');
    writeRoleHint(null);
    expect(readRoleHint()).toBe('viewer');
    writeRoleHint('admin');
    expect(readRoleHint()).toBe('admin');
  });
});
