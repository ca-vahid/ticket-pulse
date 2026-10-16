/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PublicTicketUrgency from './PublicTicketUrgency';
import { publicTicketUrgencyAPI } from '../services/api';

vi.mock('../services/api', () => ({
  publicTicketUrgencyAPI: {
    get: vi.fn(),
    submit: vi.fn(),
    startTeamsChat: vi.fn(),
  },
}));

const TEAMS_URL = 'https://teams.microsoft.com/l/chat/0/0?users=sam.okafor%40bgc-example.com&message=About%20TP-10018';

const payload = (teamsChat) => ({
  status: 'available',
  available: true,
  reasons: [],
  alreadyUrgent: false,
  afterHours: { active: false },
  ticket: {
    id: 610,
    freshserviceTicketId: '330333',
    displayRef: 'TP-10018',
    subject: 'design software licence',
    status: 'Open',
    priority: 'Medium',
    assignedAgent: { name: 'Sam Okafor', photoUrl: null },
  },
  teamsChat,
  workspace: { id: 5, name: 'IT' },
  branding: { brandName: 'IT Helpdesk' },
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/ticket-urgency/tok-chat']}>
      <Routes>
        <Route path="/ticket-urgency/:token" element={<PublicTicketUrgency />} />
      </Routes>
    </MemoryRouter>,
  );
}

// QA 10-15 #5: Teams chat with the assigned agent on the urgency page.
describe('PublicTicketUrgency — Teams chat', () => {
  let openSpy;
  beforeEach(() => {
    vi.clearAllMocks();
    openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
  });
  afterEach(() => {
    openSpy.mockRestore();
    cleanup();
  });

  test('shows the TP number, not the FreshService one', async () => {
    publicTicketUrgencyAPI.get.mockResolvedValue({ data: payload({ available: false, agentName: null, reason: 'agent_not_opted_in' }) });
    renderPage();
    expect(await screen.findByText(/TP-10018/)).toBeInTheDocument();
    expect(screen.queryByText(/#330333/)).not.toBeInTheDocument();
  });

  test('hidden when the agent has not opted in', async () => {
    publicTicketUrgencyAPI.get.mockResolvedValue({ data: payload({ available: false, agentName: null, reason: 'agent_not_opted_in' }) });
    renderPage();
    await screen.findByText(/TP-10018/);
    expect(screen.queryByRole('button', { name: /in Teams/ })).not.toBeInTheDocument();
  });

  test('offered when available; opens Teams after the request succeeds', async () => {
    publicTicketUrgencyAPI.get.mockResolvedValue({ data: payload({ available: true, agentName: 'Sam Okafor', agentFirstName: 'Sam' }) });
    publicTicketUrgencyAPI.startTeamsChat.mockResolvedValue({ data: { available: true, agentName: 'Sam Okafor', url: TEAMS_URL } });
    renderPage();
    const button = await screen.findByRole('button', { name: 'Chat with Sam in Teams' });
    expect(screen.getByText('Opens Microsoft Teams with a message to the person working on your ticket.')).toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => expect(publicTicketUrgencyAPI.startTeamsChat).toHaveBeenCalledWith('tok-chat'));
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith(TEAMS_URL, '_blank', 'noopener,noreferrer'));
    expect(await screen.findByRole('status')).toHaveTextContent(/Teams is opening/);
    expect(screen.getByRole('link', { name: 'open the chat here' })).toHaveAttribute('href', TEAMS_URL);
  });

  test('refused by the server: says so and opens nothing', async () => {
    publicTicketUrgencyAPI.get.mockResolvedValue({ data: payload({ available: true, agentName: 'Sam Okafor', agentFirstName: 'Sam' }) });
    publicTicketUrgencyAPI.startTeamsChat.mockResolvedValue({ data: { available: false, reason: 'agent_not_opted_in', url: null } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Chat with Sam in Teams' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not available/);
    expect(openSpy).not.toHaveBeenCalledWith(expect.stringContaining('teams.microsoft.com'), expect.anything(), expect.anything());
  });
});
