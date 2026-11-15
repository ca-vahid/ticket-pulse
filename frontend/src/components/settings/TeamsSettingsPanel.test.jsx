/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// QA 10-01 #4: "There should be a button to disconnect an agent from the Teams bot in settings."
const STATUS = {
  bot: { configured: true, botToken: true, graphToken: true, catalogAppId: 'cat-1', appId: 'ddd8d5f7-0000' },
  settings: { teamsEnabled: true, channelWebhookUrl: '', channelMinPriority: 3, defaults: { events: {}, options: {} } },
  events: [],
  agents: [
    { id: 7, name: 'Adrian Lo', email: 'alo@x.com', connected: true, disconnected: false },
    { id: 8, name: 'David Zapata', email: 'dz@x.com', connected: false, disconnected: true, disconnectedBy: 'vhaeri@x.com' },
    { id: 9, name: 'Marcus Blackstock', email: 'mb@x.com', connected: false, disconnected: false },
  ],
  last24h: {},
};
const teamsAdminAPI = vi.hoisted(() => ({
  status: vi.fn(),
  saveSettings: vi.fn(),
  install: vi.fn(),
  disconnect: vi.fn(),
  packageUrl: () => '/downloads/ticket-pulse-teams.zip',
}));
vi.mock('../../services/api', () => ({ teamsAdminAPI }));

const { default: TeamsSettingsPanel } = await import('./TeamsSettingsPanel.jsx');

afterEach(cleanup);

