/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AgentAlertsPanel from './AgentAlertsPanel';
import { agentAPI } from '../../services/api';
import { alertSentence, categorySummary, indexCategoryTree } from './alertText';

vi.mock('../../services/api', () => ({
  agentAPI: {
    getAlerts: vi.fn(),
    getAlertOptions: vi.fn(),
    createAlert: vi.fn(),
    updateAlert: vi.fn(),
    deleteAlert: vi.fn(),
    saveAlertQuietHours: vi.fn(),
  },
}));

const TREE = [
  { id: 1, name: 'Devices & Hardware', children: [{ id: 11, name: 'Laptops' }, { id: 12, name: 'Docks' }, { id: 13, name: 'Monitors' }] },
  { id: 2, name: 'Account & Access', children: [{ id: 21, name: 'RDP' }, { id: 22, name: 'Password reset' }] },
  { id: 3, name: 'Printing', children: [] },
];

const opts = (over = {}) => ({
  data: { categories: [], tree: TREE, tags: [{ id: 5, name: 'vip' }], teams: { available: true, connected: true }, mine: [21], ...over },
});
const alerts = (subscriptions = [], readiness = { email: true, phoneVerified: false }) => ({
  data: { subscriptions, quietHours: { enabled: false, start: null, end: null, allowUrgent: true }, channelReadiness: readiness },
});

const SUB = {
  id: 7, label: null, categoryIds: [1, 21],
  categories: [{ id: 1, name: 'Devices & Hardware', path: 'Devices & Hardware' }, { id: 21, name: 'RDP', path: 'Account & Access › RDP' }],
  tagId: null, priorityMin: null, onCreated: true, onPriorityRaised: true, onRecategorized: false,
  channelTeams: true, channelEmail: true, channelSms: false, channelWhatsapp: false, channelPhone: false, isActive: true,
};

async function openNewEditor() {
  render(<AgentAlertsPanel />);
  fireEvent.click(await screen.findByRole('button', { name: /New alert/ }));
  return screen.findByRole('group', { name: 'New alert' });
}

