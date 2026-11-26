/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// FreshService switch (25 Nov 2026) on the ticket page:
//  - connected (and an old meta without the flag): FreshService-born tickets
//    keep the "FreshService owns this" strip, Open in FreshService and Edit;
//  - Off: an FS-born ticket is imported history — no strip, no FS link, no
//    Edit, one "Imported from FreshService" line with Adopt to edit;
//  - adopted: normal Ticket Pulse editing, "Adopted from FreshService #n",
//    no mirror chip; the line links only while FreshService exists.

const BASE = {
  id: 501, subject: 'Invoice not paid', description: '<p>Please check</p>', descriptionText: 'Please check',
  status: 'Closed', priority: 2, ticketType: 'Incident',
  createdAt: '2026-11-02T18:00:00Z', updatedAt: '2026-11-03T18:00:00Z', lastActivityAt: '2026-11-03T18:00:00Z',
  requesterId: 40, requester: { id: 40, name: 'Rita Requester', email: 'rita@example.com' },
  assignedTech: null, internalCategory: null, internalSubcategory: null,
  toEmails: [], ccEmails: [], replyCcEmails: [], fwdEmails: [], tags: [], activities: [], approvals: [], attachments: [],
  mergedInto: null, stateChip: null, thread: [],
};
const FS_BORN = { ...BASE, origin: 'freshservice', freshserviceTicketId: '900004', displayRef: '#900004', mirrorState: null };
const ADOPTED = {
  ...BASE, status: 'Open', origin: 'ticketpulse', nativeNumber: 1500, displayRef: 'TP-1500', freshserviceTicketId: '900004', mirrorState: 'adopted',
  activities: [{ id: 1, activityType: 'adopted_from_freshservice', performedBy: 'Agent', performedAt: '2026-12-02T18:00:00Z', details: { fsTicketId: '900004' } }],
};

const META = {
  nativeTicketingEnabled: true, technicians: [], categoryTree: [], categoryGroupLinks: [], groups: [], tags: [],
  approvalCategories: [], statuses: [],
  actor: { kind: 'admin', email: 'qa@example.com', workspaceRole: 'admin', technicianId: 12 },
};
const META_OFF = { ...META, freshserviceEnabled: false, freshserviceMode: 'off' };

const pending = () => new Promise(() => {});
const apiOverrides = {};

vi.mock('../services/api', () => ({
  ticketsAPI: new Proxy({}, { get: (_t, prop) => apiOverrides[prop] || pending }),
  assignmentAPI: new Proxy({}, { get: () => pending }),
  agentAPI: new Proxy({}, { get: () => pending }),
}));
vi.mock('../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ workspaceId: 5, currentWorkspace: { id: 5, name: 'Project Accounting' }, availableWorkspaces: [] }),
}));
vi.mock('../components/nav/navDestinations', () => ({
  useWorkspaceRole: () => ({ role: 'admin', canManage: true, canReview: true }),
  NAV_DESTINATIONS: [],
}));
vi.mock('../hooks/useSSE', () => ({ useSSE: vi.fn() }));
vi.mock('../hooks/useTicketPresence', () => ({ useTicketPresence: () => ({ viewers: [], onPresence: vi.fn() }) }));
vi.mock('../hooks/useTicketTypes', () => ({ useTicketTypes: () => ({ activeTypes: [], types: [], typeByName: () => null }) }));
vi.mock('../components/AppHeader', () => ({ default: () => <div>AppHeader</div> }));
vi.mock('../components/nav/MobileTabBar', () => ({ default: () => null }));
vi.mock('../components/tickets/ThreadSummaryCard', () => ({ default: () => null }));
vi.mock('../components/tickets/ProposedReplyCard', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketFamilyCard', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketAiTab', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketTasksTab', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketTagEditor', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketOpsCards', () => ({ CustomFieldsCard: () => null, MacroMenu: () => null, TicketLinksCard: () => null }));
vi.mock('../components/tickets/AssigneePicker', () => ({ default: () => null }));
vi.mock('../components/tickets/DueDateEditor', () => ({ default: () => null }));
vi.mock('../components/tickets/MobileAssignSheet', () => ({ default: () => null }));
vi.mock('../components/tickets/AiAssignModal', () => ({ default: () => null }));
vi.mock('../components/tickets/RequestApprovalModal', () => ({ default: () => null }));
vi.mock('../components/tickets/MergeTicketsModal', () => ({ default: () => null }));
vi.mock('../components/tickets/AttachmentPreviewModal', () => ({ default: () => null }));
vi.mock('../components/tickets/ImageMarkupModal', () => ({ default: () => null }));
vi.mock('../components/tickets/ApprovalTimeline', () => ({ default: () => null }));
vi.mock('../components/tickets/StagedFileChip', () => ({ default: () => null }));
vi.mock('../components/tickets/ComposerSignatureStrip', () => ({ default: () => null }));
vi.mock('../components/tickets/CcChips', () => ({ default: () => null }));
vi.mock('../components/tickets/RichTextEditor', async () => {
  const { forwardRef } = await import('react');
  return { default: forwardRef(({ ariaLabel }, _ref) => <textarea aria-label={ariaLabel || 'editor'} />), isRichContent: () => false };
});

import TicketDetail from './TicketDetail';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/tickets/501']}>
      <Routes><Route path="/tickets/:id" element={<TicketDetail />} /></Routes>
    </MemoryRouter>,
  );
}
const ready = async () => { renderPage(); await screen.findByRole('region', { name: 'Ticket description' }); };
const setup = (ticket, meta) => {
  apiOverrides.get = vi.fn(() => Promise.resolve({ data: ticket }));
  apiOverrides.meta = vi.fn(() => Promise.resolve({ data: meta }));
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  for (const k of Object.keys(apiOverrides)) delete apiOverrides[k];
  apiOverrides.requesterPhoto = vi.fn(() => Promise.resolve({ data: { photo: null } }));
  apiOverrides.requesterStats = vi.fn(() => Promise.resolve({ data: { total: 1 } }));
});
afterEach(() => cleanup());

