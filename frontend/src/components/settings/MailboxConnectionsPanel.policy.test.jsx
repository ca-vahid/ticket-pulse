/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MailboxConnectionsPanel, { NEW_TICKET_POLICY_OPTIONS, capabilityChecks } from './MailboxConnectionsPanel';
import { ticketsAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  ticketsAPI: {
    listMailboxes: vi.fn(),
    createMailbox: vi.fn(),
    updateMailbox: vi.fn(),
    removeMailbox: vi.fn(),
    testMailbox: vi.fn(),
    meta: vi.fn().mockResolvedValue({ data: { groups: [] } }),
    listHeldMessages: vi.fn().mockResolvedValue({ data: [], meta: { heldCount: 0 } }),
    attachHeldMessage: vi.fn(),
    createTicketFromHeld: vi.fn(),
    discardHeldMessage: vi.fn(),
  },
  searchAPI: { global: vi.fn() },
}));
vi.mock('../../hooks/useTicketTypes', () => ({ useTicketTypes: () => ({ activeTypes: [] }) }));

const mailbox = { id: 2, address: 'patickets@example.com', mode: 'both', isEnabled: true, isPrimary: true, lastCheckedAt: null, lastError: null, newTicketPolicy: 'hold_unmatched', agentCcIntake: true };

function renderPanel() {
  return render(<MemoryRouter><MailboxConnectionsPanel /></MemoryRouter>);
}

describe('MailboxConnectionsPanel — Phase RL (policy, send lane, capability checks, hold queue)', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  test('policy selector round-trips: shows the stored policy, PATCHes a change, re-renders the new value', async () => {
    ticketsAPI.listMailboxes
      .mockResolvedValueOnce({ data: [mailbox], meta: { sendLane: null } })
      .mockResolvedValueOnce({ data: [{ ...mailbox, newTicketPolicy: 'replies_only' }], meta: { sendLane: null } });
    ticketsAPI.updateMailbox.mockResolvedValue({ data: { ...mailbox, newTicketPolicy: 'replies_only' } });
    renderPanel();

    const select = await screen.findByTestId('mailbox-policy-2');
    expect(select).toHaveValue('hold_unmatched');
    expect([...select.options].map((o) => o.value)).toEqual(NEW_TICKET_POLICY_OPTIONS.map((o) => o.value));
    fireEvent.change(select, { target: { value: 'replies_only' } });
    await waitFor(() => expect(ticketsAPI.updateMailbox).toHaveBeenCalledWith(2, { newTicketPolicy: 'replies_only' }));
    await waitFor(() => expect(screen.getByTestId('mailbox-policy-2')).toHaveValue('replies_only'));
    // plain-language help for every policy + the Cc-intake switch
    const help = screen.getByTestId('mailbox-policy-help');
    for (const o of NEW_TICKET_POLICY_OPTIONS) expect(help).toHaveTextContent(o.label);
    expect(help).toHaveTextContent(/Agent Cc creates tickets/);
  });

  test('agent Cc intake toggle PATCHes agentCcIntake', async () => {
    ticketsAPI.listMailboxes.mockResolvedValue({ data: [mailbox], meta: { sendLane: null } });
    ticketsAPI.updateMailbox.mockResolvedValue({ data: { ...mailbox, agentCcIntake: false } });
    renderPanel();
    const box = await screen.findByLabelText('Agent Cc intake for patickets@example.com');
    expect(box).toBeChecked();
    fireEvent.click(box);
    await waitFor(() => expect(ticketsAPI.updateMailbox).toHaveBeenCalledWith(2, { agentCcIntake: false }));
  });

  test('send lane not granted → red alert with the exact grant text', async () => {
    ticketsAPI.listMailboxes.mockResolvedValue({
      data: [mailbox],
      meta: { sendLane: { status: 'not_granted', errorClass: 'permission_denied', lastEventAt: '2026-09-01T16:10:00Z', permissionGrantText: 'Grant Mail.ReadWrite (application) to Ticket Pulse Backend (f3a49518-…)' } },
    });
    renderPanel();
    const alert = await screen.findByTestId('mailbox-send-lane-alert');
    expect(alert).toHaveTextContent('Send lane not granted — falling back to SendGrid as ticketpulse@');
    expect(alert).toHaveTextContent('Grant Mail.ReadWrite (application) to Ticket Pulse Backend');
  });

  test('Test shows the three capability checks (read ok, send NOT granted, thread not granted)', async () => {
    ticketsAPI.listMailboxes.mockResolvedValue({ data: [mailbox], meta: { sendLane: null } });
    ticketsAPI.testMailbox.mockResolvedValue({ data: { success: false, message: 'cannot SEND', canRead: true, canSend: false, canThread: false, roles: ['Mail.Read'], mode: 'both' } });
    renderPanel();
    await screen.findByText('patickets@example.com');
    fireEvent.click(screen.getByRole('button', { name: /Test/ }));
    const checks = await screen.findByTestId('mailbox-test-checks');
    expect(checks).toHaveTextContent('app roles: Mail.Read');
    expect(screen.getByTestId('mailbox-check-canRead')).toHaveAttribute('data-state', 'ok');
    expect(screen.getByTestId('mailbox-check-canSend')).toHaveAttribute('data-state', 'fail');
    expect(screen.getByTestId('mailbox-check-canThread')).toHaveAttribute('data-state', 'warn');
    expect(screen.getByRole('alert')).toHaveTextContent('cannot SEND');
  });

  test('capabilityChecks: unknown roles are never a tick; Mail.Send only required for send/both', () => {
    const unknown = capabilityChecks({ canRead: true, canSend: null, canThread: null }, 'both');
    expect(unknown.find((c) => c.key === 'canSend').value).toBeNull();
    expect(capabilityChecks({}, 'ingest').find((c) => c.key === 'canSend').required).toBe(false);
    expect(capabilityChecks({}, 'send').find((c) => c.key === 'canSend').required).toBe(true);
  });

  test('the Unmatched replies section renders under the mailbox list', async () => {
    ticketsAPI.listMailboxes.mockResolvedValue({ data: [mailbox], meta: { sendLane: null } });
    renderPanel();
    await screen.findByTestId('held-replies-panel');
    expect(screen.getByText('Unmatched replies')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('held-empty')).toBeInTheDocument());
    expect(ticketsAPI.listHeldMessages).toHaveBeenCalledWith('held');
  });
});
