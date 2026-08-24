/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Mega 08-23 Phase QR — resizable queue columns:
//  - QR1: per-layout widths under 'queue.columnWidths' (mirror + server-wins
//    + debounced PUT), only user-resized keys stored, clamped minPx..800,
//    xl+ only (the md templates never read them).
//  - QR2: pointer-capture drag handle → direct-DOM template preview per move,
//    ONE commit (→ one PUT) on release; keyboard ±16; double-click reset;
//    sort clicks beside the handle untouched.
//  - QR3: pinned widths → horizontal-scroll wrapper with the computed
//    min-width floor; "Reset widths" in the columns flyout.
const { listSpy, metaSpy, statsSpy, getPrefSpy, setPrefSpy } = vi.hoisted(() => ({
  listSpy: vi.fn(),
  metaSpy: vi.fn(),
  statsSpy: vi.fn(),
  getPrefSpy: vi.fn(),
  setPrefSpy: vi.fn(),
}));

vi.mock('../services/api', () => ({
  ticketsAPI: new Proxy(
    { list: listSpy, meta: metaSpy, stats: statsSpy, getQueuePreference: getPrefSpy, setQueuePreference: setPrefSpy },
    { get: (target, key) => target[key] || (() => new Promise(() => {})) },
  ),
  assignmentAPI: { decide: vi.fn(), latestRun: vi.fn(() => new Promise(() => {})) },
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
  useWorkspaceRole: () => ({ role: 'admin', canManage: true, canReview: true }),
  NAV_DESTINATIONS: [],
}));
vi.mock('../hooks/useSSE', () => ({ useSSE: vi.fn() }));
vi.mock('../components/AppHeader', () => ({ default: () => <div>AppHeader</div> }));
vi.mock('../components/nav/MobileTabBar', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketPreview', () => ({ default: ({ ticketId }) => <div>PEEK {ticketId}</div> }));
vi.mock('../components/tickets/ScheduledTicketsPanel', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketFilterRail', () => ({
  default: () => null,
  ActiveFilterBar: () => null,
}));
vi.mock('../components/tickets/AiAssignModal', () => ({ default: () => <div>AI MODAL</div> }));
vi.mock('../components/tickets/MobileAssignSheet', () => ({ default: () => null }));
vi.mock('../assets/tickets-hero.png', () => ({ default: 'hero.png' }));

import Tickets from './Tickets';

const DEFAULT_COMPACT_TEMPLATE = '6px minmax(0,2.4fr) 150px minmax(150px,1fr) 210px 116px 88px 74px';
// Any pinned width swaps the unpinned subject's slack floor 0 → minPx (240).
const pinnedCompact = (requesterTrack) => `6px minmax(240px,2.4fr) ${requesterTrack} minmax(150px,1fr) 210px 116px 88px 74px`;
const MD_COMPACT_LITERAL = 'md:grid-cols-[6px_minmax(0,2.4fr)_minmax(100px,0.8fr)_118px_96px_84px]';

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
  source: 2,
  department: null,
  tags: [],
  ai: null,
  createdAt: '2026-08-01T10:00:00Z',
  updatedAt: '2026-08-01T10:00:00Z',
  lastActivityAt: '2026-08-01T10:00:00Z',
});

const lastListParams = () => listSpy.mock.calls.at(-1)[0];
const putWidthCalls = () => setPrefSpy.mock.calls.filter((c) => c[0] === 'queue.columnWidths');

function mount() {
  return render(<Tickets />, {
    wrapper: ({ children }) => <MemoryRouter initialEntries={['/tickets']}>{children}</MemoryRouter>,
  });
}

function card() {
  return screen.getAllByTitle('Rita Requester · Vancouver HQ')[0].closest('.tp-card');
}
const currentTemplate = () => card().style.getPropertyValue('--tp-q-grid');

// jsdom has no PointerEvent — MouseEvents with pointer type names hit React's
// onPointer* handlers, and the missing pointerId makes set/releasePointerCapture
// throw into the handle's jsdom guard (the capture path is browser-only).
const pointer = (type, clientX) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 });
const findHandle = (label) => screen.findByRole('separator', { name: `Resize ${label} column` });

// Header cells measure 0px wide in jsdom, so drags start from the registry
// fallback (requester '150px' track → 150).
const dragRequester = async (from, to, { release = true } = {}) => {
  const handle = await findHandle('Requester');
  fireEvent(handle, pointer('pointerdown', from));
  fireEvent(handle, pointer('pointermove', to));
  if (release) fireEvent(handle, pointer('pointerup', to));
  return handle;
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
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
  getPrefSpy.mockImplementation((key) => Promise.resolve({ data: { key, value: null } }));
  setPrefSpy.mockImplementation((key, value) => Promise.resolve({ data: { key, value } }));
});

