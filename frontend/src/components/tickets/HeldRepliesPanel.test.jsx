/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import HeldRepliesPanel from './HeldRepliesPanel';
import { searchAPI, ticketsAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  ticketsAPI: {
    listHeldMessages: vi.fn(),
    attachHeldMessage: vi.fn(),
    createTicketFromHeld: vi.fn(),
    discardHeldMessage: vi.fn(),
  },
  searchAPI: { global: vi.fn() },
}));

const rows = [
  {
    id: 501, reason: 'unknown_reference', status: 'held', receivedAt: '2026-09-01T15:54:23Z',
    fromEmail: 'susan.xu@vendor.example', fromName: 'Susan Xu', toEmails: ['patickets@bgcengineering.ca'], ccEmails: ['boss@vendor.example'],
    subject: 'Re: Invoice question', snippet: 'Here is the receipt you asked for.', connectionAddress: 'patickets@bgcengineering.ca',
    bestGuessTicket: { id: 42, displayRef: 'TP-1204', subject: 'Invoice', status: 'Open' }, candidates: [],
  },
  {
    id: 502, reason: 'agent_reply_no_requester', status: 'held', receivedAt: '2026-09-01T15:58:16Z',
    fromEmail: 'ari@bgcengineering.ca', fromName: 'Ari Agent', toEmails: ['bob@bgcengineering.ca'], ccEmails: ['patickets@bgcengineering.ca'],
    subject: 'Re: laptop', snippet: 'On it.', connectionAddress: 'patickets@bgcengineering.ca',
    bestGuessTicket: null, candidates: ['alvina@vendor.example', 'bob@bgcengineering.ca'],
  },
];

function renderPanel(props = {}) {
  return render(<MemoryRouter><HeldRepliesPanel {...props} /></MemoryRouter>);
}

