/** @vitest-environment jsdom */
// 26 Oct 2026 — an open request reads as one conversation: a status line says
// who it waits on, every message shows once (a question sent on to the
// requester folds into the original as a hand-off line), and one composer at
// the bottom changes with the viewer and what is pending.
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

let currentMessages = [];
vi.mock('../../services/api', () => ({ ticketsAPI: { approvalMessages: vi.fn(() => Promise.resolve({ data: currentMessages })) } }));
vi.mock('../../hooks/useRequesterPhoto', () => ({ useRequesterPhoto: () => null }));
// The rich editor is a contenteditable; a textarea stands in for it here.
vi.mock('./RichTextEditor', async () => {
  const { forwardRef } = await import('react');
  const Stub = forwardRef(function Stub({ onChange, ariaLabel }, ref) {
    return <textarea ref={ref} aria-label={ariaLabel} onChange={(e) => onChange({ html: '', text: e.target.value })} />;
  });
  return { default: Stub, isRichContent: () => false };
});

import ApprovalTimeline from './ApprovalTimeline';
import { threadState } from './ApprovalThread';

afterEach(() => { cleanup(); currentMessages = []; });

const G = 'g1';
const members = [
  { email: 'vera@x.io', name: 'Vera Lead', role: 'admin' },
  { email: 'nora@x.io', name: 'Nora Security', role: 'admin' },
  { email: 'theo@x.io', name: 'Theo Tech', role: 'technician' },
];
const requester = { name: 'Rita Requester', email: 'rita@x.io' };
const cat = { name: 'Software', tiers: [{ name: 'Tier 1', managerEmails: ['vera@x.io'] }, { name: 'Tier 2', managerEmails: ['nora@x.io'] }] };
const esc = { at: '2026-10-26T17:12:35Z', kind: 'escalated', note: 'Nora, please review.', byName: 'Vera Lead', byEmail: 'vera@x.io', fromTier: 1, toTier: 2, toEmails: ['nora@x.io'] };
const qHtml = '<div>Before I decide:</div><ul><li>Who will use it?</li><li>Any client data?</li></ul>';
const qText = 'Before I decide: - Who will use it? - Any client data?';
const base = { requestedBy: 'theo@x.io', requestedByName: 'Theo Tech', requestGroupId: G, approvalCategory: cat, requestNote: 'Rita wants Kite.', createdAt: '2026-10-26T15:07:57Z' };
const tier1 = { ...base, id: 1, status: 'escalated', tier: 1, approverEmail: 'vera@x.io', approverName: 'Vera Lead', decidedAt: esc.at, escalationLog: [esc], clarificationLog: [], decisionNote: 'Escalated to Tier 2' };
const tier2Asked = { ...base, id: 2, status: 'info_requested', tier: 2, approverEmail: 'nora@x.io', approverName: 'Nora Security', escalationLog: [esc], decisionNote: qText, clarificationLog: [{ question: qText, askedBy: 'nora@x.io', askedAt: '2026-10-27T03:14:27Z', messageId: 80 }] };
const internalQ = { id: 70, kind: 'question', audience: 'internal', requestGroupId: G, approvalId: 2, author: { email: 'nora@x.io', name: 'Nora Security', role: 'approver' }, to: ['theo@x.io', 'vera@x.io'], cc: [], createdAt: '2026-10-26T19:30:35Z', bodyText: qText, bodyHtml: qHtml };
const relayed = { ...internalQ, id: 80, audience: 'requester', to: ['rita@x.io'], cc: ['theo@x.io', 'vera@x.io'], createdAt: '2026-10-27T03:14:27Z' };
const marker = { id: 81, kind: 'answer', audience: 'internal', requestGroupId: G, approvalId: 2, inReplyToId: 70, author: { email: 'vera@x.io', name: 'Vera Lead', role: 'approver' }, to: ['nora@x.io'], cc: [], createdAt: '2026-10-27T03:14:28Z', bodyText: 'Sent to Rita Requester to answer. Their reply comes back here.' };

const VERA = { email: 'vera@x.io', name: 'Vera Lead', kind: 'admin', workspaceRole: 'admin' };
const THEO = { email: 'theo@x.io', name: 'Theo Tech', kind: 'agent', workspaceRole: 'technician' };

