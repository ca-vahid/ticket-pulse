/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TicketPreview from './TicketPreview';
import { ticketsAPI } from '../../services/api';

// FreshService switch (25 Nov 2026) in the peek drawer:
//  - Off: no "Open in FreshService", the imported line instead;
//  - meta missing or failed: today's default (FreshService on), never a stuck hold;
//  - hold only while the caller says meta is still loading.

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

const FS_BORN = {
  id: 7, displayRef: '#900021', origin: 'freshservice', freshserviceTicketId: 900021, mirrorState: null,
  subject: 'Invoice not paid', status: 'Closed', priority: 2, createdAt: '2026-11-01T10:00:00.000Z',
  dueBy: null, frDueBy: null, firstPublicAgentReplyAt: null, resolvedAt: null, closedAt: null,
  assignedTechId: null, assignedTech: null, requester: { id: 40, name: 'Rita Requester', email: 'rita@example.com' },
  thread: [], activities: [], pipelineRuns: [], tags: [],
};
const META = { nativeTicketingEnabled: true, technicians: [], groups: [], sources: [], actor: {} };

const renderPreview = (props) => {
  ticketsAPI.get.mockResolvedValue({ data: FS_BORN });
  return render(
    <MemoryRouter initialEntries={['/tickets?peek=7']}>
      <TicketPreview ticketId={7} onClose={vi.fn()} {...props} />
    </MemoryRouter>,
  );
};
const ready = () => waitFor(() => expect(screen.getByText('Invoice not paid')).toBeInTheDocument());

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('TicketPreview and the FreshService switch', () => {
  test('connected: Open in FreshService, no imported line', async () => {
    renderPreview({ meta: META });
    await ready();
    expect(screen.getByRole('link', { name: /Open in FreshService/ })).toBeInTheDocument();
    expect(screen.queryByTestId('fs-imported-line')).not.toBeInTheDocument();
  });

  test('Off: no FreshService link; the imported line', async () => {
    renderPreview({ meta: { ...META, freshserviceEnabled: false } });
    await ready();
    expect(screen.queryByRole('link', { name: /Open in FreshService/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('fs-imported-line')).toHaveTextContent('Imported from FreshService #900021');
  });

  test('meta missing or failed: falls back to FreshService on (never a stuck hold)', async () => {
    renderPreview({ meta: null });
    await ready();
    expect(screen.getByRole('link', { name: /Open in FreshService/ })).toBeInTheDocument();
    expect(screen.queryByTestId('fs-imported-line')).not.toBeInTheDocument();
  });

  test('while the caller says meta is still loading: hold', async () => {
    renderPreview({ meta: null, metaPending: true });
    await ready();
    expect(screen.queryByRole('link', { name: /Open in FreshService/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('fs-imported-line')).not.toBeInTheDocument();
  });
});
