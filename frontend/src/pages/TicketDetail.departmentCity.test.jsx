/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// QA 11-24 #1 — the sidebar showed "DEPARTMENT: Contracts III · Vancouver":
// Entra's job class + level and the office in one field. Department and City
// are now two read-only rows: the job class without its level, and the city.

const TICKET = {
  id: 501,
  origin: 'ticketpulse',
  nativeNumber: 1076,
  displayRef: 'TP-1076',
  subject: 'New AP project intake',
  description: '<p>Set up the books</p>',
  descriptionText: 'Set up the books',
  status: 'Open',
  priority: 2,
  ticketType: 'Incident',
  createdAt: '2026-08-07T10:00:00Z',
  updatedAt: '2026-08-07T10:05:00Z',
  lastActivityAt: '2026-08-07T10:05:00Z',
  requester: { id: 40, name: 'Rita Requester', email: 'rita@example.com', entraJobTitle: 'Contracts Administrator', entraDepartment: 'Contracts III', entraOfficeLocation: 'Vancouver', entraCity: null, department: 'Vancouver' },
  assignedTech: null,
  internalCategory: null,
  internalSubcategory: null,
  groupId: null,
  internalGroupId: 3458,
  internalGroup: { id: 3458, name: 'Project Accounting', origin: 'local' },
  tags: [],
  activities: [],
  approvals: [],
  attachments: [],
  mergedInto: null,
  stateChip: null,
  thread: [],
};

const META = {
  nativeTicketingEnabled: true,
  technicians: [],
  categoryTree: [],
  categoryGroupLinks: [],
  groups: [
    { id: 3458, freshserviceId: null, name: 'Project Accounting', origin: 'local' },
    { id: 3459, freshserviceId: null, name: 'AR Desk', origin: 'local' },
    { id: 7, freshserviceId: '1000210021', name: 'IT Operations', origin: 'freshservice' },
  ],
  tags: [],
  approvalCategories: [],
  statuses: [],
  actor: { kind: 'admin', email: 'ada@example.com', workspaceRole: 'admin', technicianId: null },
};

let currentTicket = TICKET;

const pending = () => new Promise(() => {});
const apiOverrides = {
  get: vi.fn(() => Promise.resolve({ data: currentTicket })),
  meta: vi.fn(() => Promise.resolve({ data: META })),
  update: vi.fn(() => Promise.resolve({ data: {} })),
  getDepartmentMap: vi.fn(() => pending()),
};

vi.mock('../services/api', () => ({
  ticketsAPI: new Proxy({}, { get: (_t, prop) => apiOverrides[prop] || pending }),
  assignmentAPI: new Proxy({}, { get: () => pending }),
}));
vi.mock('../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ workspaceId: 1, currentWorkspace: { id: 1, name: 'IT' }, availableWorkspaces: [] }),
}));
vi.mock('../components/nav/navDestinations', () => ({
  useWorkspaceRole: () => ({ role: 'admin', canManage: true, canReview: true }),
  NAV_DESTINATIONS: [],
}));
vi.mock('../hooks/useSSE', () => ({ useSSE: vi.fn() }));
vi.mock('../hooks/useTicketPresence', () => ({
  useTicketPresence: () => ({ viewers: [], onPresence: vi.fn() }),
}));
vi.mock('../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ activeTypes: [], types: [], typeByName: () => null }),
}));
vi.mock('../components/AppHeader', () => ({ default: () => <div>AppHeader</div> }));
vi.mock('../components/nav/MobileTabBar', () => ({ default: () => null }));
vi.mock('../components/tickets/ThreadSummaryCard', () => ({ default: () => null }));
vi.mock('../components/tickets/ProposedReplyCard', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketFamilyCard', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketAiTab', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketTasksTab', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketTagEditor', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketOpsCards', () => ({
  CustomFieldsCard: () => null,
  MacroMenu: () => null,
  TicketLinksCard: () => null,
}));
vi.mock('../components/tickets/AssigneePicker', () => ({ default: () => null }));
vi.mock('../components/tickets/DueDateEditor', () => ({ default: () => null }));
vi.mock('../components/tickets/MobileAssignSheet', () => ({ default: () => null }));
vi.mock('../components/tickets/AiAssignModal', () => ({ default: () => null }));
vi.mock('../components/tickets/FsSyncConfirm', () => ({ default: () => null }));
vi.mock('../components/tickets/RequestApprovalModal', () => ({ default: () => null }));
vi.mock('../components/tickets/MergeTicketsModal', () => ({ default: () => null }));
vi.mock('../components/tickets/AttachmentPreviewModal', () => ({ default: () => null }));
vi.mock('../components/tickets/ImageMarkupModal', () => ({ default: () => null }));
vi.mock('../components/tickets/ApprovalTimeline', () => ({ default: () => null }));
vi.mock('../components/tickets/StagedFileChip', () => ({ default: () => null }));
vi.mock('../components/tickets/RichTextEditor', async () => {
  const { forwardRef } = await import('react');
  return {
    default: forwardRef((_props, _ref) => <textarea aria-label="editor" />),
    isRichContent: () => false,
  };
});

import TicketDetail from './TicketDetail';
import { resetDepartmentMap } from '../utils/requesterDepartment';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/tickets/501']}>
      <Routes>
        <Route path="/tickets/:id" element={<TicketDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}


describe('TicketDetail — Department and City apart (QA 11-24 #1)', () => {
  beforeEach(() => {
    localStorage.clear();
    currentTicket = TICKET;
    resetDepartmentMap();
    apiOverrides.getDepartmentMap.mockImplementation(() => pending());
  });
  afterEach(() => cleanup());

  test('two rows: the job class without its level, and the city', async () => {
    renderPage();
    expect(await screen.findByTestId('requester-department')).toHaveTextContent(/^Contracts$/);
    expect(screen.getByTestId('requester-city')).toHaveTextContent(/^Vancouver$/);
    expect(screen.queryByText(/Contracts III · Vancouver/)).not.toBeInTheDocument();
    // The requester card's role line uses the clean department too.
    expect(screen.getByText('Contracts Administrator · Contracts')).toBeInTheDocument();
  });

  test('no Entra profile: the FreshService "department" is the city, and Department is blank', async () => {
    currentTicket = { ...TICKET, department: 'Kamloops', requester: { id: 41, name: 'Kim Field', email: 'kim@example.com', department: null } };
    renderPage();
    expect(await screen.findByTestId('requester-department')).toHaveTextContent('—');
    expect(screen.getByTestId('requester-city')).toHaveTextContent('Kamloops');
  });

  test("an admin's department_map override is used once it loads", async () => {
    apiOverrides.getDepartmentMap.mockImplementation(() => Promise.resolve({ data: { effective: { Contracts: 'Legal & Contracts' } } }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId('requester-department')).toHaveTextContent('Legal & Contracts'));
  });
});