afterEach(cleanup);

const mountAndLoad = async () => {
  mount();
  await waitFor(() => expect(screen.getAllByText('Row 1').length).toBeGreaterThan(0));
};

describe('Drag resize (QR2)', () => {
  test('pointer drag previews the template per move (direct DOM, no PUT) and commits exactly one PUT on release', async () => {
    await mountAndLoad();
    expect(currentTemplate()).toBe(DEFAULT_COMPACT_TEMPLATE);

    const handle = await findHandle('Requester');
    fireEvent(handle, pointer('pointerdown', 300));
    fireEvent(handle, pointer('pointermove', 340));
    // Mid-drag: the card's var already carries the new width (150+40) …
    expect(currentTemplate()).toBe(pinnedCompact('190px'));
    fireEvent(handle, pointer('pointermove', 360));
    expect(currentTemplate()).toBe(pinnedCompact('210px'));
    // … but nothing persisted yet.
    expect(putWidthCalls().length).toBe(0);

    fireEvent(handle, pointer('pointerup', 360));
    await waitFor(() => expect(putWidthCalls().length).toBe(1), { timeout: 2500 });
    expect(putWidthCalls()[0][1]).toEqual({ compact: { requester: 210 }, roomy: {} });
    // Optimistic localStorage mirror rides the commit.
    expect(JSON.parse(localStorage.getItem('tp_queue_columnWidths'))).toEqual({ compact: { requester: 210 }, roomy: {} });
    // Still exactly one PUT after the debounce window — one commit per drag.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(putWidthCalls().length).toBe(1);
    expect(currentTemplate()).toBe(pinnedCompact('210px'));
  });

  test('clamps: never below the registry minPx, never above 800px', async () => {
    await mountAndLoad();
    const handle = await findHandle('Requester');
    fireEvent(handle, pointer('pointerdown', 500));
    fireEvent(handle, pointer('pointermove', 0)); // 150 - 500 → floor
    expect(currentTemplate()).toBe(pinnedCompact('110px')); // requester minPx
    fireEvent(handle, pointer('pointermove', 3000)); // 150 + 2500 → ceiling
    expect(currentTemplate()).toBe(pinnedCompact('800px'));
    fireEvent(handle, pointer('pointerup', 3000));
    await waitFor(() => expect(putWidthCalls().at(-1)[1]).toEqual({ compact: { requester: 800 }, roomy: {} }), { timeout: 2500 });
  });

  test('double-click resets that column back to its registry track', async () => {
    localStorage.setItem('tp_queue_columnWidths', JSON.stringify({ compact: { requester: 220 }, roomy: {} }));
    await mountAndLoad();
    expect(currentTemplate()).toBe(pinnedCompact('220px'));

    fireEvent.doubleClick(await findHandle('Requester'));
    // Last pinned width gone → the exact stock template returns (subject slack included).
    await waitFor(() => expect(currentTemplate()).toBe(DEFAULT_COMPACT_TEMPLATE));
    await waitFor(() => expect(putWidthCalls().at(-1)[1]).toEqual({ compact: {}, roomy: {} }), { timeout: 2500 });
  });

  test('keyboard: arrow keys nudge the focused separator ±16px', async () => {
    await mountAndLoad();
    const handle = await findHandle('Requester');
    handle.focus();
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    await waitFor(() => expect(currentTemplate()).toBe(pinnedCompact('166px')));
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    await waitFor(() => expect(currentTemplate()).toBe(pinnedCompact('150px'))); // pinned at the default px now
    await waitFor(() => expect(putWidthCalls().at(-1)[1]).toEqual({ compact: { requester: 150 }, roomy: {} }), { timeout: 2500 });
  });

  test('the handle never swallows header sorting: sort button works, handle clicks do not sort', async () => {
    await mountAndLoad();
    const sortBefore = lastListParams().sort;

    // Clicking (or dragging) the separator itself must not trigger a sort …
    const handle = await findHandle('Requester');
    fireEvent.click(handle);
    await dragRequester(300, 320);
    expect(lastListParams().sort).toBe(sortBefore);

    // … while the sort button an arm's length away keeps working.
    fireEvent.click(screen.getByRole('button', { name: /^Requester$/ }));
    await waitFor(() => expect(lastListParams().sort).toBe('requester'));
  });
});

