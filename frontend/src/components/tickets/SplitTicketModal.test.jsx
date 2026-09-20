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

describe('SplitTicketModal — from a message onward (QA 09-18 #6)', () => {
  test('opened from a message: that message and everything after it are marked, the cut line shows, and fromEntryId is sent', async () => {
    const onSplit = vi.fn();
    render(<SplitTicketModal ticket={ticket} onClose={() => {}} onSplit={onSplit} initialFromEntryId={9002} />);
    await screen.findByTestId('split-entries');
    expect(screen.getByTestId('split-cut-line')).toBeInTheDocument();
    expect(screen.getByText('(2)')).toBeInTheDocument();
    // the anchor's excerpt seeds the subject
    expect(screen.getByLabelText('New ticket subject')).toHaveValue('separately, my VPN drops every hour');
    fireEvent.click(screen.getByTestId('split-submit'));
    await waitFor(() => {
      expect(ticketsAPI.split).toHaveBeenCalledWith(500, expect.objectContaining({ entryIds: [], fromEntryId: 9002, subject: 'separately, my VPN drops every hour' }));
    });
    expect(onSplit).toHaveBeenCalled();
  });

  test('clicking a message in from-mode moves the cut; the original can be parked and the author made requester', async () => {
    const withAuthor = entries.map((e) => (e.id === 9002 ? { ...e, author: 'Anna Lee', authorEmail: 'anna@bgcengineering.ca' } : e));
    ticketsAPI.splittable.mockResolvedValue({ success: true, data: withAuthor });
    render(<SplitTicketModal ticket={{ ...ticket, requester: { email: 'jsmith@bgcengineering.ca', name: 'John Smith' } }} onClose={() => {}} onSplit={() => {}} />);
    await screen.findByTestId('split-entries');
    fireEvent.click(screen.getByRole('radio', { name: 'From a message onward' }));
    fireEvent.click(screen.getByRole('button', { name: /Split from the message from Anna Lee/ }));
    expect(screen.getByText('(2)')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('split-requester-suggestion').querySelector('input'));
    fireEvent.click(screen.getByRole('radio', { name: /Set it to Pending/ }));
    fireEvent.click(screen.getByTestId('split-submit'));
    await waitFor(() => {
      expect(ticketsAPI.split).toHaveBeenCalledWith(500, expect.objectContaining({
        fromEntryId: 9002, requesterEmail: 'anna@bgcengineering.ca', requesterName: 'Anna Lee', parentStatus: 'Pending',
      }));
    });
  });

  test('"me" assigns the new ticket to the current agent', async () => {
    render(<SplitTicketModal ticket={ticket} onClose={() => {}} onSplit={() => {}} selfTechnicianId={42} technicians={[{ id: 42, name: 'Cora' }]} />);
    await screen.findByTestId('split-entries');
    fireEvent.click(screen.getByTestId('split-assign-me'));
    fireEvent.change(screen.getByLabelText('New ticket subject'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('split-submit'));
    await waitFor(() => expect(ticketsAPI.split).toHaveBeenCalledWith(500, expect.objectContaining({ assignedTechId: 42 })));
  });
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
        includeDescription: true,
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

describe('split — the original description option (QA 09-15 #2)', () => {
  test('is on by default and can be turned off before submitting', async () => {
    const onSplit = vi.fn();
    render(<SplitTicketModal ticket={ticket} onClose={() => {}} onSplit={onSplit} />);
    await screen.findByTestId('split-entries');
    const box = screen.getByTestId('split-include-description');
    expect(box).toBeChecked();
    fireEvent.click(box);
    fireEvent.change(screen.getByLabelText('New ticket subject'), { target: { value: 'Child' } });
    fireEvent.click(screen.getByTestId('split-submit'));
    await waitFor(() => {
      expect(ticketsAPI.split).toHaveBeenCalledWith(500, expect.objectContaining({ includeDescription: false }));
    });
  });
});