describe('connected (unchanged)', () => {
  test('an old meta without the flag: FreshService strip, Open in FreshService, Edit; no imported line', async () => {
    setup({ ...FS_BORN, status: 'Open' }, META);
    await ready();
    await waitFor(() => expect(apiOverrides.meta).toHaveBeenCalled());
    expect(screen.getByTestId('fs-owner-strip')).toHaveTextContent('FreshService owns this ticket');
    expect(screen.getByRole('link', { name: /Open in FreshService/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.queryByTestId('fs-imported-line')).not.toBeInTheDocument();
  });
});

describe('before meta loads ("hold")', () => {
  test('an FS-born ticket shows no FreshService-only affordance until meta says connected, then looks as before', async () => {
    let landMeta;
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: { ...FS_BORN, status: 'Open' } }));
    apiOverrides.meta = vi.fn(() => new Promise((r) => { landMeta = () => r({ data: META }); }));
    await ready();
    expect(screen.queryByTestId('fs-owner-strip')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open in FreshService/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('fs-imported-line')).not.toBeInTheDocument();

    landMeta();
    expect(await screen.findByTestId('fs-owner-strip')).toHaveTextContent('FreshService owns this ticket');
    expect(screen.getByRole('link', { name: /Open in FreshService/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.queryByTestId('fs-imported-line')).not.toBeInTheDocument();
  });
});

describe('meta fails', () => {
  test('retries once after ~2 s, then falls back to FreshService on: strip, link and Edit as before', async () => {
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: { ...FS_BORN, status: 'Open' } }));
    apiOverrides.meta = vi.fn(() => Promise.reject(new Error('Network Error')));
    await ready();
    expect(screen.queryByTestId('fs-owner-strip')).not.toBeInTheDocument(); // still holding during the retry
    await waitFor(() => expect(apiOverrides.meta).toHaveBeenCalledTimes(2), { timeout: 4000 });
    expect(await screen.findByTestId('fs-owner-strip', {}, { timeout: 2000 })).toHaveTextContent('FreshService owns this ticket');
    expect(screen.getByRole('link', { name: /Open in FreshService/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.queryByTestId('fs-imported-line')).not.toBeInTheDocument();
  }, 10000);

  test('a retry that succeeds uses the real answer (Off → imported)', async () => {
    apiOverrides.get = vi.fn(() => Promise.resolve({ data: FS_BORN }));
    apiOverrides.meta = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new Error('Network Error')))
      .mockImplementationOnce(() => Promise.resolve({ data: META_OFF }));
    await ready();
    expect(await screen.findByTestId('fs-imported-line', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByTestId('fs-owner-strip')).not.toBeInTheDocument();
  }, 10000);
});

describe('FreshService off', () => {
  test('an FS-born ticket is imported history: no FS strip, link or Edit; Adopt to edit adopts and reloads', async () => {
    setup(FS_BORN, META_OFF);
    apiOverrides.adopt = vi.fn(() => {
      apiOverrides.get = vi.fn(() => Promise.resolve({ data: ADOPTED }));
      return Promise.resolve({ data: { id: 501, displayRef: 'TP-1500', mirrorState: 'adopted' } });
    });
    await ready();
    const line = await screen.findByTestId('fs-imported-line');
    expect(line).toHaveTextContent('Imported from FreshService #900004 · read-only');
    expect(screen.queryByTestId('fs-owner-strip')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open in FreshService/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete in FreshService/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Adopt to edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Adopt' }));
    await waitFor(() => expect(apiOverrides.adopt).toHaveBeenCalledWith(501));
    expect(await screen.findByTestId('fs-adopted-line')).toHaveTextContent('Adopted from FreshService #900004 on 2 Dec');
    expect(screen.getByText(/Adopted — now TP-1500/)).toBeInTheDocument();
  });

  test('an adopted ticket: normal editing, plain adopted line, no mirror chip', async () => {
    setup(ADOPTED, META_OFF);
    await ready();
    const line = await screen.findByTestId('fs-adopted-line');
    expect(line).toHaveTextContent('Adopted from FreshService #900004 on 2 Dec');
    expect(line.querySelector('a')).toBeNull();
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.queryByTestId('mirror-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fs-owner-strip')).not.toBeInTheDocument();
  });
});

describe('adopted while connected', () => {
  test('the adopted line links to the old ticket; still no mirror chip', async () => {
    setup(ADOPTED, { ...META, freshserviceEnabled: true, freshserviceMode: 'shadow' });
    await ready();
    const line = await screen.findByTestId('fs-adopted-line');
    await waitFor(() => expect(line.querySelector('a')).not.toBeNull());
    expect(line.querySelector('a')).toHaveAttribute('href', expect.stringMatching(/\/a\/tickets\/900004$/));
    expect(screen.queryByTestId('mirror-badge')).not.toBeInTheDocument();
  });
});
