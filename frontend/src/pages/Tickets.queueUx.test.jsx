/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Queue UX batch contract tests (FR 08-07 Phase 3 — items #6/#7/#12 + the
// deferred Phase-2 non-destructive-refresh item):
//  - the xl-only Requester column keeps header/row track parity,
//  - subject / ref / chevron are REAL anchors with modifier-aware clicks,
//  - board mode fetches a 50-row page and the pagination math follows,
//  - URL churn with unchanged query values never blanks selection or refetches.
const { listSpy, metaSpy, statsSpy, decideSpy, roleRef } = vi.hoisted(() => ({
  listSpy: vi.fn(),
  metaSpy: vi.fn(),
  statsSpy: vi.fn(),
  decideSpy: vi.fn(),
  // Mutable workspace role: the historical default is this OBJECT (which the
  // page's `wsRole === 'admin'` string compare treats as non-reviewer); the
  // AI-visibility tests below set real role STRINGS ('viewer' / 'admin').
  roleRef: { value: { role: 'admin', canManage: true, canReview: true } },
}));

vi.mock('../services/api', () => ({
  ticketsAPI: new Proxy(
    { list: listSpy, meta: metaSpy, stats: statsSpy },
    { get: (target, key) => target[key] || (() => new Promise(() => {})) },
  ),
  assignmentAPI: { decide: decideSpy, latestRun: vi.fn(() => new Promise(() => {})) },
  getGlobalExcludeNoise: vi.fn(() => false),
  setGlobalExcludeNoise: vi.fn(),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { email: 'qa@example.com', role: 'admin' }, logout: vi.fn() }),
}));
vi.mock('../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspace: { id: 1, name: 'IT', slug: 'it' }, availableWorkspaces: [] }),
}));
vi.mock('../components/nav/navDestinations', () => ({
  useWorkspaceRole: () => roleRef.value,
  NAV_DESTINATIONS: [],
}));
vi.mock('../hooks/useSSE', () => ({ useSSE: vi.fn() }));
vi.mock('../components/AppHeader', () => ({ default: () => <div>AppHeader</div> }));
vi.mock('../components/nav/MobileTabBar', () => ({ default: () => null }));
// Observable peek: plain-click behavior must still open the preview drawer.
vi.mock('../components/tickets/TicketPreview', () => ({
  default: ({ ticketId }) => <div>PEEK {ticketId}</div>,
}));
vi.mock('../components/tickets/ScheduledTicketsPanel', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketFilterRail', () => ({
  default: () => null,
  ActiveFilterBar: () => null,
}));
// Marker render so the AI-visibility tests can assert whether the reviewer
// modal opened (it only mounts when the page sets aiTicket).
vi.mock('../components/tickets/AiAssignModal', () => ({ default: () => <div>AI MODAL</div> }));
vi.mock('../components/tickets/MobileAssignSheet', () => ({ default: () => null }));
vi.mock('../assets/tickets-hero.png', () => ({ default: 'hero.png' }));

import Tickets from './Tickets';

const XL_COMPACT_TEMPLATE = 'xl:grid-cols-[6px_minmax(0,2.4fr)_150px_minmax(150px,1fr)_210px_116px_88px_74px]';
const XL_ROOMY_TEMPLATE = 'xl:grid-cols-[6px_60px_150px_minmax(150px,1fr)_210px_116px_88px_74px]';

const row = (id, status) => ({
  id,
  status,
  subject: `Row ${id}`,
  displayRef: `TP-${id}`,
  priority: 2,
  origin: 'freshservice',
  freshserviceTicketId: null,
  assignedTech: null,
  assignedTechId: null,
  requester: { name: 'Rita Requester', entraOfficeLocation: 'Vancouver HQ' },
  tags: [],
  ai: null,
  createdAt: '2026-08-01T10:00:00Z',
  updatedAt: '2026-08-01T10:00:00Z',
  lastActivityAt: '2026-08-01T10:00:00Z',
});

const lastListParams = () => listSpy.mock.calls.at(-1)[0];

