/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Onboarding / Offboarding (HR lifecycle): the page renders its three URL tabs,
// the families with a dot + word status (no pills), the observe-mode plans in
// Activity, and a settings save that shows up in the change history.

const TECHS = [
  { id: 1, name: 'Vahid Haeri', email: 'v@x.ca', photoUrl: null },
  { id: 2, name: 'Muhammad Shahidullah', email: 'm@x.ca', photoUrl: null },
];
const TEMPLATES = {
  offboarding_standard: [
    { key: 'laptop', title: 'Laptop', dueOffsetDays: 0, assigneeTechId: null, groupId: null },
    { key: 'decommission_account', title: 'Decommissioning Account', dueOffsetDays: 7, assigneeTechId: 2, groupId: null },
  ],
  offboarding_after_fact: [{ key: 'laptop', title: 'Laptop', dueOffsetDays: 0, assigneeTechId: null, groupId: null }],
  onboarding: [
    { key: 'laptop', title: 'Laptop', dueOffsetDays: 0, assigneeTechId: null, groupId: null },
    { key: 'workstation', title: 'Workstation', dueOffsetDays: 0, assigneeTechId: null, groupId: null },
  ],
};
const SETTINGS = {
  settings: { mode: 'observe', parentAssigneeTechId: 1, templates: TEMPLATES, leave: { assigneeTechId: null, park: true }, officeChange: { assigneeTechId: null, park: true }, persisted: true },
  modes: ['off', 'observe', 'live'],
  templateNames: ['offboarding_standard', 'offboarding_after_fact', 'onboarding'],
  templateLabels: { offboarding_standard: 'Offboarding', offboarding_after_fact: 'Offboarding — after the fact', onboarding: 'Onboarding' },
  detection: {
    senders: ['humanresources@bgcengineering.ca'],
    rules: [{ type: 'departure', label: 'Departure', sender: 'humanresources@', example: 'Departure Notification: <Name> from the <Office> office will be departing', action: 'Offboarding family' }],
    passwords: 'Lines that carry a password are removed.',
  },
  technicians: TECHS,
  groups: [],
};
let changes = [];
const api = vi.hoisted(() => ({}));
Object.assign(api, {
  status: vi.fn(async () => ({ success: true, data: { available: true, mode: 'observe' } })),
  getSettings: vi.fn(async () => ({ success: true, data: SETTINGS })),
  settingsChanges: vi.fn(async () => ({ success: true, data: changes })),
  updateSettings: vi.fn(async (body) => {
    changes = [{ id: 9, field: 'templates.offboarding_standard[decommission_account].dueOffsetDays', before: 7, after: 10, changedBy: 'kim@x.ca', changedByName: 'Kim Lee', createdAt: '2026-10-01T18:00:00Z' }, ...changes];
    return { success: true, data: { settings: { ...SETTINGS.settings, ...body }, changes: [changes[0]] } };
  }),
  families: vi.fn(async () => ({ success: true, data: [{
    id: 4, kind: 'offboarding', personName: 'Jamie Gill', office: 'Calgary', effectiveDate: '2026-10-09', afterTheFact: false, status: 'open',
    progress: { done: 2, total: 5 }, linked: 0, parent: { id: 77, ref: '#240100' },
  }] })),
  family: vi.fn(async () => ({ success: true, data: {
    id: 4, kind: 'offboarding', status: 'open', afterTheFact: false, parent: { id: 77, ref: '#240100' }, employeeId: '1234', details: {},
    members: [{ role: 'child', key: 'laptop', title: 'Laptop', closed: false, ticket: { id: 90, ref: 'TP-5000', subject: 'Child Ticket - Laptop', status: 'Open', dueBy: '2026-10-10T00:00:00Z', assignee: { id: 2, name: 'Muhammad Shahidullah' } } }],
  } })),
  switchToAfterTheFact: vi.fn(async () => ({ success: true, data: { closed: [] } })),
  candidates: vi.fn(async () => ({ success: true, data: [] })),
  organise: vi.fn(async () => ({ success: true, data: { familyId: 8, outcome: 'done', warnings: [] } })),
  rerouteFamily: vi.fn(async () => ({ success: true, data: { familyId: 4, assignee: { id: 2, name: 'Muhammad Shahidullah' }, office: 'Vancouver and vicinity', moved: [{ ticketId: 90 }], warnings: [] } })),
  events: vi.fn(async () => ({ success: true, data: [{
    id: 1, mode: 'observe', outcome: 'recorded', decision: 'create_family', person: 'Jamie Gill', ticketId: 77, createdAt: '2026-10-01T17:00:00Z',
    summary: 'Would: Jamie Gill: offboarding family with 2 children (Laptop, Decommissioning Account), due Fri, Oct 9, 2026',
    details: { plan: { parent: { assigneeTechId: 1, dueDate: '2026-10-09' }, children: [{ key: 'laptop', title: 'Laptop', assigneeTechId: null, dueDate: '2026-10-09' }, { key: 'decommission_account', title: 'Decommissioning Account', assigneeTechId: 2, dueDate: '2026-10-16' }] } },
  }] })),
});