describe('HeldRepliesPanel (Phase RL, RL-4)', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  test('renders held rows with reason chips, From/To/Cc, subject, snippet, best-guess link and the agent guidance', async () => {
    ticketsAPI.listHeldMessages.mockResolvedValue({ data: rows, meta: { heldCount: 2 } });
    const onCountChange = vi.fn();
    renderPanel({ onCountChange });

    await waitFor(() => expect(screen.getByTestId('held-row-501')).toBeInTheDocument());
    expect(onCountChange).toHaveBeenCalledWith(2);
    const chips = screen.getAllByTestId('held-reason-chip').map((c) => c.textContent);
    expect(chips).toEqual(['Unknown reference', 'Agent reply, no requester']);
    const row = screen.getByTestId('held-row-501');
    expect(row).toHaveTextContent('Re: Invoice question');
    expect(row).toHaveTextContent('Susan Xu <susan.xu@vendor.example>');
    expect(row).toHaveTextContent('patickets@bgcengineering.ca');
    expect(row).toHaveTextContent('boss@vendor.example');
    expect(row).toHaveTextContent('Here is the receipt you asked for.');
    expect(screen.getByTestId('held-best-guess')).toHaveAttribute('href', '/tickets/42');
    expect(screen.getByTestId('held-best-guess')).toHaveTextContent('TP-1204');

    const guidance = screen.getByTestId('held-guidance');
    expect(guidance).toHaveTextContent(/Forward/);
    expect(guidance).toHaveTextContent(/Reply-all/);
    expect(guidance).toHaveTextContent(/Never.*Bcc/);
  });

  test('empty queue shows the empty state', async () => {
    ticketsAPI.listHeldMessages.mockResolvedValue({ data: [], meta: { heldCount: 0 } });
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('held-empty')).toBeInTheDocument());
  });

  test('"Attach to TP-1204" calls attachHeldMessage with the best-guess ticket and reloads', async () => {
    ticketsAPI.listHeldMessages.mockResolvedValueOnce({ data: rows, meta: { heldCount: 2 } }).mockResolvedValueOnce({ data: [rows[1]], meta: { heldCount: 1 } });
    ticketsAPI.attachHeldMessage.mockResolvedValue({ data: { ticket: { id: 42, displayRef: 'TP-1204' } } });
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('held-row-501')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Attach to TP-1204/ }));
    await waitFor(() => expect(ticketsAPI.attachHeldMessage).toHaveBeenCalledWith(501, 42));
    await waitFor(() => expect(screen.queryByTestId('held-row-501')).not.toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('Attached to TP-1204 as a reply.');
  });

  test('"Attach to ticket…" opens the typeahead; picking a search hit attaches to it', async () => {
    ticketsAPI.listHeldMessages.mockResolvedValue({ data: rows, meta: { heldCount: 2 } });
    searchAPI.global.mockResolvedValue({ data: { sections: { tickets: [{ id: 77, displayRef: 'TP-1177', subject: 'Laptop swap', status: 'Open', requesterName: 'Bob' }] } } });
    ticketsAPI.attachHeldMessage.mockResolvedValue({ data: {} });
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('held-row-502')).toBeInTheDocument());
    const row = screen.getByTestId('held-row-502');
    fireEvent.click(row.querySelector('button[class*="border-border"]'));
    const input = await screen.findByLabelText('Search tickets to attach to');
    fireEvent.change(input, { target: { value: 'laptop' } });
    await waitFor(() => expect(searchAPI.global).toHaveBeenCalledWith('laptop', 'tickets'));
    fireEvent.click(await screen.findByRole('button', { name: /TP-1177/ }));
    await waitFor(() => expect(ticketsAPI.attachHeldMessage).toHaveBeenCalledWith(502, 77));
  });

  test('agent_reply_no_requester rows get the "Create ticket for <address>" chooser; create passes the chosen requester', async () => {
    ticketsAPI.listHeldMessages.mockResolvedValue({ data: rows, meta: { heldCount: 2 } });
    ticketsAPI.createTicketFromHeld.mockResolvedValue({ data: { ticket: { id: 700, displayRef: 'TP-1300' } } });
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('held-row-502')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Create ticket for…/ }));
    const select = await screen.findByLabelText('Create ticket for');
    expect([...select.options].map((o) => o.value)).toEqual(['alvina@vendor.example', 'bob@bgcengineering.ca', 'ari@bgcengineering.ca']);
    fireEvent.change(select, { target: { value: 'alvina@vendor.example' } });
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() => expect(ticketsAPI.createTicketFromHeld).toHaveBeenCalledWith(502, { requesterEmail: 'alvina@vendor.example' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Created TP-1300 for alvina@vendor.example.'));
  });

  test('plain "Create ticket" (unknown_reference) sends no requester; Discard calls discardHeldMessage', async () => {
    ticketsAPI.listHeldMessages.mockResolvedValue({ data: rows, meta: { heldCount: 2 } });
    ticketsAPI.createTicketFromHeld.mockResolvedValue({ data: { ticket: { id: 701, displayRef: 'TP-1301' } } });
    ticketsAPI.discardHeldMessage.mockResolvedValue({ data: { id: 501, status: 'discarded' } });
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('held-row-501')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Create ticket$/ }));
    await waitFor(() => expect(ticketsAPI.createTicketFromHeld).toHaveBeenCalledWith(501, {}));
    fireEvent.click(screen.getByRole('button', { name: 'Discard held message 501' }));
    await waitFor(() => expect(ticketsAPI.discardHeldMessage).toHaveBeenCalledWith(501));
  });

  test('an API failure surfaces as an alert', async () => {
    ticketsAPI.listHeldMessages.mockResolvedValue({ data: rows, meta: { heldCount: 2 } });
    ticketsAPI.discardHeldMessage.mockRejectedValue({ response: { data: { message: 'This message was already attached' } } });
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('held-row-501')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Discard held message 501' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('already attached'));
  });
});
