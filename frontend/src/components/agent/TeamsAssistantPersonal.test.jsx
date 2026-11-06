/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import TeamsAssistantPersonal from './TeamsAssistantPersonal';

const agentAPI = vi.hoisted(() => ({ getTeamsAssistant: vi.fn(), saveTeamsAssistant: vi.fn() }));
vi.mock('../../services/api', () => ({ agentAPI }));

const turns = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, question: `Question ${i + 1}`, answer: `Answer ${i + 1}`, at: '2026-11-05T17:14:00Z' }));

afterEach(cleanup);

describe('TeamsAssistantPersonal', () => {
  beforeEach(() => {
    agentAPI.getTeamsAssistant.mockResolvedValue({ data: { enabled: true, turns, retentionDays: 180 } });
    agentAPI.saveTeamsAssistant.mockImplementation(async ({ enabled }) => ({ data: { enabled, turns, retentionDays: 180 } }));
  });

  it('shows the switch on by default, and the person\'s own questions in Pacific time', async () => {
    render(<TeamsAssistantPersonal />);
    const sw = await screen.findByRole('switch', { name: 'Ask Ticket Pulse in Teams (advanced)' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Question 1')).toBeInTheDocument();
    expect(screen.getByText('Answer 1')).toBeInTheDocument();
    expect(screen.getAllByText('Thu 5 Nov, 9:14 AM')).toHaveLength(5);
    expect(screen.queryByText('Question 6')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 7' }));
    expect(screen.getByText('Question 7')).toBeInTheDocument();
  });

  it('anyone can switch it off for themselves', async () => {
    render(<TeamsAssistantPersonal />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Ask Ticket Pulse in Teams (advanced)' }));
    await waitFor(() => expect(agentAPI.saveTeamsAssistant).toHaveBeenCalledWith({ enabled: false }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Ask Ticket Pulse in Teams (advanced)' })).toHaveAttribute('aria-checked', 'false'));
  });

  it('a failed save puts the switch back and says so', async () => {
    agentAPI.saveTeamsAssistant.mockRejectedValueOnce(new Error('Server said no'));
    render(<TeamsAssistantPersonal />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Ask Ticket Pulse in Teams (advanced)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Server said no');
    expect(screen.getByRole('switch', { name: 'Ask Ticket Pulse in Teams (advanced)' })).toHaveAttribute('aria-checked', 'true');
  });

  it('an empty history says what will appear', async () => {
    agentAPI.getTeamsAssistant.mockResolvedValue({ data: { enabled: true, turns: [], retentionDays: 180 } });
    render(<TeamsAssistantPersonal />);
    expect(await screen.findByText(/Questions you ask the bot in Teams show here/)).toBeInTheDocument();
  });
});