vi.mock('../services/api', () => ({ get hrLifecycleAPI() { return api; } }));
vi.mock('../hooks/useRequesterPhoto', () => ({ useRequesterPhoto: (email) => (email ? `photo:${email}` : null) }));
vi.mock('../components/AppHeader', () => ({ default: () => <div>AppHeader</div> }));
vi.mock('../components/nav/MobileTabBar', () => ({ default: () => null }));
vi.mock('../contexts/WorkspaceContext', () => ({ useWorkspace: () => ({ currentWorkspace: { id: 1, name: 'IT' } }) }));

const { default: Onboarding } = await import('./Onboarding');
const { resetHrLifecycleStatus } = await import('../hooks/useHrLifecycleStatus');

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/onboarding/:tab?" element={<Onboarding />} />
      <Route path="/tickets/:id" element={<div>ticket page</div>} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  resetHrLifecycleStatus();
  changes = [{ id: 1, field: 'mode', before: 'off', after: 'observe', changedBy: 'v@x.ca', changedByName: 'Vahid Haeri', createdAt: '2026-10-01T16:00:00Z' }];
});
afterEach(() => cleanup());

describe('Onboarding page', () => {
  test('renders the three tabs, the mode as a dot + word, and the People list', async () => {
    renderAt('/onboarding');
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-label'))).toEqual(['People', 'Activity', 'Settings']);
    expect(await screen.findByText('Jamie Gill')).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-mode')).toHaveTextContent('Shadow');
    expect(screen.getByText('2/5 closed')).toBeInTheDocument();
    // Expanding a family shows its children with assignee and status.
    fireEvent.click(screen.getByRole('button', { name: /Show Jamie Gill's tickets/ }));
    expect(await screen.findByText('TP-5000')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch to after the fact' })).toBeInTheDocument();
  });

  test('Activity shows the observe-mode plan', async () => {
    renderAt('/onboarding/activity');
    expect(await screen.findByText('New family')).toBeInTheDocument();
    expect(screen.getByText(/^Would: Jamie Gill/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText(/Parent: assign Vahid Haeri/)).toBeInTheDocument();
    expect(screen.getByText('Decommissioning Account')).toBeInTheDocument();
  });

  test('settings: edit a due offset, save, and the change appears in the history', async () => {
    renderAt('/onboarding/settings');
    const history = await screen.findByTestId('hr-change-history');
    expect(within(history).getByText('Vahid Haeri')).toBeInTheDocument();
    expect(within(history).getByText('Mode')).toBeInTheDocument();
    expect(screen.getByRole('table', { hidden: false })).toBeInTheDocument();
    expect(screen.getByText('Departure Notification: <Name> from the <Office> office will be departing')).toBeInTheDocument();

    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Offboarding: Decommissioning Account due offset (days)'), { target: { value: '10' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    const body = api.updateSettings.mock.calls[0][0];
    expect(body.templates.offboarding_standard.find((i) => i.key === 'decommission_account').dueOffsetDays).toBe(10);
    expect(await screen.findByText('Saved — 1 change recorded below.')).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByTestId('hr-change-history')).getByText('Kim Lee')).toBeInTheDocument());
    const row = within(screen.getByTestId('hr-change-history')).getByText('Offboarding — Decommissioning Account: due offset').closest('li');
    expect(row).toHaveTextContent('+7 days → +10 days');
  });

  test('mode change is a radio choice', async () => {
    renderAt('/onboarding/settings');
    const live = await screen.findByRole('radio', { name: /Live/ });
    fireEvent.click(live);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ mode: 'live' })));
  });

  test('a workspace without the section says so', async () => {
    api.status.mockResolvedValueOnce({ success: true, data: { available: false, mode: 'off' } });
    renderAt('/onboarding/people');
    expect(await screen.findByText(/not switched on for IT/)).toBeInTheDocument();
    expect(api.getSettings).not.toHaveBeenCalled();
  });
});

