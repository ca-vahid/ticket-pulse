/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// QA 11-17 #2-#4: Settings → Teams gets digest times and two switches. Invented names.
const EVENTS = [
  { key: 'assigned', label: 'A ticket is assigned to me', group: 'My tickets', mode: 'teams' },
  // QA 11-19 #1: always offered (own tickets), Teams by default; the switch only adds admins' "Everyone's".
  { key: 'survey_result', label: 'A survey result comes in', group: 'Surveys', mode: 'teams' },
  { key: 'on_call_start', label: "I'm on call this week", group: 'On call', mode: 'teams', modes: ['teams', 'off'], offeredBy: 'onCallNotice' },
];
const settings = (over = {}) => ({
  teamsEnabled: true, channelWebhookUrl: '', channelMinPriority: 3, defaults: { events: {}, options: {} },
  digestTimes: ['08:00'], onCallNotice: false, surveyResults: false, ...over,
});
const status = (over = {}) => ({
  bot: { configured: true, botToken: true, graphToken: true, catalogAppId: 'cat-1', appId: 'app-0000' },
  settings: settings(over),
  events: EVENTS,
  agents: [{ id: 7, name: 'Dana Fox', email: 'dana.fox@example.com', connected: true, disconnected: false, status: 'connected' }],
  last24h: {},
});
const teamsAdminAPI = vi.hoisted(() => ({
  status: vi.fn(), saveSettings: vi.fn(), install: vi.fn(), disconnect: vi.fn(), packageUrl: () => '/downloads/x.zip',
}));
vi.mock('../../services/api', () => ({ teamsAdminAPI }));
vi.mock('./TeamsAssistantSettings', () => ({ default: () => null }));

