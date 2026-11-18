/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import TeamsNotificationsPanel from './TeamsNotificationsPanel';
import { agentAPI } from '../../services/api';
import { digestTimeLabel } from './digestTimes';

vi.mock('../../services/api', () => ({
  agentAPI: {
    getTeams: vi.fn(),
    saveTeamsPreferences: vi.fn(),
    connectTeams: vi.fn(),
    sendTeamsTest: vi.fn(),
    unmuteTeamsTicket: vi.fn(),
  },
}));
vi.mock('./TeamsAssistantPersonal', () => ({ default: () => null }));

const status = (over = {}, options = {}) => ({
  configured: true,
  enabled: true,
  connection: { connected: true, status: 'connected' },
  events: [{ key: 'group_unassigned', label: 'A new unassigned ticket arrives in my groups', group: 'My team', mode: 'digest', workspaceDefault: 'off' }],
  options: { respectAway: true, urgentBypassesQuiet: true, groupMinPriority: 3, dailyDigest: false, digestTime: '09:00', requesterTeamsChat: false, digestSlots: [], surveyScope: 'mine', ...options },
  digestTimes: ['09:00'],
  surveyScopeChoice: false,
  mutes: [],
  recent: [],
  ...over,
});

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('QA 11-17 #2: extra digest times', () => {
  test('labels read "3:00 PM PT"', () => {
    expect(digestTimeLabel('15:00')).toBe('3:00 PM PT');
    expect(digestTimeLabel('09:00')).toBe('9:00 AM PT');
    expect(digestTimeLabel('nope')).toBe('');
  });

  test('one switch per extra workspace time, off by default; turning it on saves digestSlots', async () => {
    agentAPI.getTeams.mockResolvedValue({ data: status({ digestTimes: ['09:00', '15:00'] }) });
    agentAPI.saveTeamsPreferences.mockResolvedValue({ data: status({ digestTimes: ['09:00', '15:00'] }, { digestSlots: ['15:00'] }) });
    render(<TeamsNotificationsPanel />);
    const sw = await screen.findByRole('switch', { name: 'Also send my digest at 3:00 PM PT' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    // The first time is the daily digest, not a switch.
    expect(screen.queryByRole('switch', { name: /9:00 AM PT/ })).toBeNull();
    fireEvent.click(sw);
    await waitFor(() => expect(agentAPI.saveTeamsPreferences).toHaveBeenCalled(), { timeout: 2000 });
    expect(agentAPI.saveTeamsPreferences.mock.calls[0][0].options.digestSlots).toEqual(['15:00']);
    expect(screen.getByRole('switch', { name: 'Also send my digest at 3:00 PM PT' })).toHaveAttribute('aria-checked', 'true');
  });

  test('a workspace with one digest time shows no extra switches', async () => {
    agentAPI.getTeams.mockResolvedValue({ data: status() });
    render(<TeamsNotificationsPanel />);
    await screen.findByText('A new unassigned ticket arrives in my groups');
    expect(screen.queryByTestId('teams-extra-digests')).toBeNull();
  });
});

describe('QA 11-17 #3: "I\'m on call this week"', () => {
  test('Teams or Off only, and it says it comes through quiet hours', async () => {
    agentAPI.getTeams.mockResolvedValue({ data: status({ events: [{ key: 'on_call_start', label: "I'm on call this week", group: 'On call', mode: 'teams', modes: ['teams', 'off'] }] }) });
    render(<TeamsNotificationsPanel />);
    const group = await screen.findByRole('radiogroup', { name: "I'm on call this week" });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Teams', 'Off']);
    expect(screen.getByText(/comes through quiet hours and outside your work hours/)).toBeInTheDocument();
  });
});

describe('QA 11-17 #4: "A survey result comes in"', () => {
  const SURVEY = { key: 'survey_result', label: 'A survey result comes in', group: 'Surveys', mode: 'teams', workspaceDefault: 'off' };

  test('an agent hears about tickets they handled; no Mine/Everyone\'s choice', async () => {
    agentAPI.getTeams.mockResolvedValue({ data: status({ events: [SURVEY] }) });
    render(<TeamsNotificationsPanel />);
    expect(await screen.findByText(/for tickets you handled/)).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Whose results' })).toBeNull();
  });

  test('an admin picks Everyone\'s and it saves', async () => {
    agentAPI.getTeams.mockResolvedValue({ data: status({ events: [SURVEY], surveyScopeChoice: true }) });
    agentAPI.saveTeamsPreferences.mockResolvedValue({ data: status({ events: [SURVEY], surveyScopeChoice: true }, { surveyScope: 'all' }) });
    render(<TeamsNotificationsPanel />);
    const group = await screen.findByRole('radiogroup', { name: 'Whose results' });
    expect(within(group).getByRole('radio', { name: 'Mine' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(group).getByRole('radio', { name: 'Everyone’s' }));
    await waitFor(() => expect(agentAPI.saveTeamsPreferences).toHaveBeenCalled(), { timeout: 2000 });
    expect(agentAPI.saveTeamsPreferences.mock.calls[0][0].options.surveyScope).toBe('all');
  });

  test('the choice hides while the row is Off', async () => {
    agentAPI.getTeams.mockResolvedValue({ data: status({ events: [{ ...SURVEY, mode: 'off' }], surveyScopeChoice: true }) });
    render(<TeamsNotificationsPanel />);
    await screen.findByText('A survey result comes in');
    expect(screen.queryByRole('radiogroup', { name: 'Whose results' })).toBeNull();
  });
});
