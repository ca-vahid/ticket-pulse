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

  test('a disconnected agent says so and offers "Connect again"', async () => {
    teamsAdminAPI.status.mockResolvedValue({ data: STATUS });
    render(<TeamsSettingsPanel />);
    expect(await screen.findByText(/Disconnected by vhaeri@x.com/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect again' })).toBeInTheDocument();
    expect(screen.queryByTestId('teams-disconnect-8')).toBeNull();
  });
});
