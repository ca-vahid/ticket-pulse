/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// 30 Sep 2026 (Vahid): Knowledge → Approvals — every Auto-help answer waiting
// for a person, sendable or dismissable without opening the ticket; the
// ticket card says who it is waiting for when the viewer may not send it,
// and shows the workflow acknowledgement that rides on top of the answer.

const approvals = vi.fn();
const sendProposedReply = vi.fn().mockResolvedValue({});
const dismissProposedReply = vi.fn().mockResolvedValue({});
const proposedReplies = vi.fn();
vi.mock('../../services/api', () => ({
  knowledgeAPI: { approvals: (...a) => approvals(...a) },
  ticketsAPI: {
    proposedReplies: (...a) => proposedReplies(...a),
    sendProposedReply: (...a) => sendProposedReply(...a),
    dismissProposedReply: (...a) => dismissProposedReply(...a),
  },
}));

import ApprovalsPanel from './ApprovalsPanel';
import ProposedReplyCard from '../tickets/ProposedReplyCard';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const proposal = (id, extra = {}) => ({
  id,
  ticketId: 500 + id,
  status: 'proposed',
  source: 'auto_help',
  autoHelpRunId: 900 + id,
  bodyHtml: '<p>preview</p>',
  createdAt: new Date().toISOString(),
  ticket: { id: 500 + id, ref: `TP-${1280 + id}`, subject: `VPN drops ${id}`, assignee: { id: 42, name: 'Dana Agent' }, requester: { name: 'Riley Requester' } },
  autoHelp: {
    runId: 900 + id,
    playbookName: 'Network & VPN',
    confidence: 0.9,
    answerHtml: '<p>Reconnect with the new profile.</p>',
    disclosure: 'This is an automated first answer.',
    footer: 'Reply if you still need a hand.',
    sources: [],
    followUp: null,
    dismissReasons: ['wrong_answer', 'not_needed', 'other'],
    canSend: true,
    ...extra,
  },
});

const renderPanel = () => render(<MemoryRouter><ApprovalsPanel /></MemoryRouter>);

describe('Knowledge → Approvals', () => {
  test('lists each waiting answer under its ticket, with requester, assignee and a link', async () => {
    approvals.mockResolvedValue({ data: [proposal(1), proposal(2)] });
    renderPanel();
    const list = await screen.findByTestId('approvals-list');
    expect(within(list).getAllByTestId('auto-help-suggestion')).toHaveLength(2);
    expect(screen.getByText(/2/, { selector: 'span' })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /TP-1281 · VPN drops 1/ });
    expect(link).toHaveAttribute('href', '/tickets/501');
    expect(list).toHaveTextContent('from Riley Requester');
    expect(list).toHaveTextContent('assigned to Dana Agent');
  });

  test('Send goes to that ticket and the answer leaves the list', async () => {
    approvals.mockResolvedValue({ data: [proposal(1)] });
    renderPanel();
    const card = await screen.findByTestId('auto-help-suggestion');
    fireEvent.click(within(card).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sendProposedReply).toHaveBeenCalledWith(501, 1, {}));
    await waitFor(() => expect(screen.queryByTestId('auto-help-suggestion')).toBeNull());
    expect(screen.getByRole('status')).toHaveTextContent('1 handled here just now');
  });

  test('nothing waiting says why the list is empty', async () => {
    approvals.mockResolvedValue({ data: [] });
    renderPanel();
    expect(await screen.findByText('Nothing waiting')).toBeInTheDocument();
  });

  test('a load failure is shown, not swallowed', async () => {
    approvals.mockRejectedValue(new Error('Only reviewers and admins can open the Auto-help approvals queue'));
    renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent('Only reviewers and admins');
  });
});

describe('the ticket card in approve mode', () => {
  const renderCard = () => render(<MemoryRouter><ProposedReplyCard ticketId={501} canWrite /></MemoryRouter>);

  test('someone who may not send sees who it waits for, and no Send / Dismiss', async () => {
    proposedReplies.mockResolvedValue({ data: [proposal(1, { canSend: false })] });
    renderCard();
    const card = await screen.findByTestId('auto-help-suggestion');
    expect(within(card).getByTestId('auto-help-waiting-approver')).toHaveTextContent('Waiting for the assignee, a reviewer or an admin to send it.');
    expect(within(card).queryByRole('button', { name: 'Send' })).toBeNull();
  });

  test('a workflow acknowledgement set aside for this answer is shown on top of it', async () => {
    proposedReplies.mockResolvedValue({ data: [proposal(1, { workflowAck: { text: 'Thanks Riley, we have your ticket.', fromProposalId: 3 } })] });
    renderCard();
    const card = await screen.findByTestId('auto-help-suggestion');
    expect(within(card).getByTestId('auto-help-workflow-ack')).toHaveTextContent('Thanks Riley, we have your ticket.');
    expect(within(card).getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });
});
