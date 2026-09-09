/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SplitTicketModal from './SplitTicketModal';
import { ticketsAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  ticketsAPI: { splittable: vi.fn(), split: vi.fn() },
}));

// An FS-born parent — the case merge refuses and split must support.
const ticket = { id: 500, displayRef: '#231164', subject: 'Laptop is slow and also my VPN drops' };

const entries = [
  { id: 9001, author: 'John Smith', authorType: 'requester', isPrivate: false, occurredAt: '2026-09-01T10:00:00Z', excerpt: 'my laptop takes ten minutes to boot' },
  { id: 9002, author: 'John Smith', authorType: 'requester', isPrivate: false, occurredAt: '2026-09-02T09:00:00Z', excerpt: 'separately, my VPN drops every hour' },
  { id: 9003, author: 'Cora Coordinator', authorType: 'agent', isPrivate: true, occurredAt: '2026-09-02T10:00:00Z', excerpt: 'internal: two problems in one ticket' },
];

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  ticketsAPI.splittable.mockResolvedValue({ success: true, data: entries });
  ticketsAPI.split.mockResolvedValue({ success: true, data: { child: { ref: 'TP-1050' }, copied: 1, attachmentsMoved: 1 } });
});

describe('SplitTicketModal (QA 09-08)', () => {
  test('lists the conversation and marks internal notes', async () => {
    render(<SplitTicketModal ticket={ticket} onClose={() => {}} onSplit={() => {}} />);
    expect(await screen.findByTestId('split-entries')).toBeInTheDocument();
    expect(screen.getByText(/my VPN drops every hour/)).toBeInTheDocument();
    expect(screen.getByText('internal note')).toBeInTheDocument();
  });

  test('selecting the first message seeds the subject, and typing wins after that', async () => {
    render(<SplitTicketModal ticket={ticket} onClose={() => {}} onSplit={() => {}} />);
    await screen.findByTestId('split-entries');

    fireEvent.click(screen.getAllByRole('checkbox', { name: /message from John Smith/i })[0]);
    const subject = screen.getByLabelText('New ticket subject');
    expect(subject.value).toMatch(/my laptop takes ten minutes to boot/);

    fireEvent.change(subject, { target: { value: 'VPN drops every hour' } });
    // A second selection must not clobber what the agent typed.
    fireEvent.click(screen.getAllByRole('checkbox', { name: /message from/i })[1]);
    expect(subject.value).toBe('VPN drops every hour');
  });

  test('the consequences say copied, not moved — and that the original is untouched', async () => {
    render(<SplitTicketModal ticket={ticket} onClose={() => {}} onSplit={() => {}} />);
    await screen.findByTestId('split-entries');
    expect(screen.getByText(/copied/)).toBeInTheDocument();
    expect(screen.getByText(/own thread is never edited/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is closed/)).toBeInTheDocument();
  });

  test('submit is blocked until there is a subject', async () => {
    render(<SplitTicketModal ticket={ticket} onClose={() => {}} onSplit={() => {}} />);
    await screen.findByTestId('split-entries');
    expect(screen.getByTestId('split-submit')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('New ticket subject'), { target: { value: 'VPN drops' } });
    expect(screen.getByTestId('split-submit')).toBeEnabled();
  });

  test('sends the selected ids, the subject and both toggles', async () => {
    const onSplit = vi.fn();
    render(<SplitTicketModal ticket={ticket} onClose={() => {}} onSplit={onSplit} />);
    await screen.findByTestId('split-entries');

    fireEvent.click(screen.getAllByRole('checkbox', { name: /message from/i })[1]);
    fireEvent.change(screen.getByLabelText('New ticket subject'), { target: { value: 'VPN drops every hour' } });
    // Attachments move by default; the requester email does not.
    fireEvent.click(screen.getByTestId('split-submit'));

    await waitFor(() => {
      expect(ticketsAPI.split).toHaveBeenCalledWith(500, {
        entryIds: [9002],
        subject: 'VPN drops every hour',
        moveAttachments: true,
        notifyRequester: false,
      });
    });
    expect(onSplit).toHaveBeenCalledWith(expect.objectContaining({ child: { ref: 'TP-1050' } }));
  });

  test('a split with no messages selected is still allowed', async () => {
    render(<SplitTicketModal ticket={ticket} onClose={() => {}} onSplit={() => {}} />);
    await screen.findByTestId('split-entries');
    fireEvent.change(screen.getByLabelText('New ticket subject'), { target: { value: 'Follow-up work' } });
    fireEvent.click(screen.getByTestId('split-submit'));
    await waitFor(() => {
      expect(ticketsAPI.split).toHaveBeenCalledWith(500, expect.objectContaining({ entryIds: [] }));
    });
  });

  test('a server error is shown and the modal stays open', async () => {
    ticketsAPI.split.mockRejectedValue({ response: { data: { message: 'Splitting a ticket requires coordinator or admin access' } } });
    const onSplit = vi.fn();
    render(<SplitTicketModal ticket={ticket} onClose={() => {}} onSplit={onSplit} />);
    await screen.findByTestId('split-entries');
    fireEvent.change(screen.getByLabelText('New ticket subject'), { target: { value: 'VPN' } });
    fireEvent.click(screen.getByTestId('split-submit'));

    expect(await screen.findByText(/requires coordinator or admin access/)).toBeInTheDocument();
    expect(screen.getByTestId('split-modal')).toBeInTheDocument();
    expect(onSplit).not.toHaveBeenCalled();
  });

  test('a ticket with no conversation still offers to create a linked ticket', async () => {
    ticketsAPI.splittable.mockResolvedValue({ success: true, data: [] });
    render(<SplitTicketModal ticket={ticket} onClose={() => {}} onSplit={() => {}} />);
    expect(await screen.findByText(/no conversation messages yet/i)).toBeInTheDocument();
  });

  test('a failed load surfaces the reason rather than an empty list', async () => {
    ticketsAPI.splittable.mockRejectedValue(new Error('network down'));
    render(<SplitTicketModal ticket={ticket} onClose={() => {}} onSplit={() => {}} />);
    expect(await screen.findByText('network down')).toBeInTheDocument();
  });
});
