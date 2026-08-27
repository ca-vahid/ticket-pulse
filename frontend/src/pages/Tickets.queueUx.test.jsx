/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Queue UX contract tests:
//  - FR 08-07 Phase 3 (#6/#7/#12 + the deferred non-destructive-refresh item):
//    row anchors, board density, URL-churn stability;
//  - QA 08-19 #2: the AI suggestion read/act split;
//  - Mega 08-23 Phase QC: per-user columns — header + rows ride ONE computed
//    gridTemplateColumns (--tp-q-grid) built from the user's chosen columns,
//    defaults reproduce today's exact set + order (zero change untouched),
//    the flyout toggles/reorders/resets, and the choice round-trips through
//    the per-user preference endpoints (server wins over the local mirror).
const { listSpy, metaSpy, statsSpy, decideSpy, getPrefSpy, setPrefSpy, roleRef } = vi.hoisted(() => ({
  listSpy: vi.fn(),
  metaSpy: vi.fn(),
  statsSpy: vi.fn(),
  decideSpy: vi.fn(),
  getPrefSpy: vi.fn(),
  setPrefSpy: vi.fn(),
  // Mutable workspace role: the historical default is this OBJECT (which the
  // page's `wsRole === 'admin'` string compare treats as non-reviewer); the
  // AI-visibility tests below set real role STRINGS ('viewer' / 'admin').
  roleRef: { value: { role: 'admin', canManage: true, canReview: true } },
}));

