/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import TeamsAssistantSettings from './TeamsAssistantSettings';

const teamsAdminAPI = vi.hoisted(() => ({ getAssistant: vi.fn(), saveAssistant: vi.fn(), assistantTurns: vi.fn() }));
vi.mock('../../services/api', () => ({ teamsAdminAPI }));

const SETTINGS = { workspaceId: 1, mode: 'shadow', pilotEmails: ['sam.ortiz@example.com'], monthlyCapUsd: 25, sensitive: false };
const PEOPLE = [{ email: 'alex.rivera@example.com', name: 'Alex Rivera' }, { email: 'sam.ortiz@example.com', name: 'Sam Ortiz' }];

afterEach(cleanup);

describe('TeamsAssistantSettings', () => {
  beforeEach(() => {
    teamsAdminAPI.getAssistant.mockResolvedValue({ data: { settings: SETTINGS, spend: { spentUsd: 0.42, capUsd: 25 }, people: PEOPLE, canSeeActivity: true } });
    teamsAdminAPI.saveAssistant.mockImplementation(async (patch) => ({ data: { ...SETTINGS, ...patch } }));
    teamsAdminAPI.assistantTurns.mockResolvedValue({ data: [{ id: 1, email: 'alex.rivera@example.com', mode: 'shadow', question: 'my overdue stuff', lead: 'You have 1 overdue ticket.', replySummary: 'Overdue — 1', outcome: 'answered', tools: ['my_tickets'], createdAt: '2026-11-05T17:14:00Z' }] });
  });

  it('the mode is a pick-list (Off / Shadow / Pilot / On), saved on change', async () => {
    render(<TeamsAssistantSettings />);
    const select = await screen.findByLabelText('Mode');
    expect([...select.options].map((o) => o.textContent)).toEqual(['Off', 'Shadow', 'Pilot', 'On']);
    expect(select.value).toBe('shadow');
    fireEvent.change(select, { target: { value: 'pilot' } });
    await waitFor(() => expect(teamsAdminAPI.saveAssistant).toHaveBeenCalledWith({ mode: 'pilot' }));
    expect(await screen.findByText('They get real AI answers now.')).toBeInTheDocument();
  });

  it('the pilot list is a people picker: add by name, remove by button', async () => {
    render(<TeamsAssistantSettings />);
    expect(await screen.findByText('Sam Ortiz')).toBeInTheDocument();
    const input = screen.getByRole('combobox', { name: 'Add a person to the pilot' });
    fireEvent.change(input, { target: { value: 'ale' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(teamsAdminAPI.saveAssistant).toHaveBeenCalledWith({ pilotEmails: ['sam.ortiz@example.com', 'alex.rivera@example.com'] }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sam Ortiz from the pilot' }));
    await waitFor(() => expect(teamsAdminAPI.saveAssistant).toHaveBeenLastCalledWith({ pilotEmails: expect.not.arrayContaining(['sam.ortiz@example.com']) }));
  });

  it('the monthly limit shows this month\'s spend and saves a new limit', async () => {
    render(<TeamsAssistantSettings />);
    expect(await screen.findByTestId('teams-assistant-spend')).toHaveTextContent('This month: $0.42 of $25.00');
    fireEvent.change(screen.getByLabelText('Monthly AI limit'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limit' }));
    await waitFor(() => expect(teamsAdminAPI.saveAssistant).toHaveBeenCalledWith({ monthlyCapUsd: 40 }));
  });

  it('super admins can open the latest questions (the Shadow log)', async () => {
    render(<TeamsAssistantSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /Latest questions/ }));
    expect(await screen.findByText('my overdue stuff')).toBeInTheDocument();
    expect(screen.getByText('AI would have said:')).toBeInTheDocument();
  });

  it('renders nothing when the server does not have the assistant yet', async () => {
    teamsAdminAPI.getAssistant.mockRejectedValueOnce(Object.assign(new Error('Not found'), { response: { data: { message: 'Not found' } } }));
    render(<TeamsAssistantSettings />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Not found');
  });
});
