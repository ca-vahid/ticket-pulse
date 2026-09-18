/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MailboxConnectionsPanel from './MailboxConnectionsPanel';
import { ticketsAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  ticketsAPI: {
    listMailboxes: vi.fn(),
    createMailbox: vi.fn(),
    updateMailbox: vi.fn(),
    removeMailbox: vi.fn(),
    testMailbox: vi.fn(),
    meta: vi.fn().mockResolvedValue({ data: { groups: [] } }),
    // Phase RL: the panel embeds the hold queue (HeldRepliesPanel).
    listHeldMessages: vi.fn().mockResolvedValue({ data: [], meta: { heldCount: 0 } }),
    attachHeldMessage: vi.fn(),
    createTicketFromHeld: vi.fn(),
    discardHeldMessage: vi.fn(),
  },
  searchAPI: { global: vi.fn() },
}));

vi.mock('../../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ activeTypes: [] }),
}));

const mailboxes = [
  { id: 1, address: 'it@example.com', mode: 'both', isEnabled: true, isPrimary: true, lastCheckedAt: null, lastError: null },
  { id: 2, address: 'patickets@example.com', mode: 'both', isEnabled: true, isPrimary: false, lastCheckedAt: null, lastError: null },
];

describe('MailboxConnectionsPanel primary sender (Phase MB-1g/1i)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test('shows the primary badge on the starred mailbox and the outbound-flip copy', async () => {
    ticketsAPI.listMailboxes.mockResolvedValue({ data: mailboxes });
    render(<MailboxConnectionsPanel />);

    await waitFor(() => expect(screen.getByText('it@example.com')).toBeInTheDocument());
    expect(screen.getByTestId('mailbox-primary-badge-1')).toHaveTextContent('Primary sender');
    expect(screen.queryByTestId('mailbox-primary-badge-2')).not.toBeInTheDocument();

    const notice = screen.getByTestId('mailbox-panel-notice');
    expect(notice).toHaveTextContent(/changes this workspace.s outbound sender/i);
    expect(notice).toHaveTextContent(/workflow emails/i);
    expect(notice).toHaveTextContent(/land back in the ticket/i);
    expect(notice).toHaveTextContent('Mail.Read');
    expect(notice).toHaveTextContent('Mail.Send');

    expect(screen.getByRole('button', { name: /it@example.com is the primary sender/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /make patickets@example.com the primary sender/i })).toHaveAttribute('aria-pressed', 'false');
  });

  test('starring a mailbox PATCHes isPrimary=true and the list round-trips the new primary', async () => {
    ticketsAPI.listMailboxes
      .mockResolvedValueOnce({ data: mailboxes })
      .mockResolvedValueOnce({
        data: [
          { ...mailboxes[0], isPrimary: false },
          { ...mailboxes[1], isPrimary: true },
        ],
      });
    ticketsAPI.updateMailbox.mockResolvedValue({ data: { ...mailboxes[1], isPrimary: true } });
    render(<MailboxConnectionsPanel />);

    await waitFor(() => expect(screen.getByText('patickets@example.com')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /make patickets@example.com the primary sender/i }));

    await waitFor(() => expect(ticketsAPI.updateMailbox).toHaveBeenCalledWith(2, { isPrimary: true }));
    await waitFor(() => expect(screen.getByTestId('mailbox-primary-badge-2')).toBeInTheDocument());
    expect(screen.queryByTestId('mailbox-primary-badge-1')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('patickets@example.com is now the primary sender');
  });

  test('un-starring the primary PATCHes isPrimary=false', async () => {
    ticketsAPI.listMailboxes.mockResolvedValue({ data: mailboxes });
    ticketsAPI.updateMailbox.mockResolvedValue({ data: { ...mailboxes[0], isPrimary: false } });
    render(<MailboxConnectionsPanel />);

    await waitFor(() => expect(screen.getByText('it@example.com')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /it@example.com is the primary sender/i }));
    await waitFor(() => expect(ticketsAPI.updateMailbox).toHaveBeenCalledWith(1, { isPrimary: false }));
  });

  test('a failed primary PATCH surfaces the API error', async () => {
    ticketsAPI.listMailboxes.mockResolvedValue({ data: mailboxes });
    ticketsAPI.updateMailbox.mockRejectedValue({ response: { data: { message: 'Mailbox not found in this workspace' } } });
    render(<MailboxConnectionsPanel />);

    await waitFor(() => expect(screen.getByText('patickets@example.com')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /make patickets@example.com the primary sender/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Mailbox not found in this workspace'));
  });
});