function mount({ approvals, messages = [], actor, ...handlers }) {
  currentMessages = messages;
  const props = {
    onDecide: vi.fn(), onResubmit: vi.fn(), onCancel: vi.fn(), onDeleteRequest: vi.fn(), onEscalate: vi.fn(), onForward: vi.fn(),
    onAsk: vi.fn(), onAnswer: vi.fn().mockResolvedValue({}), onAskRequester: vi.fn(), onAnswerConditions: vi.fn(), ...handlers,
  };
  render(<ApprovalTimeline approvals={approvals} meta={{ actor, technicians: [], members }} ticketId={65} requester={requester} {...props} />);
  return props;
}

describe('threadState', () => {
  test('a question sent on to the requester folds into the original; only the copy is open', () => {
    const s = threadState([internalQ, relayed, marker]);
    expect([...s.hidden].sort()).toEqual([80, 81]);
    expect(s.relays.get(70).copy.id).toBe(80);
    expect(s.open.map((m) => m.id)).toEqual([80]);
  });

  test('a real answer to the copy closes it', () => {
    const answer = { id: 90, kind: 'answer', audience: 'requester', inReplyToId: 80, author: { email: 'rita@x.io' }, createdAt: '2026-10-27T16:00:00Z', bodyText: 'Just me.' };
    expect(threadState([internalQ, relayed, marker, answer]).open).toEqual([]);
  });
});

