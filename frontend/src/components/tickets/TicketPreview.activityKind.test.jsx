/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TicketPreview from './TicketPreview';
import { ticketsAPI } from '../../services/api';

// MEGA 09-01 TU-2 — peek Activity tab parity: actor-kind chip per row and the
// per-viewer "hide machine activity" preference (default ON) with a count.

vi.mock('../../services/api', () => ({
  ticketsAPI: {
    get: vi.fn(),
    requesterPhoto: vi.fn().mockResolvedValue({ data: { photo: null } }),
    requesterStats: vi.fn().mockResolvedValue({ data: null }),
    fsUpdate: vi.fn(),
    remove: vi.fn(),
  },
  assignmentAPI: {},
}));
vi.mock('./AssigneePicker', () => ({ default: () => null }));
vi.mock('./AiAssignModal', () => ({ default: () => null }));
vi.mock('./FsSyncConfirm', () => ({ default: () => null }));
vi.mock('../nav/navDestinations', () => ({ useWorkspaceRole: () => 'admin' }));
vi.mock('../../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ types: [], activeTypes: [], defaultType: null, typeByName: () => null, loading: false, refresh: () => {} }),
  invalidateTicketTypesCache: () => {},
}));

const ticket = {
  id: 7,
  displayRef: '#237051',
  origin: 'freshservice',
  freshserviceTicketId: 237051,
  subject: 'PMT-FC 19279',
  status: 'Closed',
  priority: 3,
  createdAt: '2026-08-11T16:03:00.000Z',
  dueBy: null,
  frDueBy: null,
  firstPublicAgentReplyAt: null,
  resolvedAt: null,
  closedAt: null,
  assignedTechId: null,
  assignedTech: null,
  requester: { id: 40, name: '1800 Recevables', email: 'ar@vendor.example.com' },
  thread: [],
  pipelineRuns: [],
  tags: [],
  activities: [
    { id: 1, activityType: 'fields_updated', performedBy: 'Kirsten Fanning', performedAt: '2026-08-18T10:00:00.000Z', actorKind: 'human', details: {} },
    { id: 2, activityType: 'status_changed', performedBy: 'Dominic Bautista (FreshService)', performedAt: '2026-08-18T14:47:27.000Z', actorKind: 'freshservice_sync', details: { actorName: 'Dominic Bautista', newStatus: 'Closed' } },
    { id: 3, activityType: 'status_changed', performedBy: 'FreshService', performedAt: '2026-08-18T11:00:00.000Z', actorKind: 'reconcile', details: { newStatus: 'Spam' } },
    { id: 4, activityType: 'mirror_conflict', performedBy: 'Mirror reconciliation', performedAt: '2026-08-18T11:03:00.000Z', actorKind: 'mirror', details: {} },
  ],
};
const meta = { nativeTicketingEnabled: true, technicians: [], groups: [], sources: [], actor: {} };

async function openActivity() {
  ticketsAPI.get.mockResolvedValue({ data: ticket });
  render(
    <MemoryRouter initialEntries={['/tickets?peek=7']}>
      <TicketPreview ticketId={7} meta={meta} onClose={vi.fn()} />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText('PMT-FC 19279')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('tab', { name: /^activity$/i }));
}

describe('TicketPreview activity tab actor kinds (TU-2)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  test('default: machine rows hidden with a count, visible rows carry kind chips', async () => {
    await openActivity();
    expect(screen.getByTestId('peek-machine-hidden')).toHaveTextContent('2 machine events hidden');
    const kinds = screen.getAllByTestId('actor-kind-chip').map((c) => c.getAttribute('data-kind'));
    expect(kinds).toEqual(expect.arrayContaining(['human', 'freshservice_sync']));
    expect(kinds).not.toContain('reconcile');
    expect(kinds).not.toContain('mirror');
    expect(screen.queryByText(/Mirror reconciliation/)).not.toBeInTheDocument();
  });

  test('viewer preference off → everything shows, no count', async () => {
    localStorage.setItem('tp.ticketHistory.hideMachine', 'false');
    await openActivity();
    expect(screen.queryByTestId('peek-machine-hidden')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('actor-kind-chip').map((c) => c.getAttribute('data-kind'))).toEqual(expect.arrayContaining(['reconcile', 'mirror']));
  });
});