describe('Width storage (QR1)', () => {
  test('below xl stored widths are ignored: the md literal templates stay, widths ride only the xl var', async () => {
    getPrefSpy.mockImplementation((key) => Promise.resolve({
      data: { key, value: key === 'queue.columnWidths' ? { compact: { requester: 300 }, roomy: {} } : null },
    }));
    await mountAndLoad();
    await waitFor(() => expect(currentTemplate()).toBe(pinnedCompact('300px')));

    // The md band renders from the hardcoded literal — no width leaks below xl.
    const rowGrid = screen.getAllByTitle('Rita Requester · Vancouver HQ')[0].closest('div');
    expect(rowGrid.className).toContain(MD_COMPACT_LITERAL);
    expect(rowGrid.className).toContain('xl:[grid-template-columns:var(--tp-q-grid)]');
    // And the handle itself only exists at xl.
    const handle = await findHandle('Requester');
    expect(handle).toHaveClass('hidden', 'xl:block');
    // Server value won → mirror refreshed for the next first paint.
    expect(JSON.parse(localStorage.getItem('tp_queue_columnWidths'))).toEqual({ compact: { requester: 300 }, roomy: {} });
  });

  test('garbage in the stored value is dropped: unknown keys/layouts, junk numbers → stock template', async () => {
    getPrefSpy.mockImplementation((key) => Promise.resolve({
      data: {
        key,
        value: key === 'queue.columnWidths'
          ? { compact: { bogus: 300, requester: 'nan', due: -40 }, roomy: 'junk', wide: { requester: 500 } }
          : null,
      },
    }));
    await mountAndLoad();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(currentTemplate()).toBe(DEFAULT_COMPACT_TEMPLATE);
  });

  test('widths are per layout: compact pins do not touch roomy, roomy pins apply there', async () => {
    localStorage.setItem('tp_ticket_layout', 'roomy');
    getPrefSpy.mockImplementation((key) => Promise.resolve({
      data: { key, value: key === 'queue.columnWidths' ? { compact: { requester: 300 }, roomy: { status: 200 } } : null },
    }));
    await mountAndLoad();
    // Roomy: 60px type slot (never resizable — no Subject separator), the
    // compact-only 300px ignored, roomy's own status pin applied.
    await waitFor(() => expect(currentTemplate()).toBe('6px 60px 150px minmax(150px,1fr) 210px 200px 88px 74px'));
    expect(screen.queryByRole('separator', { name: 'Resize Subject column' })).not.toBeInTheDocument();
    expect(screen.queryByRole('separator', { name: 'Resize Status column' })).toBeInTheDocument();
  });
});

describe('Overflow + flyout reset (QR3)', () => {
  test('pinned widths add the horizontal-scroll wrapper with the computed min-width floor; untouched users get none', async () => {
    await mountAndLoad();
    const divs = () => [...card().querySelectorAll('div')];
    expect(divs().find((d) => d.className.includes('xl:overflow-x-auto'))).toBeUndefined();

    await dragRequester(300, 450); // → 300px
    await waitFor(() => expect(currentTemplate()).toBe(pinnedCompact('300px')));
    const scroller = divs().find((d) => d.className.includes('xl:overflow-x-auto'));
    expect(scroller).toBeTruthy();
    expect(scroller.querySelector('div').className).toContain('xl:min-w-[var(--tp-q-minw)]');
    // Floor = 6 accent + 240 subject + 300 pinned + 150+210+116+88+74 tracks + 36 checkbox rail.
    expect(card().style.getPropertyValue('--tp-q-minw')).toBe('1220px');
    // Header and rows live INSIDE the scroller — they scroll together.
    expect(scroller.contains(screen.getByRole('button', { name: /^Requester$/ }))).toBe(true);
    expect(scroller.contains(screen.getAllByText('Row 1')[0])).toBe(true);
  });

  test('"Reset widths" in the columns flyout clears every pinned width (distinct from Reset columns)', async () => {
    localStorage.setItem('tp_queue_columnWidths', JSON.stringify({ compact: { requester: 260 }, roomy: { status: 200 } }));
    await mountAndLoad();
    expect(currentTemplate()).toBe(pinnedCompact('260px'));

    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    await screen.findByRole('dialog', { name: 'Customize columns' });
    // Both resets present; columns weren't customized so that one is disabled.
    expect(screen.getByRole('button', { name: /reset columns/i })).toBeDisabled();
    const resetWidths = screen.getByRole('button', { name: /reset widths/i });
    expect(resetWidths).toBeEnabled();

    fireEvent.click(resetWidths);
    await waitFor(() => expect(currentTemplate()).toBe(DEFAULT_COMPACT_TEMPLATE));
    expect(JSON.parse(localStorage.getItem('tp_queue_columnWidths'))).toEqual({ compact: {}, roomy: {} });
    await waitFor(() => expect(putWidthCalls().at(-1)[1]).toEqual({ compact: {}, roomy: {} }), { timeout: 2500 });
    // Cleared on both layouts → the button disarms.
    expect(screen.getByRole('button', { name: /reset widths/i })).toBeDisabled();
  });
});
