/** @vitest-environment jsdom */
// 20 Nov 2026: an approval still open when its ticket was closed ended as
// "not needed any more" (decidedVia 'ticket_closed'). The ticket's Approvals
// tab says so — never "Closed by <approver>", and no auto-cancelled count.
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('../../services/api', () => ({ ticketsAPI: { approvalMessages: vi.fn(() => Promise.resolve({ data: [] })) } }));
vi.mock('../../hooks/useRequesterPhoto', () => ({ useRequesterPhoto: () => null }));
vi.mock('./RichTextEditor', async () => {
  const { forwardRef } = await import('react');
  const Stub = forwardRef(function Stub({ ariaLabel }, ref) { return <textarea ref={ref} aria-label={ariaLabel} />; });
  return { default: Stub, isRichContent: () => false };
});

import ApprovalTimeline from './ApprovalTimeline';

afterEach(() => cleanup());

const cat = { name: 'Software', tiers: [{ name: 'Tier 1', managerEmails: ['dana.fox@example.com', 'eli.park@example.com'] }] };
const base = {
  requestedBy: 'sam.okafor@example.com', requestedByName: 'Sam Okafor', approvalCategory: cat, requestNote: 'Priya needs a licence.',
  clarificationLog: [], escalationLog: [], requestGroupId: 'g-1', tier: 1, createdAt: '2026-10-26T17:00:00Z',
};
const closedRow = (over) => ({
  ...base, status: 'closed', closeReason: 'not_needed', decidedVia: 'ticket_closed', decidedAt: '2026-11-20T18:00:00Z',
  decisionNote: 'Not needed any more: the ticket was closed without a decision.', ...over,
});

function mount(approvals) {
  render(<ApprovalTimeline approvals={approvals} meta={{ actor: { email: 'sam.okafor@example.com', name: 'Sam Okafor', kind: 'agent' }, technicians: [], members: [] }} ticketId={65083}
    requester={{ name: 'Priya Nair', email: 'priya.nair@example.com' }} onDecide={vi.fn()} onResubmit={vi.fn()} onCancel={vi.fn()} onDeleteRequest={vi.fn()} onAsk={vi.fn()} onAnswer={vi.fn()} />);
}

describe('Approvals tab: closed because the ticket closed', () => {
  test('the folded row says no longer needed, not who closed it', async () => {
    mount([
      closedRow({ id: 173, approverEmail: 'dana.fox@example.com', approverName: 'Dana Fox' }),
      closedRow({ id: 174, approverEmail: 'eli.park@example.com', approverName: 'Eli Park' }),
    ]);
    const row = await screen.findByTestId('ticket-approval');
    expect(row).toHaveAttribute('data-status', 'closed');
    const summary = within(row).getByTestId('ticket-approval-summary');
    expect(summary).toHaveTextContent(/^No longer needed: the ticket was closed .* · requested by Sam Okafor$/);
    expect(summary).not.toHaveTextContent(/by Dana Fox/);
  });

  test('opened, it names no approver and repeats no note', async () => {
    mount([closedRow({ id: 173, approverEmail: 'dana.fox@example.com', approverName: 'Dana Fox' }), closedRow({ id: 174, approverEmail: 'eli.park@example.com', approverName: 'Eli Park' })]);
    const row = await screen.findByTestId('ticket-approval');
    fireEvent.click(within(row).getByRole('button', { name: 'Open the Software request' }));
    const card = within(row).getByTestId('approval-closed-by-ticket');
    expect(card).toHaveTextContent('No longer needed: the ticket was closed');
    expect(card).toHaveTextContent('Nobody decided it and nobody was told · requested by Sam Okafor');
    expect(within(row).queryByText(/auto-cancelled/)).toBeNull();
    expect(within(row).queryByText(/Closed by/)).toBeNull();
    expect(within(row).queryByText(/Not needed any more: the ticket was closed without a decision/)).toBeNull();
  });
});