describe('My alerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentAPI.getAlerts.mockResolvedValue(alerts());
    agentAPI.getAlertOptions.mockResolvedValue(opts());
    agentAPI.createAlert.mockResolvedValue({ data: {} });
    agentAPI.updateAlert.mockResolvedValue({ data: {} });
    agentAPI.deleteAlert.mockResolvedValue({ data: {} });
  });
  afterEach(() => cleanup());

  test('empty state: one line, a New alert button and quiet starters', async () => {
    render(<AgentAlertsPanel />);
    expect(await screen.findByText('You have no alerts yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New alert/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Urgent tickets anywhere/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /escalated to High or Urgent/ })).toBeInTheDocument();
    expect(screen.queryByText(/build one from scratch/)).not.toBeInTheDocument();
  });

  test('"My categories" starter ticks the agent\'s own categories', async () => {
    render(<AgentAlertsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /New tickets in my categories/ }));
    const editor = await screen.findByRole('group', { name: 'New alert' });
    expect(within(editor).getByTestId('alert-category-summary')).toHaveTextContent('Account & Access › RDP');
    expect(within(editor).getByRole('checkbox', { name: 'RDP' })).toBeChecked();
  });

  test('ticking a top category includes all of its subcategories', async () => {
    const editor = await openNewEditor();
    fireEvent.click(within(editor).getByRole('checkbox', { name: 'Devices & Hardware' }));
    fireEvent.click(within(editor).getByRole('button', { name: /Show subcategories of Devices & Hardware/ }));
    const laptops = within(editor).getByRole('checkbox', { name: 'Laptops' });
    expect(laptops).toBeChecked();
    expect(laptops).toBeDisabled();
    expect(within(editor).getAllByText('included')).toHaveLength(3);
    expect(within(editor).getByText('includes all 3')).toBeInTheDocument();
    expect(within(editor).getByTestId('alert-category-summary')).toHaveTextContent('All of Devices & Hardware');
  });

  test('search keeps a parent visible when one of its subcategories matches', async () => {
    const editor = await openNewEditor();
    fireEvent.change(within(editor).getByPlaceholderText('Find a category'), { target: { value: 'rdp' } });
    expect(within(editor).getByRole('checkbox', { name: 'Account & Access' })).toBeInTheDocument();
    expect(within(editor).getByRole('checkbox', { name: 'RDP' })).toBeInTheDocument();
    expect(within(editor).queryByRole('checkbox', { name: 'Password reset' })).not.toBeInTheDocument();
    expect(within(editor).queryByRole('checkbox', { name: 'Devices & Hardware' })).not.toBeInTheDocument();
    fireEvent.change(within(editor).getByPlaceholderText('Find a category'), { target: { value: 'zzz' } });
    expect(within(editor).getByText(/No category matches/)).toBeInTheDocument();
  });

  test('summary line counts several picks', async () => {
    const editor = await openNewEditor();
    const summary = within(editor).getByTestId('alert-category-summary');
    expect(summary).toHaveTextContent('Any category');
    fireEvent.click(within(editor).getByRole('checkbox', { name: 'Devices & Hardware' }));
    fireEvent.click(within(editor).getByRole('checkbox', { name: 'Printing' }));
    fireEvent.click(within(editor).getByRole('button', { name: /Show subcategories of Account & Access/ }));
    fireEvent.click(within(editor).getByRole('checkbox', { name: 'RDP' }));
    expect(summary).toHaveTextContent('All of Devices & Hardware, and 2 others');
  });

  test('channel tiles: unavailable ones are disabled with the reason underneath', async () => {
    agentAPI.getAlertOptions.mockResolvedValue(opts({ teams: { available: true, connected: false } }));
    const editor = await openNewEditor();
    const teams = within(editor).getByRole('button', { name: /^Teams/ });
    expect(teams).toBeDisabled();
    expect(within(editor).getByText('Connect Teams above')).toBeInTheDocument();
    expect(within(editor).getByRole('button', { name: /^SMS/ })).toBeDisabled();
    expect(within(editor).getAllByText('Verify a phone first')).toHaveLength(3);
    // Teams not ready → e-mail is the default.
    expect(within(editor).getByRole('button', { name: /^E-mail/ })).toHaveAttribute('aria-pressed', 'true');
  });

  test('Teams off for the workspace says so', async () => {
    agentAPI.getAlertOptions.mockResolvedValue(opts({ teams: { available: false, connected: false } }));
    const editor = await openNewEditor();
    expect(within(editor).getByText('Teams is not on in this workspace')).toBeInTheDocument();
  });

  test('save sends categoryIds and channelTeams (Teams is the default when connected)', async () => {
    const editor = await openNewEditor();
    const save = within(editor).getByRole('button', { name: 'Create alert' });
    expect(save).toBeDisabled(); // nothing to match yet
    expect(within(editor).getByText(/fire for every ticket/)).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole('checkbox', { name: 'Devices & Hardware' }));
    fireEvent.click(within(editor).getByRole('radio', { name: 'Urgent only' }));
    fireEvent.click(save);
    await waitFor(() => expect(agentAPI.createAlert).toHaveBeenCalledTimes(1));
    expect(agentAPI.createAlert.mock.calls[0][0]).toEqual(expect.objectContaining({
      categoryIds: [1], priorityMin: 4, channelTeams: true, channelEmail: false, onCreated: true, onRecategorized: false, label: null,
    }));
  });

  test('"moved into these categories" waits for categories', async () => {
    const editor = await openNewEditor();
    const moved = within(editor).getByRole('switch', { name: 'It is moved into these categories' });
    expect(moved).toBeDisabled();
    expect(within(editor).getByText('Pick categories first.')).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole('checkbox', { name: 'Printing' }));
    expect(moved).not.toBeDisabled();
  });

  test('list rows read as sentences; the switch pauses; delete confirms inline', async () => {
    agentAPI.getAlerts.mockResolvedValue(alerts([SUB, { ...SUB, id: 8, isActive: false, categoryIds: [], categories: [], priorityMin: 4, onPriorityRaised: false, channelTeams: false }]));
    render(<AgentAlertsPanel />);
    expect(await screen.findByText('New and escalated tickets in Devices & Hardware and Account & Access › RDP, by Teams and e-mail')).toBeInTheDocument();
    expect(screen.getByText('Paused — new tickets in any category that are Urgent, by e-mail')).toBeInTheDocument();
    expect(screen.queryByText(/^Paused$/)).not.toBeInTheDocument();

    const switches = screen.getAllByRole('switch', { name: /Alert (on|paused)/ });
    expect(switches[0]).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(switches[0]);
    await waitFor(() => expect(agentAPI.updateAlert).toHaveBeenCalledWith(7, expect.objectContaining({ isActive: false })));

    const confirmSpy = vi.spyOn(window, 'confirm');
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete alert' })[0]);
    expect(confirmSpy).not.toHaveBeenCalled();
    const group = screen.getByRole('group', { name: 'Confirm delete' });
    fireEvent.click(within(group).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(agentAPI.deleteAlert).toHaveBeenCalledWith(7, {}));
  });

  test('editing an alert opens it with its categories ticked and saves a PATCH', async () => {
    agentAPI.getAlerts.mockResolvedValue(alerts([SUB]));
    render(<AgentAlertsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit alert' }));
    const editor = await screen.findByRole('group', { name: 'Edit alert' });
    expect(within(editor).getByRole('checkbox', { name: 'Devices & Hardware' })).toBeChecked();
    expect(within(editor).getByRole('checkbox', { name: 'RDP' })).toBeChecked(); // parent opened because a sub is picked
    fireEvent.click(within(editor).getByRole('button', { name: 'Rename' }));
    fireEvent.change(within(editor).getByPlaceholderText(/Devices & Hardware/), { target: { value: 'Hardware watch' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(agentAPI.updateAlert).toHaveBeenCalledWith(7, expect.objectContaining({ categoryIds: [1, 21], label: 'Hardware watch', channelTeams: true })));
  });
});

describe('alertText helpers', () => {
  const index = indexCategoryTree(TREE);
  test('category summary', () => {
    expect(categorySummary([], index)).toBe('Any category');
    expect(categorySummary([3], index)).toBe('Printing');
    expect(categorySummary([21], index)).toBe('Account & Access › RDP');
    expect(categorySummary([1, 21], index)).toBe('All of Devices & Hardware and Account & Access › RDP');
  });
  test('sentence falls back to the tree for names and shortens long lists', () => {
    const s = alertSentence({ onCreated: true, categoryIds: [11, 12, 13, 21], channelEmail: true, isActive: true }, index);
    expect(s).toBe('New tickets in Devices & Hardware › Laptops, Devices & Hardware › Docks and 2 other categories, by e-mail');
  });
});