// 2 Oct 2026: in Shadow, People lists the families Shadow recorded.
describe('People in Shadow', () => {
  test('a shadow family shows as Shadow with the children Live would create', async () => {
    api.families.mockResolvedValueOnce({ success: true, data: [{
      id: 'shadow-12', shadow: true, kind: 'onboarding', personName: 'Isabela Sousa', office: 'Montreal', effectiveDate: '2026-10-12',
      afterTheFact: false, status: 'open', progress: { done: 0, total: 2 }, linked: 2, parent: { id: 61323, ref: '#245148' }, parentAssignee: 'Vahid Haeri',
      plannedChildren: [{ title: 'Laptop', dueDate: '2026-10-12', assignee: null }, { title: 'Workstation', dueDate: '2026-10-12', assignee: null }],
    }] });
    renderAt('/onboarding/people');
    expect(await screen.findByText('Isabela Sousa')).toBeInTheDocument();
    expect(screen.getAllByText('Shadow').length).toBeGreaterThanOrEqual(2); // the mode + the row
    expect(screen.getByText(/2 would be created · 2 linked/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Show Isabela Sousa's tickets/ }));
    const detail = screen.getByTestId('shadow-family-detail');
    expect(within(detail).getByText('Workstation')).toBeInTheDocument();
    expect(within(detail).getAllByText('AI routing')).toHaveLength(2);
    expect(api.family).not.toHaveBeenCalled();
  });
});

// 8 Oct 2026 (go-live): notices that predate Live are organised from People.
describe('People once Live', () => {
  const live = () => {
    api.status.mockResolvedValue({ success: true, data: { available: true, mode: 'live' } });
    api.getSettings.mockResolvedValue({ success: true, data: { ...SETTINGS, settings: { ...SETTINGS.settings, mode: 'live' } } });
  };
  afterEach(() => {
    api.status.mockResolvedValue({ success: true, data: { available: true, mode: 'observe' } });
    api.getSettings.mockResolvedValue({ success: true, data: SETTINGS });
  });

  test('"Not organised yet" lists what exists and what would be created; Organise asks first, then calls the server', async () => {
    live();
    api.candidates.mockResolvedValueOnce({ success: true, data: [{
      ticketId: 61870, kind: 'offboarding', personName: 'Matt Lin', effectiveDate: '2026-10-16', afterTheFact: false,
      parent: { id: 61870, ref: '#245882', assignee: { id: 1, name: 'Vahid Haeri' } },
      existing: [{ title: 'Laptop', ref: '#245883', status: 'Pending', closed: false }],
      toCreate: [{ title: 'Phone', dueDate: '2026-10-16', assignee: null }],
    }] });
    renderAt('/onboarding/people');
    const section = await screen.findByRole('region', { name: 'Not organised yet' });
    expect(within(section).getByText('Matt Lin')).toBeInTheDocument();
    expect(within(section).getByText(/has Laptop #245883/)).toBeInTheDocument();
    expect(within(section).getByText('Will create Phone')).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'Organise Matt Lin' }));
    expect(api.organise).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('1 existing ticket joins the family as they are.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Organise' }));
    await waitFor(() => expect(api.organise).toHaveBeenCalledWith(61870));
    expect(await screen.findByText('Matt Lin: organised.')).toBeInTheDocument();
  });

  test('in Shadow the section is not asked for', async () => {
    renderAt('/onboarding/people');
    await screen.findByText('Jamie Gill');
    expect(api.candidates).not.toHaveBeenCalled();
  });
});

describe('several people on one child', () => {
  test('"Add another person" sends the list and keeps the first as the single assignee', async () => {
    renderAt('/onboarding/settings');
    await screen.findByTestId('hr-change-history');
    const add = screen.getByRole('button', { name: 'Offboarding: Decommissioning Account: add another person' });
    // A child on AI routing has nobody to share with yet.
    expect(screen.queryByRole('button', { name: 'Offboarding: Laptop: add another person' })).not.toBeInTheDocument();
    fireEvent.click(add);
    expect(screen.getByLabelText('Offboarding: Decommissioning Account person 2')).toBeInTheDocument();
    // A slot nobody was chosen for is not a change.
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });
});