describe('ApprovalTimeline — one conversation', () => {
  test('ticket 65030 shape: the question shows once, with the hand-off to the requester; no fake "answered" row', async () => {
    mount({ approvals: [tier1, tier2Asked], messages: [internalQ, relayed, marker], actor: THEO });
    const thread = await screen.findByTestId('approval-thread');
    await waitFor(() => expect(within(thread).getAllByText('Who will use it?')).toHaveLength(1));
    expect(thread.querySelectorAll('[data-kind="question"]')).toHaveLength(1);
    expect(thread.querySelectorAll('[data-kind="answer"]')).toHaveLength(0);
    expect(within(thread).getByTestId('question-relayed')).toHaveTextContent(/Vera Lead sent this question to Rita Requester \(requester\), with you on Cc/);
    // The flattened copy of the question no longer sits on the approver row.
    expect(screen.queryByText(/Clarification needed/)).toBeNull();
    expect(screen.getAllByTestId('approver-row')[1]).toHaveTextContent(/Nora Security · Tier 2 · Asked a question/);
    expect(screen.getByTestId('approval-waiting-on')).toHaveTextContent(/Waiting on Rita Requester to answer Nora's question · sent to Rita/);
    // The request note is the first message, not a header line above it.
    expect(thread.querySelector('li')).toHaveAttribute('data-kind', 'request');
    expect(screen.getByTestId('approval-requested-by')).toHaveTextContent(/Requested by Theo Tech · last update from Vera Lead/);
  });

  test('the requesting agent answers in the one composer at the bottom; the answer goes to the open copy', async () => {
    const props = mount({ approvals: [tier1, tier2Asked], messages: [internalQ, relayed, marker], actor: THEO });
    const slot = await screen.findByTestId('approval-composer-slot');
    await waitFor(() => expect(slot).toHaveAttribute('data-mode', 'answer'));
    expect(within(slot).getByText("Answer Nora's question for Rita")).toBeInTheDocument();
    expect(within(slot).getByText(/Goes to Nora Security and everyone on the e-mail\. The request goes back to Nora to decide\./)).toBeInTheDocument();
    fireEvent.change(within(slot).getByLabelText('Your answer'), { target: { value: 'Only Rita, no client data.' } });
    fireEvent.click(within(slot).getByRole('button', { name: /Send answer/ }));
    await waitFor(() => expect(props.onAnswer).toHaveBeenCalledWith(80, { bodyText: 'Only Rita, no client data.', bodyHtml: null }));
    // Resubmit stays, as the quiet way out.
    fireEvent.click(within(slot).getByRole('button', { name: 'Send back to Nora without an answer' }));
    expect(props.onResubmit).toHaveBeenCalledWith(2, null);
    // No second reply box above the conversation.
    expect(screen.queryByPlaceholderText(/Reply with the requested info/)).toBeNull();
  });

  test('someone only copied sees one line and opens the composer on purpose', async () => {
    mount({ approvals: [tier1, tier2Asked], messages: [internalQ, relayed, marker], actor: VERA });
    const box = await screen.findByTestId('answer-box');
    await waitFor(() => expect(box).toHaveAttribute('data-folded', 'true'));
    expect(box).toHaveTextContent(/Rita Requester was asked\. You are copied\./);
    fireEvent.click(within(box).getByRole('button', { name: /Answer it yourself/ }));
    expect(screen.getByLabelText('Your answer')).toBeInTheDocument();
  });

  test('an open internal question to the agent: "Waiting on …" names them, the composer answers it internally', async () => {
    const tier2 = { ...tier2Asked, status: 'pending', decisionNote: null, clarificationLog: [] };
    const props = mount({ approvals: [tier1, tier2], messages: [internalQ], actor: THEO });
    await waitFor(() => expect(screen.getByTestId('approval-waiting-on')).toHaveTextContent(/Waiting on you or Vera Lead to answer Nora's question · asked/));
    const slot = screen.getByTestId('approval-composer-slot');
    expect(slot).toHaveTextContent(/Goes to Nora Security — internal, Rita Requester does not see it\./);
    fireEvent.change(within(slot).getByLabelText('Your answer'), { target: { value: 'Two people.' } });
    fireEvent.click(within(slot).getByRole('button', { name: /Send answer/ }));
    await waitFor(() => expect(props.onAnswer).toHaveBeenCalledWith(70, expect.objectContaining({ bodyText: 'Two people.' })));
  });

  test('a question asked before the conversation existed: shown once, answered with the resubmit box', async () => {
    const legacy = { ...tier2Asked, clarificationLog: [{ question: 'Which licence?', askedBy: 'nora@x.io', askedAt: '2026-10-26T19:30:35Z' }], decisionNote: 'Which licence?' };
    const props = mount({ approvals: [tier1, legacy], messages: [], actor: THEO });
    const slot = await screen.findByTestId('approval-composer-slot');
    expect(slot).toHaveAttribute('data-mode', 'resubmit');
    expect(screen.getAllByText('Which licence?')).toHaveLength(1);
    expect(screen.getByTestId('approval-waiting-on')).toHaveTextContent(/Waiting on you to send Nora the information they asked for/);
    fireEvent.change(within(slot).getByLabelText('Reply to Nora Security'), { target: { value: 'The free one.' } });
    fireEvent.click(within(slot).getByRole('button', { name: /Resubmit for approval/ }));
    expect(props.onResubmit).toHaveBeenCalledWith(2, 'The free one.');
  });

  test('conditions waiting on IT: the status line says so and the composer is the answers form', async () => {
    const conditions = { items: [{ id: 'c1', text: 'Use SSO only' }], round: 1 };
    const tier2 = { ...tier2Asked, conditions, decisionNote: null, clarificationLog: [], decidedAt: '2026-10-26T20:00:00Z' };
    mount({ approvals: [tier1, tier2], messages: [], actor: THEO });
    const slot = await screen.findByTestId('approval-composer-slot');
    expect(slot).toHaveAttribute('data-mode', 'conditions');
    expect(within(slot).getByTestId('conditions-answer-form')).toBeInTheDocument();
    expect(screen.getByTestId('approval-waiting-on')).toHaveTextContent(/Waiting on you to answer Nora's conditions/);
  });

  test('the approver who asked keeps the decision controls as the composer', async () => {
    mount({ approvals: [tier1, tier2Asked], messages: [internalQ, relayed, marker], actor: { email: 'nora@x.io', name: 'Nora Security', kind: 'admin', workspaceRole: 'admin' } });
    const slot = await screen.findByTestId('approval-composer-slot');
    expect(slot).toHaveAttribute('data-mode', 'approver');
    expect(within(slot).getByRole('tab', { name: /^Approve$/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('approval-waiting-on')).toHaveTextContent(/Waiting on Rita Requester to answer your question/));
    // No "Answer" under your own question.
    expect(screen.queryByRole('button', { name: /^Answer$/ })).toBeNull();
  });
});