function mount(initialEntry = '/tickets') {
  return render(<Tickets />, {
    wrapper: ({ children }) => <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  roleRef.value = { role: 'admin', canManage: true, canReview: true };
  // onRowClick branches on viewport width — jsdom has no matchMedia. Desktop
  // (matches: true) → plain click peeks instead of navigating.
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: true,
    media: query,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  listSpy.mockResolvedValue({ data: { items: [row(1, 'Open'), row(2, 'Pending')], total: 2 } });
  metaSpy.mockResolvedValue({
    data: {
      workspaceId: 1,
      nativeTicketingEnabled: false,
      technicians: [],
      groups: [],
      categoryTree: [],
      sources: [],
      tags: [],
      actor: { role: 'admin' },
    },
  });
  statsSpy.mockResolvedValue({
    data: { all: 40, open: 12, unassigned: 3, awaiting: 2, awaitingApproval: 0, dueToday: 1, overdue: 1, resolved: 20, deleted: 0, noise: 0, byTechnician: {} },
  });
});

afterEach(cleanup);

describe('Requester column — xl-only with header/row track parity (QA 08-07 #6)', () => {
  test('compact: header + cell share the 8-track xl template; both are hidden below xl', async () => {
    mount();
    await waitFor(() => expect(screen.getAllByText('Row 1').length).toBeGreaterThan(0));

    // Header label exists, sortable, and only shows at xl.
    const reqHeaderBtn = screen.getByRole('button', { name: /^Requester$/ });
    const reqHeaderCell = reqHeaderBtn.closest('span');
    expect(reqHeaderCell).toHaveClass('hidden', 'xl:flex');

    // Header and row ride the SAME grid template (the :115 pairing rule).
    const headerGrid = reqHeaderCell.closest('div');
    expect(headerGrid.className).toContain(XL_COMPACT_TEMPLATE);
    const cells = screen.getAllByTitle('Rita Requester · Vancouver HQ');
    expect(cells.length).toBe(2); // one requester cell per row
    expect(cells[0]).toHaveClass('hidden', 'xl:flex');
    const rowGrid = cells[0].closest('div');
    expect(rowGrid.className).toContain(XL_COMPACT_TEMPLATE);
    // Track parity: header and row place the same number of grid children.
    expect(headerGrid.children.length).toBe(rowGrid.children.length);
    // Office/city subtext fits under the name.
    expect(within(cells[0]).getByText('Vancouver HQ')).toBeInTheDocument();

    // Below xl the meta line keeps the requester — the duplicate is the
    // xl-hidden copy, so exactly one shows at any breakpoint.
    const metaCopies = screen.getAllByText(/Rita Requester/).filter((el) => el.closest('.xl\\:hidden'));
    expect(metaCopies.length).toBeGreaterThan(0);

    // The header sorts by requester.
    fireEvent.click(reqHeaderBtn);
    await waitFor(() => expect(lastListParams().sort).toBe('requester'));
  });

  test('roomy: requester track present at xl and the Ticket header span widens 2/4 → 2/5', async () => {
    localStorage.setItem('tp_ticket_layout', 'roomy');
    mount();
    await waitFor(() => expect(screen.getAllByText('Row 1').length).toBeGreaterThan(0));

    const cells = screen.getAllByTitle('Rita Requester · Vancouver HQ');
    expect(cells[0]).toHaveClass('hidden', 'xl:flex');
    expect(cells[0].closest('div').className).toContain(XL_ROOMY_TEMPLATE);

    // The roomy header's "Ticket" span absorbs the new track at xl so every
    // later label (Assignee/Status/Due/Updated) stays over its own column.
    const ticketHeaderBtn = screen.getByRole('button', { name: /^Ticket$/ });
    const span = ticketHeaderBtn.closest('span');
    expect(span).toHaveClass('[grid-column:2/4]', 'xl:[grid-column:2/5]');
    expect(span.closest('div').className).toContain(XL_ROOMY_TEMPLATE);
  });
});

describe('Row anchors — right-click / new-tab (QA 08-07 #7)', () => {
  test('subject, ref and chevron are <a href> anchors; plain click peeks, Ctrl-click stays native', async () => {
    mount();
    await waitFor(() => expect(screen.getAllByText('Row 1').length).toBeGreaterThan(0));

    // Desktop row + mobile card both render subject anchors (CSS hides one).
    const subject = screen.getAllByRole('link', { name: 'Row 1' })[0];
    const ref = screen.getByRole('link', { name: 'TP-1' });
    const chevron = screen.getAllByTitle('Open full ticket')[0];
    for (const a of [subject, ref, chevron]) {
      expect(a.tagName).toBe('A');
      expect(a).toHaveAttribute('href', '/tickets/1');
    }

    // Ctrl-click: NOT prevented (native new-tab), no peek opens.
    expect(fireEvent.click(subject, { ctrlKey: true })).toBe(true);
    expect(screen.queryByText('PEEK 1')).not.toBeInTheDocument();
    // Cmd-click (mac) too.
    expect(fireEvent.click(ref, { metaKey: true })).toBe(true);
    expect(screen.queryByText('PEEK 1')).not.toBeInTheDocument();

    // Plain left-click: preventDefault + the classic peek flow (220ms timer).
    expect(fireEvent.click(subject)).toBe(false);
    await waitFor(() => expect(screen.getByText('PEEK 1')).toBeInTheDocument());
  });

  test('mobile card subject is an anchor with the same modifier behavior', async () => {
    mount();
    await waitFor(() => expect(screen.getAllByText('Row 2').length).toBeGreaterThan(0));
    const anchors = screen.getAllByRole('link', { name: 'Row 2' });
    expect(anchors.length).toBe(2); // desktop row + mobile card
    for (const a of anchors) expect(a).toHaveAttribute('href', '/tickets/2');
    expect(fireEvent.click(anchors[1], { ctrlKey: true })).toBe(true);
    expect(fireEvent.click(anchors[1])).toBe(false);
  });
});

describe('Board density — 50-card page (QA 08-07 #12)', () => {
  test('list fetches pageSize 25; board fetches 50 and the pagination math follows', async () => {
    listSpy.mockResolvedValue({ data: { items: [row(1, 'Open'), row(2, 'Pending')], total: 60 } });
    mount();
    await waitFor(() => expect(listSpy).toHaveBeenCalled());
    expect(lastListParams().pageSize).toBe(25);
    // 60 tickets at 25/page → 3 pages.
    expect(screen.getAllByRole('button', { name: '3' }).length).toBeGreaterThan(0);
    cleanup();

    localStorage.setItem('tp_ticket_layout', 'board');
    listSpy.mockClear();
    mount();
    await waitFor(() => expect(listSpy).toHaveBeenCalled());
    expect(lastListParams().pageSize).toBe(50);
    // 60 tickets at 50/page → 2 pages, range text follows the derived size.
    await waitFor(() => expect(screen.getAllByText('1–50 of 60').length).toBeGreaterThan(0));
    expect(screen.getAllByRole('button', { name: '2' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: '3' })).not.toBeInTheDocument();
  });

  test('board columns flag page-local counts once total exceeds the 50-card page', async () => {
    localStorage.setItem('tp_ticket_layout', 'board');
    listSpy.mockResolvedValue({ data: { items: [row(1, 'Open')], total: 51 } });
    mount();
    await waitFor(() => expect(screen.getAllByText('on page').length).toBeGreaterThan(0));
  });
});

describe('AI suggestion read/act split (QA 08-19 #2)', () => {
  const aiBlock = {
    runId: 7,
    state: 'suggested',
    techId: 49,
    techName: 'Zoe Dio',
    score: 0.89,
    count: 3,
    candidates: [
      { techId: 49, techName: 'Zoe Dio', score: 0.89 },
      { techId: 50, techName: 'Benjamin Rabel', score: 0.87 },
      { techId: 51, techName: 'Dominic Bautista', score: 0.86 },
    ],
  };
  // Row 1: FS-born WITH an fs id → the editable assignee-cell path (picker slot).
  // Row 2: no fs id → the read-only assignee-cell path (:1795-style chip).
  const aiRows = () => [
    { ...row(1, 'Open'), freshserviceTicketId: 901, ai: { ...aiBlock } },
    { ...row(2, 'Open'), ai: { ...aiBlock } },
  ];

  test('viewer sees the read-only Suggested chip: spans not buttons, no approve, no reviewer API calls', async () => {
    roleRef.value = 'viewer';
    listSpy.mockResolvedValue({ data: { items: aiRows(), total: 2 } });
    mount();
    await waitFor(() => expect(screen.getAllByText('Row 1').length).toBeGreaterThan(0));

    // Both cell variants render the suggestion, read-only.
    const chips = screen.getAllByTitle(/waiting on a reviewer/i);
    expect(chips.length).toBeGreaterThanOrEqual(2);
    for (const chip of chips) {
      expect(chip.tagName).not.toBe('BUTTON');
      expect(chip.closest('button')).toBeNull();
    }
    expect(screen.getAllByText('Suggested · 89%').length).toBe(2);

    // Nothing actionable: no review/approve affordances, and clicking the chip
    // neither opens the reviewer modal nor fires the decide endpoint.
    expect(screen.queryByRole('button', { name: /review ai suggestion/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /ask ai to assign/i })).not.toBeInTheDocument();
    fireEvent.click(chips[0]);
    expect(screen.queryByText('AI MODAL')).not.toBeInTheDocument();
    expect(decideSpy).not.toHaveBeenCalled();
  });

  test('reviewer keeps the actionable chip: a real button that opens the AI modal', async () => {
    roleRef.value = 'admin';
    listSpy.mockResolvedValue({ data: { items: aiRows(), total: 2 } });
    mount();
    await waitFor(() => expect(screen.getAllByText('Row 2').length).toBeGreaterThan(0));

    // Row 2 (read-only cell path) renders the chip as a BUTTON for reviewers
    // (row 1's editable path shows the same state inside the AssigneePicker
    // trigger, whose title lives on an inner span — filter to the button).
    const chip = screen.getAllByTitle(/awaiting your approval/i).find((el) => el.tagName === 'BUTTON');
    expect(chip).toBeTruthy();
    // …and clicking it opens the live-pipeline review modal.
    fireEvent.click(chip);
    expect(screen.getByText('AI MODAL')).toBeInTheDocument();
    // No read-only viewer chips anywhere for reviewers.
    expect(screen.queryByTitle(/waiting on a reviewer/i)).not.toBeInTheDocument();
  });

  test('viewer keeps the manual assignee picker on rows without a pending suggestion', async () => {
    roleRef.value = 'viewer';
    listSpy.mockResolvedValue({
      data: { items: [{ ...row(1, 'Open'), freshserviceTicketId: 901, ai: null }], total: 1 },
    });
    mount();
    await waitFor(() => expect(screen.getAllByText('Row 1').length).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: /unassigned — assign a member/i })).toBeInTheDocument();
  });
});