describe('new hires by office', () => {
  const ROUTED = { ...SETTINGS, settings: { ...SETTINGS.settings, officeRouting: { offices: [{ key: 'vancouver', label: 'Vancouver and vicinity', match: ['Vancouver', 'Kamloops'], assigneeTechIds: [1] }], fallbackTechIds: [] } } };
  afterEach(() => api.getSettings.mockResolvedValue({ success: true, data: SETTINGS }));

  test('Settings shows the office teams; adding a person and an office name is saved as clean lists', async () => {
    api.getSettings.mockResolvedValue({ success: true, data: ROUTED });
    renderAt('/onboarding/settings');
    const section = await screen.findByRole('region', { name: 'New hires by office' });
    expect(within(section).getByLabelText('Office team 1 name')).toHaveValue('Vancouver and vicinity');
    const covers = within(section).getByLabelText('Vancouver and vicinity: offices it covers');
    expect(covers).toHaveValue('Vancouver, Kamloops');
    // An empty slot is not a change; a new office name is.
    fireEvent.click(within(section).getByRole('button', { name: 'Vancouver and vicinity: add a person' }));
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    fireEvent.change(covers, { target: { value: 'Vancouver, Kamloops, Victoria, ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    expect(api.updateSettings.mock.calls[0][0].officeRouting).toEqual({
      offices: [{ key: 'vancouver', label: 'Vancouver and vicinity', match: ['Vancouver', 'Kamloops', 'Victoria'], assigneeTechIds: [1] }], fallbackTechIds: [],
    });
  });

  test('an open onboarding family offers "Reassign by office" and says what moved', async () => {
    api.families.mockResolvedValueOnce({ success: true, data: [{ id: 4, kind: 'onboarding', personName: 'Ann One', office: 'Vancouver', effectiveDate: '2026-11-02', afterTheFact: false, status: 'open', progress: { done: 0, total: 2 }, linked: 0, parent: { id: 77, ref: '#240100' } }] });
    api.family.mockResolvedValueOnce({ success: true, data: { id: 4, kind: 'onboarding', status: 'open', afterTheFact: false, officeList: 'Vancouver and vicinity', parent: { id: 77, ref: '#240100' }, details: {}, members: [] } });
    renderAt('/onboarding/people');
    fireEvent.click(await screen.findByRole('button', { name: /Show Ann One's tickets/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reassign by office' }));
    await waitFor(() => expect(api.rerouteFamily).toHaveBeenCalledWith(4));
    expect(await screen.findByText('1 ticket assigned to Muhammad Shahidullah (Vancouver and vicinity).')).toBeInTheDocument();
  });
});

describe('People: faces and the onboarding / offboarding switch', () => {
  test('a person with a known e-mail shows their photo, the row shows who holds the children, and the switch asks for one kind', async () => {
    api.families.mockResolvedValue({ success: true, data: [{
      id: 4, kind: 'onboarding', personName: 'Ann One', personEmail: 'aone@bgcengineering.ca', office: 'Vancouver', effectiveDate: '2026-11-02', afterTheFact: false, status: 'open',
      progress: { done: 0, total: 2 }, linked: 0, parent: { id: 77, ref: '#240100' }, assignees: [{ id: 2, name: 'Muhammad Shahidullah' }],
    }] });
    const { container } = renderAt('/onboarding/people');
    expect(await screen.findByText('Ann One')).toBeInTheDocument();
    expect(container.querySelector('img[src="photo:aone@bgcengineering.ca"]')).not.toBeNull();
    expect(screen.getByText('Muhammad Shahidullah')).toBeInTheDocument();
    expect(api.families).toHaveBeenLastCalledWith({ status: 'open' });
    fireEvent.click(screen.getByRole('button', { name: 'Offboarding' }));
    await waitFor(() => expect(api.families).toHaveBeenLastCalledWith({ status: 'open', kind: 'offboarding' }));
    expect(screen.getByRole('button', { name: 'Offboarding' })).toHaveAttribute('aria-pressed', 'true');
  });
});