describe('MailboxConnectionsPanel inbound-lane pill (Phase MB-2e)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test('webhook-live mailbox shows "Instant (webhook)" with the last-notification age; polling mailbox shows its cadence', async () => {
    ticketsAPI.listMailboxes.mockResolvedValue({
      data: [
        {
          ...mailboxes[0], pollIntervalSec: 15, instantIngest: true, notificationStatus: 'active',
          lastNotificationAt: new Date(Date.now() - 12 * 1000).toISOString(),
          subscriptionExpiresAt: new Date(Date.now() + 5 * 86400 * 1000).toISOString(),
        },
        { ...mailboxes[1], pollIntervalSec: 15, instantIngest: false, notificationStatus: null, lastNotificationAt: null },
      ],
    });
    render(<MailboxConnectionsPanel />);
    await waitFor(() => expect(screen.getByTestId('mailbox-lane-1')).toBeInTheDocument());
    expect(screen.getByTestId('mailbox-lane-1')).toHaveTextContent(/Instant \(webhook\) · last notification 1\ds ago/);
    expect(screen.getByTestId('mailbox-lane-2')).toHaveTextContent('Polling every 15s');
  });

  test('a webhook error falls back to polling copy; send-only mailboxes get no lane pill', async () => {
    ticketsAPI.listMailboxes.mockResolvedValue({
      data: [
        { ...mailboxes[0], pollIntervalSec: 30, instantIngest: false, notificationStatus: 'error' },
        { ...mailboxes[1], mode: 'send', instantIngest: false },
      ],
    });
    render(<MailboxConnectionsPanel />);
    await waitFor(() => expect(screen.getByTestId('mailbox-lane-1')).toBeInTheDocument());
    expect(screen.getByTestId('mailbox-lane-1')).toHaveTextContent('Webhook error — polling every 30s');
    expect(screen.queryByTestId('mailbox-lane-2')).not.toBeInTheDocument();
  });
});

// QA 09-17 #6 + the 18 Sep follow-up. The mailbox mode picks the sending LANE,
// and the lane decides whether a reply can carry the replying agent's name:
// SendGrid (ingest only) keeps it, Microsoft Graph (send/both) has Exchange
// overwrite it with the mailbox's own name. The first version of this note only
// named the Sent Items upside and told admins to switch — which would have cost
// Field Equipment its per-agent names. Both notes now state the trade.
describe('MailboxConnectionsPanel mode trade-off notes (QA 09-17 #6)', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  test('an ingest-only mailbox names the agent-name upside and the Sent Items cost', async () => {
    ticketsAPI.listMailboxes.mockResolvedValue({
      data: [{ ...mailboxes[0], mode: 'ingest' }, mailboxes[1]],
    });
    render(<MailboxConnectionsPanel />);
    const note = await screen.findByTestId('mailbox-ingest-note-1');
    expect(note).toHaveTextContent(/replying agent's name/);
    expect(note).toHaveTextContent(/nothing is copied to this mailbox's Sent Items/);
    // It must NOT push the admin toward the lane that loses the agent name.
    expect(note.textContent).not.toMatch(/Switch to/i);
  });

  test('a send-capable mailbox warns that requesters never see the individual agent', async () => {
    ticketsAPI.listMailboxes.mockResolvedValue({ data: [mailboxes[0]] }); // mode 'both'
    render(<MailboxConnectionsPanel />);
    const note = await screen.findByTestId('mailbox-send-note-1');
    expect(note).toHaveTextContent(/Microsoft 365 replaces the/);
    expect(note).toHaveTextContent(/never see the individual agent/);
    expect(screen.queryByTestId('mailbox-ingest-note-1')).not.toBeInTheDocument();
  });

  test('the mode options name which way each one goes', async () => {
    ticketsAPI.listMailboxes.mockResolvedValue({ data: [mailboxes[0]] });
    render(<MailboxConnectionsPanel />);
    await waitFor(() => expect(screen.getByText('it@example.com')).toBeInTheDocument());
    expect(screen.getByRole('option', { name: 'Ingest only (agent name on replies)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Ingest + send (team name on replies)' })).toBeInTheDocument();
  });

  test('a disabled mailbox carries neither note', async () => {
    ticketsAPI.listMailboxes.mockResolvedValue({
      data: [{ ...mailboxes[0], mode: 'ingest', isEnabled: false }],
    });
    render(<MailboxConnectionsPanel />);
    await waitFor(() => expect(screen.getByText('it@example.com')).toBeInTheDocument());
    expect(screen.queryByTestId('mailbox-ingest-note-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mailbox-send-note-1')).not.toBeInTheDocument();
  });
});
