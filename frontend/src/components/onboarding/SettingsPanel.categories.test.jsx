/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// QA 11-05 #5/#6: Comings & Goings → Settings — a category per child and per
// notice kind, the offboarding parent's due offset, after-the-fact business days.
const updateSettings = vi.fn(async (body) => ({ data: { settings: { ...SETTINGS, ...body }, changes: [{ field: 'parentDueOffsetDays' }] } }));
vi.mock('../../services/api', () => ({
  hrLifecycleAPI: {
    settingsChanges: vi.fn(async () => ({ data: [] })),
    updateSettings: (...args) => updateSettings(...args),
  },
}));

import SettingsPanel from './SettingsPanel';
import { categoryPairLabel, changeFieldLabel, changeValueLabel } from './onboardingFormat';

afterEach(() => { cleanup(); updateSettings.mockClear(); });

const CATEGORIES = [
  { id: 132, name: 'Onboarding & Offboarding', parentId: null },
  { id: 2, name: 'Offboarding', parentId: 132 },
  { id: 10, name: 'Onboarding', parentId: 132 },
  { id: 135, name: 'Hardware Return / Collection', parentId: 132 },
  { id: 144, name: 'Service Desk & Routing', parentId: null },
  { id: 148, name: 'Non-actionable Notifications', parentId: 144 },
];
const SETTINGS = {
  mode: 'live',
  parentAssigneeTechId: null,
  parentDueOffsetDays: 3,
  noticeCategories: {
    departure: { categoryId: 132, subcategoryId: 2 },
    new_hire: { categoryId: 132, subcategoryId: 10 },
    transfer: { categoryId: 132, subcategoryId: 10 },
    leave: { categoryId: 144, subcategoryId: 148 },
  },
  templates: {
    offboarding_after_fact: [
      { key: 'laptop', title: 'Laptop', dueOffsetDays: 5, assigneeTechIds: [], categoryId: 132, subcategoryId: 135 },
      { key: 'phone', title: 'Phone', dueOffsetDays: 5, assigneeTechIds: [], categoryId: null, subcategoryId: null },
    ],
  },
  leave: { assigneeTechId: null, park: true },
  officeChange: { assigneeTechId: null, park: true },
  officeRouting: { offices: [], fallbackTechIds: [] },
  wake: { leadDays: 21, holidayAware: false, rules: [] },
};
const DATA = {
  settings: SETTINGS,
  technicians: [],
  groups: [],
  categories: CATEGORIES,
  templateLabels: { offboarding_after_fact: 'Offboarding — after the fact' },
  templateNames: ['offboarding_after_fact'],
  detection: {},
};

describe('categories and due dates in Comings & Goings settings (QA 11-05)', () => {
  test('each child shows its category; a new one is picked and saved with the parent due offset', async () => {
    render(<SettingsPanel data={DATA} />);
    const list = screen.getByRole('region', { name: 'Offboarding — after the fact' });
    expect(within(list).getByText('Due, business days after the notice')).toBeInTheDocument();
    expect(within(list).getByRole('combobox', { name: 'Offboarding — after the fact: Laptop category' })).toHaveTextContent('Hardware Return / Collection · Onboarding & Offboarding');
    const phone = within(list).getByRole('combobox', { name: 'Offboarding — after the fact: Phone category' });
    expect(phone).toHaveTextContent('No category');
    fireEvent.click(phone);
    const listbox = await screen.findByRole('listbox', { name: 'Offboarding — after the fact: Phone category' });
    fireEvent.click(within(listbox).getByRole('option', { name: 'Hardware Return / Collection' }));
    expect(phone).toHaveTextContent('Hardware Return / Collection · Onboarding & Offboarding');

    // QA 11-05b #1: business days, default 3, relabelled.
    expect(screen.getByText('Main offboarding ticket due')).toBeInTheDocument();
    expect(screen.getByText('business days after the last day')).toBeInTheDocument();
    const due = screen.getByRole('spinbutton', { name: 'Main offboarding ticket due: business days after the last day' });
    expect(due).toHaveValue(3);
    expect(due).toHaveAttribute('max', '30');
    fireEvent.change(due, { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    const body = updateSettings.mock.calls[0][0];
    expect(body.parentDueOffsetDays).toBe(10);
    expect(body.templates.offboarding_after_fact.map((i) => [i.key, i.categoryId, i.subcategoryId])).toEqual([['laptop', 132, 135], ['phone', 132, 135]]);
  });

  test('notice kinds each have a category picker; "No category" clears one', async () => {
    render(<SettingsPanel data={DATA} />);
    const section = screen.getByRole('region', { name: 'Notice categories' });
    expect(within(section).getByRole('combobox', { name: 'Leave notices: category' })).toHaveTextContent('Non-actionable Notifications · Service Desk & Routing');
    const transfer = within(section).getByRole('combobox', { name: 'Transfer notices: category' });
    fireEvent.click(transfer);
    fireEvent.click(within(await screen.findByRole('listbox', { name: 'Transfer notices: category' })).getByRole('option', { name: 'No category (AI routing decides)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    expect(updateSettings.mock.calls[0][0].noticeCategories.transfer).toEqual({ categoryId: null, subcategoryId: null });
    expect(updateSettings.mock.calls[0][0].noticeCategories.leave).toEqual({ categoryId: 144, subcategoryId: 148 });
  });

  test('change history reads in words', () => {
    const catById = new Map(CATEGORIES.map((c) => [c.id, c]));
    expect(changeFieldLabel('parentDueOffsetDays')).toBe('Main offboarding ticket — due, business days after the last day');
    expect(changeValueLabel('parentDueOffsetDays', 3)).toBe('3 business days');
    expect(changeValueLabel('parentDueOffsetDays', 1)).toBe('1 business day');
    expect(changeFieldLabel('noticeCategories.leave')).toBe('Leave notices — category');
    expect(changeValueLabel('noticeCategories.leave', { categoryId: 144, subcategoryId: 148 }, { catById })).toBe('Service Desk & Routing › Non-actionable Notifications');
    expect(changeFieldLabel('templates.offboarding_after_fact[laptop].category', { templateLabels: DATA.templateLabels, templates: SETTINGS.templates })).toBe('Offboarding — after the fact — Laptop: category');
    expect(changeValueLabel('templates.offboarding_after_fact[laptop].category', { categoryId: null, subcategoryId: null }, { catById })).toBe('No category');
    expect(categoryPairLabel({ categoryId: 132, subcategoryId: null }, catById)).toBe('Onboarding & Offboarding');
  });
});
