/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// QA 11-17 #2-#4: Settings → Teams gets digest times and two switches. Invented names.
const EVENTS = [
  { key: 'assigned', label: 'A ticket is assigned to me', group: 'My tickets', mode: 'teams' },
  { key: 'survey_result', label: 'A survey result comes in', group: 'Surveys', mode: 'off', offeredBy: 'surveyResults' },
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
  test('both off by default; the rows they offer stay out of the defaults grid', async () => {
    teamsAdminAPI.status.mockResolvedValue({ data: status() });
    render(<TeamsSettingsPanel />);
    const onCall = await screen.findByRole('switch', { name: 'Tell the person on call when their on-call week starts' });
    expect(onCall).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: 'Offer survey result notices' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByText("I'm on call this week")).toBeNull();
    expect(screen.queryByText('A survey result comes in')).toBeNull();
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

  test('turning on survey results saves it and offers the row, off by default', async () => {
    teamsAdminAPI.status.mockResolvedValue({ data: status() });
    teamsAdminAPI.saveSettings.mockResolvedValue({ data: settings({ surveyResults: true }) });
    render(<TeamsSettingsPanel />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Offer survey result notices' }));
    await waitFor(() => expect(teamsAdminAPI.saveSettings).toHaveBeenCalledWith({ surveyResults: true }));
    const group = await screen.findByRole('radiogroup', { name: 'A survey result comes in' });
    expect(within(group).getByRole('radio', { name: 'Off' })).toHaveAttribute('aria-checked', 'true');
  });
});
