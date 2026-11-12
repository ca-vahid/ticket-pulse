/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TeamsNotificationsPanel from './TeamsNotificationsPanel';
import { agentAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  agentAPI: {
    getTeams: vi.fn(),
    saveTeamsPreferences: vi.fn(),
    connectTeams: vi.fn(),
    sendTeamsTest: vi.fn(),
    unmuteTeamsTicket: vi.fn(),
  },
}));

const status = (options = {}) => ({
  configured: true,
  enabled: false,
  connection: { connected: false, disconnected: false, installedAt: null, lastError: null },
  events: [{ key: 'assigned', label: 'A ticket is assigned to me', group: 'My tickets', mode: 'teams', workspaceDefault: 'teams' }],
  options: { respectAway: true, urgentBypassesQuiet: true, groupMinPriority: 3, dailyDigest: false, digestTime: '08:00', requesterTeamsChat: false, ...options },
  mutes: [],
  recent: [],
});

const SWITCH = /Let requesters start a Teams chat with me from the urgency page/;

// QA 10-15 #5: the requester Teams chat opt-in.
describe('TeamsNotificationsPanel — requester Teams chat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  test('off by default, and shown even when Teams is not connected', async () => {
    agentAPI.getTeams.mockResolvedValue({ data: status() });
    render(<TeamsNotificationsPanel />);
    const box = await screen.findByRole('checkbox', { name: SWITCH });
    expect(box).not.toBeChecked();
    expect(screen.getByText('Not connected yet')).toBeInTheDocument();
    expect(screen.getByText(/Off until you turn it on/)).toBeInTheDocument();
  });

  test('turning it on saves requesterTeamsChat: true', async () => {
    agentAPI.getTeams.mockResolvedValue({ data: status() });
    agentAPI.saveTeamsPreferences.mockResolvedValue({ data: status({ requesterTeamsChat: true }) });
    render(<TeamsNotificationsPanel />);
    fireEvent.click(await screen.findByRole('checkbox', { name: SWITCH }));
    await waitFor(() => expect(agentAPI.saveTeamsPreferences).toHaveBeenCalled(), { timeout: 2000 });
    expect(agentAPI.saveTeamsPreferences.mock.calls[0][0].options).toEqual(expect.objectContaining({ requesterTeamsChat: true }));
    expect(screen.getByRole('checkbox', { name: SWITCH })).toBeChecked();
  });
});

// QA 11-10 #1: the panel names the workspace it shows, and says when the person
// is not an agent in the workspace on screen.
describe('TeamsNotificationsPanel — which workspace', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  test('asks for the workspace on screen and names it', async () => {
    agentAPI.getTeams.mockResolvedValue({ data: { ...status(), workspace: { id: 5, name: 'Project Accounting' }, notAgentIn: null } });
    render(<TeamsNotificationsPanel workspaceId={5} />);
    expect(await screen.findByText('Settings for Project Accounting')).toBeInTheDocument();
    expect(agentAPI.getTeams).toHaveBeenCalledWith({ workspaceId: 5 });
    expect(screen.queryByText(/not an active agent/)).not.toBeInTheDocument();
  });

  test('not an agent there: shows their own workspace and tells them what to do', async () => {
    agentAPI.getTeams.mockResolvedValue({ data: { ...status(), workspace: { id: 1, name: 'IT' }, notAgentIn: { id: 5, name: 'Project Accounting' } } });
    render(<TeamsNotificationsPanel workspaceId={5} />);
    expect(await screen.findByText('Settings for IT')).toBeInTheDocument();
    expect(screen.getByText(/not an active agent in Project Accounting, so these don.t apply there. Switch workspace to change yours/)).toBeInTheDocument();
  });
});
