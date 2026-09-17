/** @vitest-environment jsdom */
// 17 Sep 2026 — the decision belongs to the named approver alone. Vahid (admin,
// Tier 1, and the requester) saw an Approve button on Neville's Tier-2 row.
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('../../services/api', () => ({ ticketsAPI: { approvalMessages: vi.fn(() => Promise.resolve({ data: [] })) } }));
vi.mock('../../hooks/useRequesterPhoto', () => ({ useRequesterPhoto: () => null }));

import ApprovalTimeline from './ApprovalTimeline';

const row = {
  id: 66, status: 'pending', tier: 2, approverEmail: 'nvyland@x.io', approverName: null,
  requestedBy: 'vhaeri@x.io', requestNote: 'Hi Neville, please review and advise.',
  createdAt: new Date().toISOString(), requestGroupId: 'g1', escalationLog: [],
};
const members = [
  { email: 'nvyland@x.io', name: 'Neville Vyland', role: 'admin', photoUrl: null },
  { email: 'vhaeri@x.io', name: 'Vahid Haeri', role: 'admin', photoUrl: null },
  { email: 'ada@x.io', name: 'Ada Agent', role: 'technician', photoUrl: null },
];
const metaFor = (actor) => ({ actor, technicians: [], members });
const mount = (actor) => render(
  <ApprovalTimeline
    approvals={[row]}
    meta={metaFor(actor)}
    ticketId={44036}
    onDecide={vi.fn()}
    onForward={vi.fn()}
    onEscalate={vi.fn()}
    onCancel={vi.fn()}
    onResubmit={vi.fn()}
  />,
);

afterEach(cleanup);

describe('who may decide an approval row', () => {
  test('an admin who is not the named approver sees no Approve/Reject — only "Waiting on" and Forward', async () => {
    mount({ email: 'vhaeri@x.io', kind: 'admin', workspaceRole: 'admin' });
    // Row label reads the roster name for an app-only member (no approverName stored).
    expect((await screen.findAllByText('Neville Vyland')).length).toBeGreaterThan(0);
    expect(screen.getByTestId('approval-waiting-on')).toHaveTextContent(/Waiting on Neville Vyland — only they can decide/);
    expect(screen.queryByRole('tab', { name: /^Approve$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Reject/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Ask a question/ })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Forward/ })).toBeInTheDocument();
  });

  test('the named approver gets the full composer', async () => {
    mount({ email: 'nvyland@x.io', kind: 'admin', workspaceRole: 'admin' });
    expect(await screen.findByRole('tab', { name: /^Approve$/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Reject/ })).toBeInTheDocument();
    expect(screen.queryByTestId('approval-waiting-on')).not.toBeInTheDocument();
  });

  test('a technician who is neither approver nor admin sees who holds it and nothing to press', async () => {
    mount({ email: 'ada@x.io', kind: 'agent', workspaceRole: 'technician' });
    expect(await screen.findByTestId('approval-waiting-on')).toHaveTextContent(/Neville Vyland/);
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });
});
