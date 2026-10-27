/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../services/api', () => ({ ticketsAPI: {} }));
vi.mock('../../hooks/useRequesterPhoto', () => ({ useRequesterPhoto: () => null }));
afterEach(cleanup);
import ApprovalThread, { roleLabel } from './ApprovalThread';

// Ticket 65030 (27 Oct 2026): an internal question read "To Seifeddine
// Reguige, Vahid Haeri" with no hint of who they were or that the requester
// was never asked, and the escalation showed twice.

const people = [
  { email: 'sam@x.io', name: 'Sam Muller' },
  { email: 'seif@x.io', name: 'Seif Reguige' },
  { email: 'vahid@x.io', name: 'Vahid Haeri' },
  { email: 'neville@x.io', name: 'Neville Vyland' },
];
const participants = {
  requester: { email: 'sam@x.io', name: 'Sam Muller' },
  agent: { email: 'seif@x.io' },
  approvers: [{ email: 'vahid@x.io', tier: 1 }, { email: 'neville@x.io', tier: 2 }],
  tierCount: 2,
};
const handoff = { at: '2026-10-26T17:12:35.449Z', kind: 'escalated', note: 'Neville, please review', byName: 'Vahid Haeri', byEmail: 'vahid@x.io', fromTier: 1, toTier: 2, toEmails: ['neville@x.io'] };
const approval = { id: 171, createdAt: '2026-10-26T15:07:57Z', escalationLog: [handoff, { ...handoff }] };
const question = {
  id: 70, kind: 'question', audience: 'internal', author: { email: 'neville@x.io', name: 'Neville Vyland', role: 'approver' },
  bodyText: 'Who will use it?', to: ['seif@x.io', 'vahid@x.io'], cc: [], createdAt: '2026-10-26T19:30:35Z',
};

describe('ApprovalThread — who an internal question went to', () => {
  test('roleLabel names the part each person plays', () => {
    expect(roleLabel('SAM@x.io', participants)).toBe('requester');
    expect(roleLabel('seif@x.io', participants)).toBe('agent');
    expect(roleLabel('neville@x.io', participants)).toBe('Tier 2 approver');
    expect(roleLabel('vahid@x.io', { ...participants, tierCount: 1 })).toBe('approver');
    expect(roleLabel('x@x.io', participants)).toBeNull();
  });

  test('the To line carries roles and says the requester was not asked; the escalation shows once', () => {
    render(<ApprovalThread approval={approval} messages={[question]} people={people} participants={participants} viewerEmail="vahid@x.io" viewerRole="admin" />);
    expect(screen.getByText(/To Seif Reguige \(agent\), Vahid Haeri \(Tier 1 approver\)/)).toBeInTheDocument();
    expect(screen.getByText(/Sam Muller \(requester\) not asked/)).toBeInTheDocument();
    expect(document.querySelectorAll('[data-kind="handoff"]')).toHaveLength(1);
  });

  test('"Ask Sam instead" confirms in place, then sends', async () => {
    const onAskRequester = vi.fn().mockResolvedValue({});
    render(<ApprovalThread approval={approval} messages={[question]} people={people} participants={participants} viewerEmail="vahid@x.io" viewerRole="admin" onAskRequester={onAskRequester} />);
    fireEvent.click(screen.getByRole('button', { name: /Ask Sam instead/ }));
    expect(screen.getByText(/Sam Muller gets Neville's question by e-mail/)).toBeInTheDocument();
    expect(screen.getByText(/Seif, Neville and you are on Cc/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Send to Sam/ }));
    await waitFor(() => expect(onAskRequester).toHaveBeenCalledWith(expect.objectContaining({ id: 70 })));
  });

  test('no button once the question is answered, for someone outside the request, or on a requester question', () => {
    const answered = { id: 71, kind: 'answer', audience: 'internal', inReplyToId: 70, author: { email: 'vahid@x.io' }, bodyText: 'Sent to Sam', createdAt: '2026-10-27T10:00:00Z' };
    const { rerender } = render(<ApprovalThread approval={approval} messages={[question, answered]} people={people} participants={participants} viewerEmail="vahid@x.io" viewerRole="admin" onAskRequester={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Ask Sam instead/ })).toBeNull();
    rerender(<ApprovalThread approval={approval} messages={[question]} people={people} participants={participants} viewerEmail="someone@x.io" viewerRole="agent" onAskRequester={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Ask Sam instead/ })).toBeNull();
    rerender(<ApprovalThread approval={approval} messages={[{ ...question, audience: 'requester', to: ['sam@x.io'] }]} people={people} participants={participants} viewerEmail="vahid@x.io" viewerRole="admin" onAskRequester={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Ask Sam instead/ })).toBeNull();
    expect(screen.queryByText(/not asked/)).toBeNull();
  });
});
