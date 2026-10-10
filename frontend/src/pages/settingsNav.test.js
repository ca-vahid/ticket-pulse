import { describe, expect, test } from 'vitest';
import {
  ALL_SETTINGS_NAV_ITEMS,
  filterSettingsNavItems,
  resolveActiveSettingsItem,
  resolveSettingsAlias,
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

  // v3.7.02 role lockdown (QA 08-24 #3): Settings is workspace-admin only.
  // Reviewers manage approval categories from Approvals → Categories now, and
  // the viewer "Dashboard prefs" form (which 403'd on save) is admin-only.
  test('reviewer gets ZERO sections (approval categories moved to Approvals → Categories)', () => {
    expect(filterSettingsNavItems({ isWsReviewer: true })).toEqual([]);
  });

  test('plain viewer gets ZERO sections', () => {
    expect(filterSettingsNavItems({})).toEqual([]);
  });

  test('approval categories and dashboard prefs are admin-tier items', () => {
    const byId = Object.fromEntries(ALL_SETTINGS_NAV_ITEMS.map((item) => [item.id, item.minRole]));
    expect(byId['approval-categories']).toBe('admin');
    expect(byId.dashboard).toBe('admin');
    expect(ALL_SETTINGS_NAV_ITEMS.some((item) => item.minRole === 'viewer' || item.minRole === 'reviewer')).toBe(false);
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

// Oct 2026: Urgent Escalation became the "Requester escalation" tab of Urgent
// Response. Old links (Assignment Review still has two) must keep working.
describe('resolveSettingsAlias', () => {
  const adminItems = filterSettingsNavItems({ isWsAdmin: true, isWsReviewer: true });

  test('Urgent Response replaced Urgent Escalation in the nav', () => {
    const item = ALL_SETTINGS_NAV_ITEMS.find((i) => i.id === 'urgent-response');
    expect(item).toMatchObject({ label: 'Urgent Response', minRole: 'admin', group: 'Tickets & AI' });
    expect(ids(ALL_SETTINGS_NAV_ITEMS)).not.toContain('urgent-escalation');
  });

  test('#urgent-escalation lands on Urgent Response, on its Requester escalation tab', () => {
    const alias = resolveSettingsAlias('urgent-escalation');
    expect(alias).toEqual({ id: 'urgent-response', tab: 'escalation' });
    expect(resolveActiveSettingsItem(adminItems, alias.id)?.id).toBe('urgent-response');
  });

  test('a live section passes through with no tab', () => {
    expect(resolveSettingsAlias('urgent-response')).toEqual({ id: 'urgent-response', tab: null });
    expect(resolveSettingsAlias('ticket-ops')).toEqual({ id: 'ticket-ops', tab: null });
    expect(resolveSettingsAlias(null)).toEqual({ id: null, tab: null });
  });

  test('#workspace-access lands on Members (its nav id is "agents"), not on the first section', () => {
    const alias = resolveSettingsAlias('workspace-access');
    expect(alias).toEqual({ id: 'agents', tab: null });
    expect(resolveActiveSettingsItem(adminItems, alias.id)).toMatchObject({ id: 'agents', label: 'Members' });
  });
});