describe('Non-destructive refresh (deferred Phase-2 item, QA 08-07 #10)', () => {
  test('URL churn with unchanged query values (peek open) keeps rows mounted, selection intact, and does not refetch', async () => {
    mount('/tickets?status=Open,Pending');
    await waitFor(() => expect(screen.getAllByText('Row 1').length).toBeGreaterThan(0));
    // Let mount-time meta/fetch churn settle before counting calls.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const callsBefore = listSpy.mock.calls.length;
    const rowNodeBefore = screen.getAllByText('Row 1')[0];

    // Select a row, then open the peek (a searchParams write → queryParams
    // used to rebuild identity and blank selection + loudly refetch).
    const checkbox = screen.getByRole('checkbox', { name: 'Select TP-1' });
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();

    fireEvent.click(screen.getAllByRole('link', { name: 'Row 1' })[0]);
    await waitFor(() => expect(screen.getByText('PEEK 1')).toBeInTheDocument());

    // Same query values → no refetch, no loading card, same mounted row node.
    expect(listSpy.mock.calls.length).toBe(callsBefore);
    expect(screen.queryByLabelText('Loading tickets')).not.toBeInTheDocument();
    expect(screen.getAllByText('Row 1')[0]).toBe(rowNodeBefore);
    expect(screen.getByRole('checkbox', { name: 'Select TP-1' })).toBeChecked();
  });
});
