/** @vitest-environment jsdom */
/* eslint-env node */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  COMPANY_WIDE_SETTINGS_MESSAGE, DashboardSettingsSection, SyncSettingsSection,
} from './CompanyWideSettingsSections';

/**
 * 22 Nov 2026 — company-wide settings for super admins only. The server
 * refuses every global key to a workspace admin (403 super_admin_required);
 * the Settings page shows those fields read-only with the same sentence
 * instead of letting a save fail.
 */
const FORM = { sync_interval_minutes: 5, default_timezone: 'America/Vancouver', dashboard_refresh_seconds: 30 };

afterEach(() => cleanup());

describe('Sync Settings', () => {
  test('a workspace admin sees the fields read-only, the sentence, and no Save', () => {
    const onSubmit = vi.fn((e) => e.preventDefault());
    render(<SyncSettingsSection formData={FORM} onChange={vi.fn()} onSubmit={onSubmit} canEdit={false} onTriggerSync={vi.fn()} />);
    expect(screen.getByText(COMPANY_WIDE_SETTINGS_MESSAGE)).toBeInTheDocument();
    expect(COMPANY_WIDE_SETTINGS_MESSAGE).toBe('Only a super admin can change company-wide settings.');
    const interval = screen.getByLabelText('Sync Interval (minutes)');
    const zone = screen.getByLabelText('Default Timezone');
    expect(interval).toBeDisabled();
    expect(zone).toBeDisabled();
    expect(interval).toHaveAccessibleDescription(COMPANY_WIDE_SETTINGS_MESSAGE);
    expect(screen.queryByRole('button', { name: /save settings/i })).not.toBeInTheDocument();
    // The manual sync is not a settings write and stays.
    expect(screen.getByRole('button', { name: /trigger manual sync/i })).toBeEnabled();
  });

  test('a super admin edits and saves', () => {
    const onSubmit = vi.fn((e) => e.preventDefault());
    const onChange = vi.fn();
    render(<SyncSettingsSection formData={FORM} onChange={onChange} onSubmit={onSubmit} canEdit onTriggerSync={vi.fn()} />);
    expect(screen.queryByTestId('company-wide-readonly')).not.toBeInTheDocument();
    const interval = screen.getByLabelText('Sync Interval (minutes)');
    expect(interval).toBeEnabled();
    fireEvent.change(interval, { target: { value: '10' } });
    expect(onChange).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('Dashboard settings', () => {
  test('a workspace admin sees the refresh interval read-only with the sentence', () => {
    render(<DashboardSettingsSection formData={FORM} onChange={vi.fn()} onSubmit={vi.fn()} canEdit={false} />);
    expect(screen.getByText(COMPANY_WIDE_SETTINGS_MESSAGE)).toBeInTheDocument();
    expect(screen.getByLabelText('Dashboard Refresh Interval (seconds)')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /save settings/i })).not.toBeInTheDocument();
  });

  test('a super admin saves; the result is announced', () => {
    const onSubmit = vi.fn((e) => e.preventDefault());
    render(<DashboardSettingsSection formData={FORM} onChange={vi.fn()} onSubmit={onSubmit} canEdit saveStatus={{ success: true, message: 'Settings saved successfully!' }} />);
    expect(screen.getByLabelText('Dashboard Refresh Interval (seconds)')).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Settings saved successfully!');
  });
});

describe('the Settings page wires it to the super-admin flag', () => {
  const page = readFileSync(resolve(process.cwd(), 'src/pages/Settings.jsx'), 'utf8');

  test('super admin = the global admin role, the flag the super-admin-only sections use', () => {
    expect(page).toContain("const isGlobalAdmin = user?.role === 'admin';");
    expect(page.match(/canEdit=\{isGlobalAdmin\}/g)).toHaveLength(2);
  });

  test('the provider credentials say the same sentence to a workspace admin, and a save is never sent', () => {
    expect(page).toMatch(/\{!isGlobalAdmin && \(\s*<div[^>]*>\s*<CompanyWideReadOnlyNote \/>/);
    expect(page).toMatch(/if \(!isGlobalAdmin\) \{\s*setSaveStatus\(\{ success: false, message: COMPANY_WIDE_SETTINGS_MESSAGE \}\);\s*return;/);
  });
});
