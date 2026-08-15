import { describe, expect, test } from 'vitest';
import {
  ALL_SETTINGS_NAV_ITEMS,
  filterSettingsNavItems,
  resolveActiveSettingsItem,
} from './settingsNav';

/**
 * Phase A1 — Settings role flows. The content pane renders off the RESOLVED
 * item (never the raw hash), so these rules are what keeps a deep link from
 * opening a section the role can't see — and what gives agents the friendly
 * "no settings" card instead of a broken FreshService form.
 */

const ids = (items) => items.map((item) => item.id);

describe('filterSettingsNavItems', () => {
  test('global admin sees every section', () => {
    const items = filterSettingsNavItems({ isGlobalAdmin: true, isWsAdmin: true, isWsReviewer: true });
    expect(items).toHaveLength(ALL_SETTINGS_NAV_ITEMS.length);
  });

  test('workspace admin sees admin sections but not global-only ones', () => {
    const items = filterSettingsNavItems({ isWsAdmin: true, isWsReviewer: true });
    expect(ids(items)).toContain('ticket-ops');
    expect(ids(items)).toContain('approval-categories');
    expect(ids(items)).toContain('dashboard');
    expect(ids(items)).not.toContain('freshservice');
    expect(ids(items)).not.toContain('admins');
    expect(ids(items)).not.toContain('workspaces');
    expect(ids(items)).not.toContain('ai-usage');
  });

  test('reviewer sees approval categories + viewer sections only', () => {
    const items = filterSettingsNavItems({ isWsReviewer: true });
    expect(ids(items).sort()).toEqual(['approval-categories', 'dashboard']);
  });

  test('plain viewer gets only viewer-tier sections', () => {
    const items = filterSettingsNavItems({});
    expect(ids(items)).toEqual(['dashboard']);
  });

  test('agents get ZERO sections regardless of other flags', () => {
    expect(filterSettingsNavItems({ isAgent: true, isGlobalAdmin: true, isWsAdmin: true, isWsReviewer: true })).toEqual([]);
    expect(filterSettingsNavItems({ isAgent: true })).toEqual([]);
  });
});

describe('resolveActiveSettingsItem', () => {
  const adminItems = filterSettingsNavItems({ isWsAdmin: true, isWsReviewer: true });

  test('honors the requested hash when the section is visible', () => {
    expect(resolveActiveSettingsItem(adminItems, 'ticket-ops')?.id).toBe('ticket-ops');
  });

  test('falls back to the first visible section for a hidden/unknown hash', () => {
    expect(resolveActiveSettingsItem(adminItems, 'freshservice')?.id).toBe(adminItems[0].id);
    expect(resolveActiveSettingsItem(adminItems, 'not-a-section')?.id).toBe(adminItems[0].id);
    expect(resolveActiveSettingsItem(adminItems, null)?.id).toBe(adminItems[0].id);
  });

  test('resolves to null when no sections are visible (agent deep link)', () => {
    expect(resolveActiveSettingsItem([], 'ticket-ops')).toBeNull();
  });
});
