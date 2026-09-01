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
  },
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