const { default: TeamsSettingsPanel } = await import('./TeamsSettingsPanel.jsx');

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('Digest times', () => {
  test('today\'s single time is the first entry, in plain words', async () => {
    teamsAdminAPI.status.mockResolvedValue({ data: status() });
    render(<TeamsSettingsPanel />);
    const list = await screen.findByTestId('teams-digest-times');
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringContaining('8:00 AM PT · daily digest, the default for everyone')]);
    expect(within(list).queryByRole('button', { name: /Remove/ })).toBeNull();
  });

  test('add 3:00 PM PT', async () => {
    teamsAdminAPI.status.mockResolvedValue({ data: status() });
    teamsAdminAPI.saveSettings.mockResolvedValue({ data: settings({ digestTimes: ['08:00', '15:00'] }) });
    render(<TeamsSettingsPanel />);
    const input = await screen.findByLabelText('New digest time');
    fireEvent.change(input, { target: { value: '15:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(teamsAdminAPI.saveSettings).toHaveBeenCalledWith({ digestTimes: ['08:00', '15:00'] }));
    expect(await screen.findByText('3:00 PM PT')).toBeInTheDocument();
    expect(screen.getByText('Digest at 3:00 PM PT added')).toBeInTheDocument();
  });

  test('remove an extra time; at four there is no Add', async () => {
    teamsAdminAPI.status.mockResolvedValue({ data: status({ digestTimes: ['08:00', '09:00', '12:00', '15:00'] }) });
    teamsAdminAPI.saveSettings.mockResolvedValue({ data: settings({ digestTimes: ['08:00', '09:00', '12:00'] }) });
    render(<TeamsSettingsPanel />);
    expect(await screen.findByText(/That.s the most: 4 times a day/)).toBeInTheDocument();
    expect(screen.queryByLabelText('New digest time')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove 3:00 PM PT' }));
    await waitFor(() => expect(teamsAdminAPI.saveSettings).toHaveBeenCalledWith({ digestTimes: ['08:00', '09:00', '12:00'] }));
  });

  test('change the daily time', async () => {
    teamsAdminAPI.status.mockResolvedValue({ data: status({ digestTimes: ['08:00', '15:00'] }) });
    teamsAdminAPI.saveSettings.mockResolvedValue({ data: settings({ digestTimes: ['09:00', '15:00'] }) });
    render(<TeamsSettingsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change' }));
    fireEvent.change(screen.getByLabelText('Daily digest time'), { target: { value: '09:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save the daily digest time' }));
    await waitFor(() => expect(teamsAdminAPI.saveSettings).toHaveBeenCalledWith({ digestTimes: ['09:00', '15:00'] }));
  });
});

describe('On-call and survey switches', () => {
  test('both off by default; on-call stays out of the defaults grid, survey results are always in it (Teams)', async () => {
    teamsAdminAPI.status.mockResolvedValue({ data: status() });
    render(<TeamsSettingsPanel />);
    const onCall = await screen.findByRole('switch', { name: 'Tell the person on call when their on-call week starts' });
    expect(onCall).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: 'Let admins get everyone’s survey results' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByText("I'm on call this week")).toBeNull();
    const survey = screen.getByRole('radiogroup', { name: 'A survey result comes in' });
    expect(within(survey).getByRole('radio', { name: 'Teams' })).toHaveAttribute('aria-checked', 'true');
  });

  test('turning on the on-call switch saves it and shows the row (Teams / Off)', async () => {
    teamsAdminAPI.status.mockResolvedValue({ data: status() });
    teamsAdminAPI.saveSettings.mockResolvedValue({ data: settings({ onCallNotice: true }) });
    render(<TeamsSettingsPanel />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Tell the person on call when their on-call week starts' }));
    await waitFor(() => expect(teamsAdminAPI.saveSettings).toHaveBeenCalledWith({ onCallNotice: true }));
    const group = await screen.findByRole('radiogroup', { name: "I'm on call this week" });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Teams', 'Off']);
  });

  test('QA 11-19 #1: the survey switch is about admins and everyone\'s results, in those words', async () => {
    teamsAdminAPI.status.mockResolvedValue({ data: status() });
    teamsAdminAPI.saveSettings.mockResolvedValue({ data: settings({ surveyResults: true }) });
    render(<TeamsSettingsPanel />);
    const sw = await screen.findByRole('switch', { name: 'Let admins get everyone’s survey results' });
    expect(screen.queryByText('Offer survey result notices')).toBeNull();
    expect(screen.getByText(/Agents always get “A survey result comes in” for tickets they handled/)).toBeInTheDocument();
    expect(screen.getByText(/workspace admins can also choose everyone’s results/)).toBeInTheDocument();
    expect(screen.queryByText(/reviewers/i)).toBeNull();
    fireEvent.click(sw);
    await waitFor(() => expect(teamsAdminAPI.saveSettings).toHaveBeenCalledWith({ surveyResults: true }));
    expect(await screen.findByText('Admins can now choose everyone’s survey results')).toBeInTheDocument();
    // The row was there before and is still there: one row, Teams.
    expect(screen.getAllByRole('radiogroup', { name: 'A survey result comes in' })).toHaveLength(1);
  });
});

describe('QA 11-19 #1: the defaults grid shows the effective default', () => {
  const surveyMode = async () => {
    const group = await screen.findByRole('radiogroup', { name: 'A survey result comes in' });
    return within(group).getAllByRole('radio').find((r) => r.getAttribute('aria-checked') === 'true').textContent;
  };

  test('a carried workspace default Off from the old row shows Off, not Teams', async () => {
    teamsAdminAPI.status.mockResolvedValue({ data: status({ defaults: { events: { survey_response: 'off' }, options: {} } }) });
    render(<TeamsSettingsPanel />);
    expect(await surveyMode()).toBe('Off');
  });

  test('the server\'s computed default wins when the payload has one', async () => {
    teamsAdminAPI.status.mockResolvedValue({ data: status({ defaults: { events: {}, options: {} }, effectiveDefaults: { survey_result: 'digest' } }) });
    render(<TeamsSettingsPanel />);
    expect(await surveyMode()).toBe('Digest');
  });

  test('the mirrored rule: the new row\'s own default beats the old row; nothing saved is Teams', async () => {
    const { effectiveDefault } = await import('./teamsEffectiveDefault.js');
    const row = EVENTS[1];
    expect(effectiveDefault(row, { events: { survey_result: 'teams', survey_response: 'off' } })).toBe('teams');
    expect(effectiveDefault(row, { events: { survey_response: 'digest' } })).toBe('digest');
    expect(effectiveDefault(row, { events: {} })).toBe('teams');
    expect(effectiveDefault(row, { events: { survey_response: 'nope' } })).toBe('teams');
    // A row with no retired predecessor ignores old keys.
    expect(effectiveDefault(EVENTS[0], { events: { survey_response: 'off' } })).toBe('teams');
  });
});
