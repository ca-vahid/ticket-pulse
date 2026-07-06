/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ProposedReplyCard from './ProposedReplyCard';

const proposedReplies = vi.fn();
const sendProposedReply = vi.fn().mockResolvedValue({});
const dismissProposedReply = vi.fn().mockResolvedValue({});
vi.mock('../../services/api', () => ({
  ticketsAPI: {
    proposedReplies: (...a) => proposedReplies(...a),
    sendProposedReply: (...a) => sendProposedReply(...a),
    dismissProposedReply: (...a) => dismissProposedReply(...a),
  },
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const proposal = {
  id: 77,
  status: 'proposed',
  confidence: 'medium',
  bodyHtml: '<p>Try restarting the VPN client.</p>',
  bodyText: 'Try restarting the VPN client.',
};

describe('ProposedReplyCard', () => {
  test('renders the staged draft with its confidence', async () => {
    proposedReplies.mockResolvedValue({ data: [proposal] });
    render(<ProposedReplyCard ticketId={501} canWrite onSent={() => {}} onEditInComposer={() => {}} />);
    expect(await screen.findByText(/AI proposed reply/i)).toBeInTheDocument();
    expect(screen.getByText(/Try restarting the VPN client/)).toBeInTheDocument();
    expect(screen.getByText(/medium confidence/i)).toBeInTheDocument();
  });

  test('approve & send calls the API and notifies the parent', async () => {
    proposedReplies.mockResolvedValue({ data: [proposal] });
    const onSent = vi.fn();
    render(<ProposedReplyCard ticketId={501} canWrite onSent={onSent} />);
    fireEvent.click(await screen.findByRole('button', { name: /approve & send/i }));
    await waitFor(() => expect(sendProposedReply).toHaveBeenCalledWith(501, 77));
    expect(onSent).toHaveBeenCalled();
  });

  test('dismiss asks for confirmation first', async () => {
    proposedReplies.mockResolvedValue({ data: [proposal] });
    render(<ProposedReplyCard ticketId={501} canWrite />);
    fireEvent.click(await screen.findByRole('button', { name: /dismiss proposed reply/i }));
    expect(dismissProposedReply).not.toHaveBeenCalled(); // not yet — confirm step
    fireEvent.click(screen.getByRole('button', { name: /^discard$/i }));
    await waitFor(() => expect(dismissProposedReply).toHaveBeenCalledWith(501, 77));
  });

  test('edit-in-composer hands the draft to the parent and retires the proposal', async () => {
    proposedReplies.mockResolvedValue({ data: [proposal] });
    const onEdit = vi.fn();
    render(<ProposedReplyCard ticketId={501} canWrite onEditInComposer={onEdit} />);
    fireEvent.click(await screen.findByRole('button', { name: /edit in composer/i }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 77 }));
    await waitFor(() => expect(dismissProposedReply).toHaveBeenCalledWith(501, 77));
  });

  test('renders nothing without a proposal or write access', async () => {
    proposedReplies.mockResolvedValue({ data: [] });
    const { container } = render(<ProposedReplyCard ticketId={501} canWrite />);
    await waitFor(() => expect(proposedReplies).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="proposed-reply-card"]')).toBeNull();
  });
});
