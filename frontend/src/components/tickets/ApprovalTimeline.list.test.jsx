/** @vitest-environment jsdom */
// 27 Oct 2026 (Vahid: "do the same redesign for the ticket's approvals tab"):
// each request is a two-line row that opens into the conversation; open
// requests start open, decided ones folded; the answer box goes full screen.
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

let currentMessages = [];
vi.mock('../../services/api', () => ({ ticketsAPI: { approvalMessages: vi.fn(() => Promise.resolve({ data: currentMessages })) } }));
vi.mock('../../hooks/useRequesterPhoto', () => ({ useRequesterPhoto: () => null }));
vi.mock('./RichTextEditor', async () => {
  const { forwardRef } = await import('react');
  const Stub = forwardRef(function Stub({ onChange, ariaLabel, onToggleExpand, expanded }, ref) {
    return (
      <div>
        <textarea ref={ref} aria-label={ariaLabel} onChange={(e) => onChange({ html: '', text: e.target.value })} />
        {onToggleExpand && <button type="button" onClick={onToggleExpand}>{expanded ? 'Exit full screen' : 'Full screen'}</button>}
      </div>
    );
  });
  return { default: Stub, isRichContent: () => false };
});

import ApprovalTimeline from './ApprovalTimeline';

afterEach(() => { cleanup(); currentMessages = []; });

const members = [
  { email: 'vera@x.io', name: 'Vera Lead', role: 'admin' },
  { email: 'theo@x.io', name: 'Theo Tech', role: 'technician' },
];
const requester = { name: 'Rita Requester', email: 'rita@x.io' };
const cat = { name: 'Software', tiers: [{ name: 'Tier 1', managerEmails: ['vera@x.io'] }] };
const base = { requestedBy: 'theo@x.io', requestedByName: 'Theo Tech', approvalCategory: cat, requestNote: 'Rita wants Kite.', clarificationLog: [], escalationLog: [] };
const approved = { ...base, id: 1, requestGroupId: 'g-old', status: 'approved', tier: 1, approverEmail: 'vera@x.io', approverName: 'Vera Lead', createdAt: '2026-10-20T15:00:00Z', decidedAt: '2026-10-20T19:44:00Z', decisionNote: 'Fine by me.' };
const pending = { ...base, id: 2, requestGroupId: 'g-new', status: 'pending', tier: 1, approverEmail: 'vera@x.io', approverName: 'Vera Lead', createdAt: '2026-10-26T15:00:00Z' };
const question = { id: 9, kind: 'question', audience: 'requester', requestGroupId: 'g-old', approvalId: 1, author: { email: 'vera@x.io', name: 'Vera Lead', role: 'approver' }, to: ['rita@x.io'], cc: [], createdAt: '2026-10-20T16:00:00Z', bodyText: 'Which plan?' };
const answer = { id: 10, kind: 'answer', audience: 'requester', requestGroupId: 'g-old', approvalId: 1, inReplyToId: 9, author: { email: 'rita@x.io', name: 'Rita Requester', role: 'requester' }, to: ['vera@x.io'], cc: [], createdAt: '2026-10-20T18:00:00Z', bodyText: 'The team plan.' };

const THEO = { email: 'theo@x.io', name: 'Theo Tech', kind: 'agent', workspaceRole: 'technician' };

function mount({ approvals, messages = [], actor = THEO }) {
  currentMessages = messages;
  render(<ApprovalTimeline approvals={approvals} meta={{ actor, technicians: [], members }} ticketId={65} requester={requester}
    onDecide={vi.fn()} onResubmit={vi.fn()} onCancel={vi.fn()} onDeleteRequest={vi.fn()} onAsk={vi.fn()} onAnswer={vi.fn().mockResolvedValue({})} />);
}

describe('Ticket Approvals tab — a list of requests', () => {
  test('an open request starts open; a decided one is a folded two-line row', async () => {
    mount({ approvals: [approved, pending] });
    const rows = await screen.findAllByTestId('ticket-approval');
    expect(rows.map((r) => r.dataset.status)).toEqual(['pending', 'approved']); // newest first
    expect(rows[0]).toHaveAttribute('data-open', 'true');
    expect(within(rows[0]).getByTestId('approval-waiting-on')).toHaveTextContent('Waiting on Vera Lead to decide');
    expect(rows[1]).toHaveAttribute('data-open', 'false');
    expect(within(rows[1]).getByTestId('ticket-approval-summary')).toHaveTextContent(/Approved by Vera Lead .* · requested by Theo Tech/);
    expect(within(rows[1]).queryByTestId('ticket-approval-body')).toBeNull();
    expect(within(rows[1]).getByText('took 4 h 44 m')).toBeInTheDocument();
  });

  test('opening a decided request shows its whole conversation, then the decision note', async () => {
    mount({ approvals: [approved], messages: [question, answer] });
    const row = await screen.findByTestId('ticket-approval');
    expect(await within(row).findByText(/2 messages/)).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Open the Software request' }));
    const convo = within(row).getByTestId('decided-conversation');
    expect(convo).toHaveTextContent('Which plan?');
    expect(convo).toHaveTextContent('The team plan.');
    expect(within(row).getByText(/Fine by me\./)).toBeInTheDocument();
    // the lone request note gives way to the conversation (which starts with it)
    expect(within(row).queryByTestId('timeline-request-note')).toBeNull();
  });

  test('an open request folds to its summary line', async () => {
    mount({ approvals: [pending] });
    const row = await screen.findByTestId('ticket-approval');
    fireEvent.click(within(row).getByRole('button', { name: 'Close the Software request' }));
    expect(row).toHaveAttribute('data-open', 'false');
    expect(within(row).getByTestId('ticket-approval-summary')).toHaveTextContent('Waiting on Vera Lead to decide · requested by Theo Tech');
  });

  test('the answer box opens full screen and Esc brings it back', async () => {
    const open = { ...pending, status: 'info_requested' };
    const q = { ...question, id: 11, requestGroupId: 'g-new', approvalId: 2, to: ['theo@x.io'] };
    mount({ approvals: [open], messages: [q] });
    const box = await screen.findByTestId('answer-box');
    fireEvent.click(within(box).getByRole('button', { name: 'Full screen' }));
    const dialog = screen.getByRole('dialog', { name: /Answer Vera's question/ });
    expect(dialog).toHaveClass('fixed');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('answer-box')).toBeInTheDocument();
  });
});