describe('Teams settings: disconnect an agent', () => {
  test('connected agents get Disconnect; it asks once, then removes them', async () => {
    teamsAdminAPI.status.mockResolvedValue({ data: STATUS });
    teamsAdminAPI.disconnect.mockResolvedValue({ data: { disconnected: 1, appRemoved: 1, failed: [] } });
    render(<TeamsSettingsPanel />);
    fireEvent.click(await screen.findByTestId('teams-disconnect-7'));
    expect(teamsAdminAPI.disconnect).not.toHaveBeenCalled();
    expect(screen.getByText('Remove the app from their Teams?')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('teams-disconnect-confirm-7'));
    await waitFor(() => expect(teamsAdminAPI.disconnect).toHaveBeenCalledWith([7]));
    expect(await screen.findByText(/Adrian Lo is disconnected/)).toBeInTheDocument();
  });

  test('"Keep" backs out without a call', async () => {
    teamsAdminAPI.status.mockResolvedValue({ data: STATUS });
    teamsAdminAPI.disconnect.mockClear();
    render(<TeamsSettingsPanel />);
    fireEvent.click(await screen.findByTestId('teams-disconnect-7'));
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(teamsAdminAPI.disconnect).not.toHaveBeenCalled();
    expect(screen.getByTestId('teams-disconnect-7')).toBeInTheDocument();
  });

  test('"Reinstall" on a connected agent asks for that one person and says when the app was put back', async () => {
    teamsAdminAPI.status.mockResolvedValue({ data: STATUS });
    teamsAdminAPI.install.mockResolvedValue({ data: { connected: 1, reinstalled: 1, failed: [], skippedDisconnected: 0 } });
    render(<TeamsSettingsPanel />);
    fireEvent.click(await screen.findByTestId('teams-reinstall-7'));
    await waitFor(() => expect(teamsAdminAPI.install).toHaveBeenCalledWith({ technicianIds: [7] }));
    expect(await screen.findByText(/the app was put back for 1/)).toBeInTheDocument();
    expect(screen.queryByTestId('teams-reinstall-8')).toBeNull();
  });

  test('a disconnected agent says so and offers "Connect again"', async () => {
    teamsAdminAPI.status.mockResolvedValue({ data: STATUS });
    render(<TeamsSettingsPanel />);
    expect(await screen.findByText(/Disconnected by vhaeri@x.com/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect again' })).toBeInTheDocument();
    expect(screen.queryByTestId('teams-disconnect-8')).toBeNull();
  });
});

// MEGA 11-14 Part C: a status per person, and a count of who cannot get cards at the top.
describe('Teams settings: who is blocked', () => {
  const WITH_STATUS = {
    ...STATUS,
    agents: [
      { id: 7, name: 'Alex Rivera', email: 'alex@example.com', connected: true, disconnected: false, status: 'connected', missed7d: 0 },
      { id: 8, name: 'Sam Ortiz', email: 'sam@example.com', connected: false, disconnected: false, status: 'blocked', lastError: 'App is blocked by app permission policy. TenantId: x', lastBlockedAt: '2026-11-13T22:53:12Z', missed7d: 12, backoffUntil: null },
      { id: 9, name: 'Jo Park', email: 'jo@example.com', connected: false, disconnected: false, status: 'blocked', lastBlockedAt: '2026-11-12T18:54:17Z', missed7d: 3, backoffUntil: '2026-11-13T18:54:17Z' },
      { id: 10, name: 'Kim Lee', email: 'kim@example.com', connected: false, disconnected: true, disconnectedBy: 'admin@example.com', status: 'disconnected', missed7d: 4 },
      { id: 11, name: 'Pat Ruiz', email: 'pat@example.com', connected: false, disconnected: false, status: 'not_connected', lastError: 'timeout of 15000ms exceeded' },
    ],
    health: { blocked: 2, disconnected: 1, notConnected: 1 },
  };

  test('the count at the top, and the list behind it', async () => {
    teamsAdminAPI.status.mockResolvedValue({ data: WITH_STATUS });
    render(<TeamsSettingsPanel />);
    const banner = await screen.findByTestId('teams-blocked-count');
    expect(banner).toHaveTextContent('2 people can’t get Teams cards');
    expect(banner).toHaveTextContent('Permission policies');
    expect(banner).toHaveTextContent('1 more is disconnected.');
    expect(screen.getAllByRole('listitem').filter((li) => li.closest('[aria-label="Agents and their Teams status"]'))).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Show them' }));
    const rows = screen.getAllByRole('listitem').filter((li) => li.closest('[aria-label="Agents and their Teams status"]'));
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('Sam Ortiz'), expect.stringContaining('Jo Park')]);
    expect(screen.getByRole('button', { name: 'Show everyone' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('each row says its status: blocked with the last refusal and the cards missed', async () => {
    teamsAdminAPI.status.mockResolvedValue({ data: WITH_STATUS });
    render(<TeamsSettingsPanel />);
    const sam = await screen.findByTestId('teams-status-8');
    expect(sam).toHaveTextContent('Blocked by Teams policy');
    expect(sam).toHaveTextContent('Last refused Fri 13 Nov, 2:53 PM · 12 cards missed in 7 days');
    expect(sam).not.toHaveTextContent('TenantId'); // the raw Graph error is not shown for blocked people
    expect(screen.getByTestId('teams-status-9')).toHaveTextContent('Ticket Pulse tries again Fri 13 Nov, 10:54 AM');
    expect(screen.getByTestId('teams-status-7')).toHaveTextContent('Connected');
    expect(screen.getByTestId('teams-status-10')).toHaveTextContent('Disconnected by admin@example.com4 cards not sent in 7 days');
    expect(screen.getByTestId('teams-status-11')).toHaveTextContent('Not connected yettimeout of 15000ms exceeded');
  });

  test('nobody blocked: no count line', async () => {
    teamsAdminAPI.status.mockResolvedValue({ data: STATUS });
    render(<TeamsSettingsPanel />);
    await screen.findByTestId('teams-status-7');
    expect(screen.queryByTestId('teams-blocked-count')).toBeNull();
  });
});

// QA 11-10 #1: the workspace default for "new unassigned ticket in my groups" gets a priority floor.
describe('Teams settings: priority for new unassigned tickets', () => {
  const GROUP_EVENT = { key: 'group_unassigned', label: 'A new unassigned ticket arrives in my groups', group: 'My team', mode: 'off' };
  const withDefaults = (defaults) => ({ ...STATUS, agents: [], events: [GROUP_EVENT], settings: { ...STATUS.settings, defaults } });

  test('hidden while the notice is Off', async () => {
    teamsAdminAPI.status.mockResolvedValue({ data: withDefaults({ events: {}, options: {} }) });
    render(<TeamsSettingsPanel />);
    await screen.findByText('A new unassigned ticket arrives in my groups');
    expect(screen.queryByLabelText('Priority for new unassigned tickets')).toBeNull();
  });

  test('shown when on; defaults to High and above; a change saves the workspace option', async () => {
    const defaults = { events: { group_unassigned: 'teams' }, options: {} };
    teamsAdminAPI.status.mockResolvedValue({ data: withDefaults(defaults) });
    teamsAdminAPI.saveSettings.mockResolvedValue({ data: { ...STATUS.settings, defaults: { ...defaults, options: { groupMinPriority: 1 } } } });
    render(<TeamsSettingsPanel />);
    const select = await screen.findByLabelText('Priority for new unassigned tickets');
    expect(select).toHaveValue('3');
    expect(screen.getByText(/Goes to the active agents in the ticket.s group/)).toBeInTheDocument();
    fireEvent.change(select, { target: { value: '1' } });
    await waitFor(() => expect(teamsAdminAPI.saveSettings).toHaveBeenCalledWith({ defaults: { events: { group_unassigned: 'teams' }, options: { groupMinPriority: 1 } } }));
  });
});
