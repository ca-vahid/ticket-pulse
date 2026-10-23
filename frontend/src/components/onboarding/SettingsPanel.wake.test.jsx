/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// QA 10-22 #6/#7: Onboarding → Settings → "When onboarding wakes".
const updateSettings = vi.fn(async (body) => ({ data: { settings: { ...SETTINGS, ...body }, changes: [{ field: 'wake.rules' }] } }));
vi.mock('../../services/api', () => ({
  hrLifecycleAPI: {
    settingsChanges: vi.fn(async () => ({ data: [] })),
    updateSettings: (...args) => updateSettings(...args),
  },
}));

import SettingsPanel from './SettingsPanel';
import { changeFieldLabel, changeValueLabel } from './onboardingFormat';

afterEach(() => { cleanup(); updateSettings.mockClear(); });

const SETTINGS = {
  mode: 'live',
  parentAssigneeTechId: null,
  templates: { onboarding: [{ key: 'laptop', title: 'Laptop', dueOffsetDays: 0, assigneeTechIds: [] }, { key: 'workstation', title: 'Workstation', dueOffsetDays: 0, assigneeTechIds: [] }] },
  leave: { assigneeTechId: null, park: true },
  officeChange: { assigneeTechId: null, park: true },
  officeRouting: { offices: [], fallbackTechIds: [] },
  wake: { leadDays: 21, holidayAware: false, rules: [] },
};
const DATA = { settings: SETTINGS, technicians: [], groups: [], templateLabels: { onboarding: 'Onboarding' }, templateNames: ['onboarding'], detection: {} };

describe('When onboarding wakes (QA 10-22 #6/#7)', () => {
  test('shows the lead, the holiday option and adds a job-title rule that is saved', async () => {
    render(<SettingsPanel data={DATA} />);
    const section = screen.getByRole('region', { name: 'When onboarding wakes' });
    expect(within(section).getByRole('spinbutton', { name: 'Days before the start date' })).toHaveValue(21);
    fireEvent.click(within(section).getByRole('checkbox', { name: /Add the holidays in between/ }));
    fireEvent.click(within(section).getByRole('button', { name: /Add a job-title rule/ }));
    const rule = within(section).getByTestId('wake-rule');
    fireEvent.change(within(rule).getByRole('textbox', { name: 'Wake rule 1: job title contains' }), { target: { value: 'CAD, Drafter' } });
    fireEvent.click(within(rule).getByRole('checkbox', { name: 'Laptop' }));
    fireEvent.change(within(rule).getByRole('spinbutton', { name: 'Wake rule 1: days before the start date' }), { target: { value: '35' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    expect(updateSettings.mock.calls[0][0].wake).toEqual({
      leadDays: 21,
      holidayAware: true,
      rules: [{ key: '', titleMatch: ['CAD', 'Drafter'], items: ['laptop'], leadDays: 35 }],
    });
  });

  test('change history reads in words', () => {
    expect(changeFieldLabel('wake.leadDays')).toBe('Onboarding wakes — days before the start');
    expect(changeValueLabel('wake.leadDays', 28)).toBe('28 days');
    expect(changeValueLabel('wake.holidayAware', true)).toBe('yes');
    expect(changeValueLabel('wake.rules', [{ titleMatch: ['CAD'], items: ['laptop'], leadDays: 35 }])).toBe('CAD · laptop: 35 days');
    expect(changeValueLabel('wake.rules', [])).toBe('none');
  });
});