vi.mock('../services/api', () => ({
  ticketsAPI: new Proxy(
    { list: listSpy, meta: metaSpy, stats: statsSpy, getQueuePreference: getPrefSpy, setQueuePreference: setPrefSpy },
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
import { DEFAULT_COLUMN_KEYS } from '../components/tickets/queueColumns';

// The ONE computed template (QC3): --tp-q-grid on the list card, consumed by
// header + rows through the same xl arbitrary-property class.
const GRID_VAR_CLASS = 'xl:[grid-template-columns:var(--tp-q-grid)]';
// Defaults must reproduce the pre-QC hardcoded xl templates exactly.
const DEFAULT_COMPACT_TEMPLATE = '6px minmax(0,2.4fr) 150px minmax(150px,1fr) 210px 116px 88px 74px';
const DEFAULT_ROOMY_TEMPLATE = '6px 60px 150px minmax(150px,1fr) 210px 116px 88px 74px';

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
  requester: { name: 'Rita Requester', entraOfficeLocation: 'Vancouver HQ', entraDepartment: 'Geo Ops' },
  source: 2,
  department: null,
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

// The list card carries --tp-q-grid; any requester cell reaches it via closest.
function currentTemplate() {
  const card = screen.getAllByTitle('Rita Requester · Vancouver HQ')[0].closest('.tp-card');
  return card.style.getPropertyValue('--tp-q-grid');
}

async function openColumnsMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
  return await screen.findByRole('dialog', { name: 'Customize columns' });
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
  // Preference endpoints: never customized by default; PUT acks.
  getPrefSpy.mockResolvedValue({ data: { key: 'queue.columns', value: null } });
  setPrefSpy.mockResolvedValue({ data: { key: 'queue.columns', value: [] } });
});

afterEach(cleanup);

describe('Computed column templates (Phase QC — QC3)', () => {
  test('compact default: header + rows share the computed var template and it equals the pre-QC layout exactly', async () => {
    mount();
    await waitFor(() => expect(screen.getAllByText('Row 1').length).toBeGreaterThan(0));

    // Zero-change default: the computed template reproduces the old literal.
    expect(currentTemplate()).toBe(DEFAULT_COMPACT_TEMPLATE);

    // Header label exists, sortable, and only shows at xl (requester is a
    // non-essential column below xl — QA 08-07 #6 projection preserved).
    const reqHeaderBtn = screen.getByRole('button', { name: /^Requester$/ });
    const reqHeaderCell = reqHeaderBtn.closest('span');
    expect(reqHeaderCell).toHaveClass('hidden', 'xl:flex');

    // Header and row ride the SAME computed grid (the old :115 pairing rule,
    // now enforced by construction through --tp-q-grid).
    const headerGrid = reqHeaderCell.closest('div');
    expect(headerGrid.className).toContain(GRID_VAR_CLASS);
    const cells = screen.getAllByTitle('Rita Requester · Vancouver HQ');
    expect(cells.length).toBe(2); // one requester cell per row
    expect(cells[0]).toHaveClass('hidden', 'xl:flex');
    const rowGrid = cells[0].closest('div');
    expect(rowGrid.className).toContain(GRID_VAR_CLASS);
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

  test('default column ORDER matches the pre-QC queue via the computed --tp-q-col indexes', async () => {
    mount();
    await waitFor(() => expect(screen.getAllByText('Row 1').length).toBeGreaterThan(0));

    // requester=3, category=4, assignee=5, status=6, due=7, lastActivity=8 —
    // exactly the old fixed track order.
    const colOf = (el) => el.closest('span[style]')?.style.getPropertyValue('--tp-q-col')
      || el.style.getPropertyValue('--tp-q-col');
    const reqCell = screen.getAllByTitle('Rita Requester · Vancouver HQ')[0];
    expect(colOf(reqCell)).toBe('3');
    const dueHeader = screen.getByRole('button', { name: /^Due$/ }).closest('span');
    expect(colOf(dueHeader)).toBe('7');
    const updatedHeader = screen.getByRole('button', { name: /^Updated$/ }).closest('span');
    expect(colOf(updatedHeader)).toBe('8');
    const statusHeader = screen.getByTitle('Sort by status (Open first)').closest('span');
    expect(colOf(statusHeader)).toBe('6');
  });

  test('roomy: computed template has the 60px type slot; the Ticket header sits on it at xl (md span unchanged)', async () => {
    localStorage.setItem('tp_ticket_layout', 'roomy');
    mount();
    await waitFor(() => expect(screen.getAllByText('Row 1').length).toBeGreaterThan(0));

    expect(currentTemplate()).toBe(DEFAULT_ROOMY_TEMPLATE);
    const cells = screen.getAllByTitle('Rita Requester · Vancouver HQ');
    expect(cells[0]).toHaveClass('hidden', 'xl:flex');
    expect(cells[0].closest('div').className).toContain(GRID_VAR_CLASS);

    // md keeps the old type+category span; at xl the columns are user-ordered
    // so every column labels itself and "Ticket" collapses onto the type slot.
    const ticketHeaderBtn = screen.getByRole('button', { name: /^Ticket$/ });
    const span = ticketHeaderBtn.closest('span');
    expect(span).toHaveClass('[grid-column:2/4]', 'xl:[grid-column:2/3]');
    expect(span.closest('div').className).toContain(GRID_VAR_CLASS);
  });
});

describe('Columns flyout (Phase QC — QC4)', () => {
  test('toggling a column on changes the computed template, appends its track, and persists (debounced PUT + mirror)', async () => {
    mount();
    await waitFor(() => expect(screen.getAllByText('Row 1').length).toBeGreaterThan(0));

    await openColumnsMenu();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Created column' }));

    // Template gains the createdAt track at the end of the chosen order.
    await waitFor(() => expect(currentTemplate()).toBe(`${DEFAULT_COMPACT_TEMPLATE} 124px`));
    // The new column renders: header + a dated cell per row. (createdAt is the
    // default sort, so the header carries the ↓ indicator — query by title.)
    expect(screen.getByTitle('Sort by created date')).toBeInTheDocument();
    // Optimistic localStorage mirror, then the debounced server PUT.
    expect(JSON.parse(localStorage.getItem('tp_queue_columns'))).toEqual([...DEFAULT_COLUMN_KEYS, 'createdAt']);
    await waitFor(() => expect(setPrefSpy).toHaveBeenCalledWith('queue.columns', [...DEFAULT_COLUMN_KEYS, 'createdAt']), { timeout: 2500 });
  });

  test('Created cell: day+time primary and a still-relative secondary for a week-old ticket (QA 08-24 #2)', async () => {
    // Regression: at ≥7 days timeAgo returned a DATE, so both lines read
    // "Aug 17". The primary now carries the time and the secondary keeps
    // counting ("1w ago").
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    eightDaysAgo.setSeconds(0, 0);
    listSpy.mockResolvedValue({ data: { items: [{ ...row(1, 'Open'), createdAt: eightDaysAgo.toISOString() }], total: 1 } });
    getPrefSpy.mockResolvedValue({ data: { key: 'queue.columns', value: [...DEFAULT_COLUMN_KEYS, 'createdAt'] } });
    mount();
    await waitFor(() => expect(screen.getAllByText('Row 1').length).toBeGreaterThan(0));
    await waitFor(() => expect(currentTemplate()).toBe(`${DEFAULT_COMPACT_TEMPLATE} 124px`));

    const cell = await screen.findByTitle(eightDaysAgo.toLocaleString());
    const [primary, secondary] = Array.from(cell.querySelectorAll('span')).map((el) => el.textContent);
    expect(primary).toMatch(/\d{1,2}:\d{2}/); // "Aug 18, 9:14 AM" — a time, not a bare date
    expect(secondary).toBe('1w ago');
    expect(primary).not.toBe(secondary);
  });

  test('toggling a column off removes its track; mandatory columns are locked "Always shown"', async () => {
    mount();
    await waitFor(() => expect(screen.getAllByText('Row 1').length).toBeGreaterThan(0));

    const dialog = await openColumnsMenu();
    // Mandatory rows: checked + disabled, labeled always-shown.
    const subjectBox = screen.getByRole('checkbox', { name: 'Subject column' });
    const requesterBox = screen.getByRole('checkbox', { name: 'Requester column' });
    expect(subjectBox).toBeChecked();
    expect(subjectBox).toBeDisabled();
    expect(requesterBox).toBeChecked();
    expect(requesterBox).toBeDisabled();
    expect(within(dialog).getAllByText('Always shown').length).toBe(2);

    // Drop the Updated column → its 74px track disappears from the template.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Updated column' }));
    await waitFor(() => expect(currentTemplate()).toBe('6px minmax(0,2.4fr) 150px minmax(150px,1fr) 210px 116px 88px'));
    expect(screen.queryByRole('button', { name: /^Updated$/ })).not.toBeInTheDocument();
  });

  test('drag-to-reorder: dropping Status onto Assignee puts its track first and re-places both columns', async () => {
    mount();
    await waitFor(() => expect(screen.getAllByText('Row 1').length).toBeGreaterThan(0));

    await openColumnsMenu();
    const grip = screen.getByLabelText('Reorder Status column');
    const targetRow = screen.getByRole('checkbox', { name: 'Assignee column' }).closest('li');
    fireEvent.dragStart(grip, { dataTransfer: { effectAllowed: 'none' } });
    fireEvent.drop(targetRow);

    // Status (116px) now precedes Assignee (210px) in the computed template…
    await waitFor(() => expect(currentTemplate()).toBe('6px minmax(0,2.4fr) 150px minmax(150px,1fr) 116px 210px 88px 74px'));
    // …and the placement indexes follow (status=5, assignee=6).
    const statusHeader = screen.getByTitle('Sort by status (Open first)').closest('span');
    expect(statusHeader.style.getPropertyValue('--tp-q-col')).toBe('5');
    await waitFor(() => expect(setPrefSpy).toHaveBeenCalledWith(
      'queue.columns',
      ['subject', 'requester', 'category', 'status', 'assignee', 'due', 'lastActivity'],
    ), { timeout: 2500 });
  });

  test('Reset columns restores the stock template and persists the default set', async () => {
    localStorage.setItem('tp_queue_columns', JSON.stringify(['subject', 'requester', 'status', 'assignee']));
    mount();
    await waitFor(() => expect(screen.getAllByText('Row 1').length).toBeGreaterThan(0));
    expect(currentTemplate()).not.toBe(DEFAULT_COMPACT_TEMPLATE);

    await openColumnsMenu();
    fireEvent.click(screen.getByRole('button', { name: /reset columns/i }));
    await waitFor(() => expect(currentTemplate()).toBe(DEFAULT_COMPACT_TEMPLATE));
    await waitFor(() => expect(setPrefSpy).toHaveBeenCalledWith('queue.columns', DEFAULT_COLUMN_KEYS), { timeout: 2500 });
  });

  test('board mode hides the customizer (board columns are statuses, not these)', async () => {
    localStorage.setItem('tp_ticket_layout', 'board');
    mount();
    await waitFor(() => expect(listSpy).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Columns' })).not.toBeInTheDocument();
  });
});

describe('Column preference round-trip (Phase QC — QC1/QC4)', () => {
  test('the stored server value wins over the localStorage mirror on load', async () => {
    // Mirror says default; the SERVER says the user runs with Created+Source.
    localStorage.setItem('tp_queue_columns', JSON.stringify(DEFAULT_COLUMN_KEYS));
    getPrefSpy.mockResolvedValue({
      data: { key: 'queue.columns', value: [...DEFAULT_COLUMN_KEYS, 'createdAt', 'source'] },
    });
    mount();
    await waitFor(() => expect(screen.getAllByText('Row 1').length).toBeGreaterThan(0));

    await waitFor(() => expect(currentTemplate()).toBe(`${DEFAULT_COMPACT_TEMPLATE} 124px 96px`));
    expect(screen.getByRole('button', { name: /^Source$/ })).toBeInTheDocument();
    // The mirror is refreshed to the server truth for the next first paint.
    expect(JSON.parse(localStorage.getItem('tp_queue_columns'))).toEqual([...DEFAULT_COLUMN_KEYS, 'createdAt', 'source']);
    expect(getPrefSpy).toHaveBeenCalledWith('queue.columns');
  });

  test('garbage in the stored value is normalized: unknown keys dropped, mandatory restored, junk → defaults', async () => {
    getPrefSpy.mockResolvedValue({
      data: { key: 'queue.columns', value: ['bogus', 'status', 'status', 'due'] },
    });
    mount();
    await waitFor(() => expect(screen.getAllByText('Row 1').length).toBeGreaterThan(0));
    // subject pinned first + requester re-inserted + dedupe + unknowns gone:
    // subject, requester, status, due → 6px subject 150px 116px 88px.
    await waitFor(() => expect(currentTemplate()).toBe('6px minmax(0,2.4fr) 150px 116px 88px'));
  });

  test('new-column sorts wire through the headers (source header → sort=source asc-first)', async () => {
    getPrefSpy.mockResolvedValue({
      data: { key: 'queue.columns', value: [...DEFAULT_COLUMN_KEYS, 'source'] },
    });
    mount();
    await waitFor(() => expect(screen.getAllByText('Row 1').length).toBeGreaterThan(0));
    const sourceHeader = await screen.findByRole('button', { name: /^Source$/ });
    fireEvent.click(sourceHeader);
    await waitFor(() => expect(lastListParams().sort).toBe('source'));
    expect(lastListParams().dir).toBe('asc'); // categorical → A→Z first
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
  // Row 2: no fs id → the read-only assignee-cell path (read-only chip).
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
