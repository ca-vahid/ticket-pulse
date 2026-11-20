/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import TeamsNotificationsPanel from './TeamsNotificationsPanel';
import { agentAPI } from '../../services/api';

// QA 11-19 #1: one survey row, "Everyone's" for admins only. Invented names.
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

const SURVEY = { key: 'survey_result', label: 'A survey result comes in', group: 'Surveys', mode: 'teams', workspaceDefault: 'teams' };
const OLD_ROW = { key: 'survey_response', label: 'The requester rates my ticket in the survey', group: 'My tickets', mode: 'teams', workspaceDefault: 'teams' };
const status = (over = {}, options = {}) => ({
  configured: true,
  enabled: true,
  connection: { connected: true, status: 'connected' },
  events: [{ key: 'assigned', label: 'A ticket is assigned to me', group: 'My tickets', mode: 'teams', workspaceDefault: 'teams' }, SURVEY],
  options: { respectAway: true, urgentBypassesQuiet: true, groupMinPriority: 3, dailyDigest: false, digestTime: '09:00', requesterTeamsChat: false, digestSlots: [], surveyScope: 'mine', ...options },
  digestTimes: ['09:00'],
  surveyScopeChoice: false,
  mutes: [],
  recent: [],
  ...over,
});

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('QA 11-19 #1: one survey row', () => {
  test('the panel shows "A survey result comes in" once and never the old row', async () => {
    agentAPI.getTeams.mockResolvedValue({ data: status() });
    render(<TeamsNotificationsPanel />);
    expect(await screen.findAllByRole('radiogroup', { name: 'A survey result comes in' })).toHaveLength(1);
    expect(screen.queryByText('The requester rates my ticket in the survey')).toBeNull();
  });

  test('a server that still lists the old row does not bring it back', async () => {
    agentAPI.getTeams.mockResolvedValue({ data: status({ events: [OLD_ROW, SURVEY] }) });
    render(<TeamsNotificationsPanel />);
    await screen.findByText('A survey result comes in');
    expect(screen.queryByText('The requester rates my ticket in the survey')).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'The requester rates my ticket in the survey' })).toBeNull();
  });

  test('Teams by default, with no workspace default line', async () => {
    agentAPI.getTeams.mockResolvedValue({ data: status() });
    render(<TeamsNotificationsPanel />);
    const group = await screen.findByRole('radiogroup', { name: 'A survey result comes in' });
    expect(within(group).getByRole('radio', { name: 'Teams' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByText(/Workspace default/)).toBeNull();
  });

  test('a stored "Everyone\'s" that no longer counts (not an admin) shows Mine: no choice, own tickets only', async () => {
    agentAPI.getTeams.mockResolvedValue({ data: status({ surveyScopeChoice: false }, { surveyScope: 'all' }) });
    render(<TeamsNotificationsPanel />);
    expect(await screen.findByText(/for tickets you handled/)).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Whose results' })).toBeNull();
    expect(screen.queryByText('Everyone’s')).toBeNull();
  });

  test('an admin (with the workspace switch on) sees the stored Everyone\'s', async () => {
    agentAPI.getTeams.mockResolvedValue({ data: status({ surveyScopeChoice: true }, { surveyScope: 'all' }) });
    render(<TeamsNotificationsPanel />);
    const group = await screen.findByRole('radiogroup', { name: 'Whose results' });
    expect(within(group).getByRole('radio', { name: 'Everyone’s' })).toHaveAttribute('aria-checked', 'true');
  });
});
