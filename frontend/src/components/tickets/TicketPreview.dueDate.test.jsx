/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TicketPreview from './TicketPreview';
import { ticketsAPI } from '../../services/api';

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
// TypePill (ticketUi) reads the per-workspace type registry via useWorkspace —
// stub the hook so the preview renders without a WorkspaceProvider tree.
vi.mock('../../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ types: [], activeTypes: [], defaultType: null, typeByName: () => null, loading: false, refresh: () => {} }),
  invalidateTicketTypesCache: () => {},
}));

const baseTicket = {
  id: 7,
  displayRef: 'TP-1042',
  origin: 'ticketpulse',
  freshserviceTicketId: null,
  subject: 'Laptop will not boot',
  status: 'Open',
  priority: 2,
  createdAt: '2026-08-01T10:00:00.000Z',
  dueBy: '2026-08-08T23:59:00.000Z',
  frDueBy: null,
  firstPublicAgentReplyAt: null,
  resolvedAt: null,
  closedAt: null,
  assignedTechId: null,
  assignedTech: null,
  requester: { id: 40, name: 'Rita Requester', email: 'rita@example.com' },
  thread: [],
  activities: [],
  pipelineRuns: [],
  tags: [],
};

const meta = { nativeTicketingEnabled: true, technicians: [], groups: [], sources: [], actor: {} };

const renderPreview = (ticket) => {
  ticketsAPI.get.mockResolvedValue({ data: ticket });
  return render(
    <MemoryRouter initialEntries={['/tickets?peek=7']}>
      <TicketPreview ticketId={7} meta={meta} onClose={vi.fn()} />
    </MemoryRouter>,
  );
};

// QA 08-04 #13: the peek panel carries a pencil that DEEP-LINKS to the full
// ticket (where the due-date editor lives) — TP-born only, never inline.
describe('TicketPreview due-date affordance', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  test('TP-born: Resolution row shows the deep-link pencil', async () => {
    renderPreview(baseTicket);
    await waitFor(() => expect(screen.getByText('Laptop will not boot')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /edit resolution due date on the full ticket/i })).toBeInTheDocument();
  });

  test('TP-born without a due date still offers the row ("Not set" + pencil)', async () => {
    renderPreview({ ...baseTicket, dueBy: null });
    await waitFor(() => expect(screen.getByText('Laptop will not boot')).toBeInTheDocument());
    expect(screen.getByText('Not set')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit resolution due date on the full ticket/i })).toBeInTheDocument();
  });

  test('FS-born: no pencil — read-only with the "FreshService owns this date" tooltip', async () => {
    renderPreview({
      ...baseTicket,
      origin: 'freshservice',
      freshserviceTicketId: 231309,
      dueBy: '2026-08-08T23:59:00.000Z',
    });
    await waitFor(() => expect(screen.getByText('Laptop will not boot')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /edit resolution due date/i })).not.toBeInTheDocument();
    expect(screen.getByTitle(/FreshService owns this date/i)).toBeInTheDocument();
  });
});
