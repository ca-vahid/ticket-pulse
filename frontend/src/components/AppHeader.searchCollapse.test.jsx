/** @vitest-environment jsdom */
// QA 11-18 #4: on laptops the header search shrank to an icon that sat on top
// of "Live · 3:35 PM". Now the box folds to a 32 px icon below a real
// breakpoint (lg; xl on pages with a wide title addon), "/" or the icon opens
// the SAME search in an overlay, Esc closes it, and the Live pill drops its time
// while folded (the time stays in the tooltip and the popover).
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  useDashboard: vi.fn(),
  useWorkspace: vi.fn(),
  useRealtimeStatus: vi.fn(),
}));

vi.mock('../services/api', () => ({
  syncAPI: { trigger: vi.fn(), getStatus: vi.fn(() => Promise.resolve({ data: { sync: { isRunning: false } } })) },
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: mocks.useAuth }));
vi.mock('../contexts/DashboardContext', () => ({ useDashboard: mocks.useDashboard }));
vi.mock('../contexts/WorkspaceContext', () => ({ useWorkspace: mocks.useWorkspace }));
vi.mock('../hooks/useRealtimeStatus', () => ({ useRealtimeStatus: mocks.useRealtimeStatus }));
vi.mock('./nav/SideRail', () => ({ default: () => null }));
vi.mock('./ChangelogModal', () => ({ default: () => null }));
vi.mock('../hooks/useRequesterPhoto', () => ({ useRequesterPhoto: () => null, fetchRequesterPhoto: () => Promise.resolve(null) }));
// A stand-in for the real box: one input that takes the header's ref, so the
// test can see where the search renders and whether it gets focus.
vi.mock('./nav/HeaderSearch', () => ({
  default: ({ inputRef, className }) => (
    <input ref={inputRef} aria-label="Search tickets" data-testid="header-search-input" className={className} />
  ),
}));

import AppHeader from './AppHeader';

/** matchMedia that answers min-width queries for a pretend viewport width. */
function setViewport(width) {
  window.matchMedia = vi.fn((query) => {
    const m = /min-width:\s*(\d+)px/.exec(query);
    return {
      matches: m ? width >= Number(m[1]) : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  });
}

function setup({ width, props = {} } = {}) {
  if (width) setViewport(width);
  mocks.useAuth.mockReturnValue({ user: { name: 'Dana Fox', email: 'dana@example.com', role: 'viewer' }, logout: vi.fn() });
  mocks.useRealtimeStatus.mockReturnValue({
    active: true, state: 'live-sse', transport: 'sse', retry: vi.fn(),
    getDiagnostics: () => null, getReconnectChurn: () => 0,
  });
  mocks.useDashboard.mockReturnValue({
    isRefreshing: false,
    lastUpdated: new Date('2026-11-18T15:35:00'),
    sseConnectionStatus: 'connected',
    sseTransportStatus: 'live-sse',
    sseTransport: 'sse',
    sseEnabled: true,
    syncSkippedEvent: null,
  });
  mocks.useWorkspace.mockReturnValue({
    currentWorkspace: { id: 1, name: 'Facilities and Field Equipment Services', slug: 'ffe' },
    availableWorkspaces: [{ id: 1, name: 'Facilities and Field Equipment Services', slug: 'ffe', role: 'viewer' }],
    switchWorkspace: vi.fn(),
    switchError: null,
    clearSwitchError: vi.fn(),
    retryWorkspaceSync: vi.fn(),
  });
  return render(
    <MemoryRouter>
      <AppHeader activePage="workflows" {...props} />
    </MemoryRouter>,
  );
}

const originalMatchMedia = window.matchMedia;
beforeEach(() => { window.matchMedia = originalMatchMedia; });
afterEach(() => { cleanup(); vi.clearAllMocks(); window.matchMedia = originalMatchMedia; });

describe('AppHeader search at laptop widths (QA 11-18 #4)', () => {
  test('wide (1366): the full box shows, no icon, and the Live pill keeps its time', () => {
    setup({ width: 1366 });
    expect(screen.getByTestId('header-search-slot')).toBeInTheDocument();
    expect(screen.getByTestId('header-search-input')).toHaveClass('max-w-xl');
    expect(screen.queryByTestId('header-search-toggle')).not.toBeInTheDocument();
    expect(screen.getByTestId('status-pill-time')).toBeInTheDocument();
  });

  test('without matchMedia (old browsers, other tests) the full box is the default', () => {
    window.matchMedia = undefined;
    setup();
    expect(screen.getByTestId('header-search-input')).toBeInTheDocument();
    expect(screen.queryByTestId('header-search-toggle')).not.toBeInTheDocument();
  });

  test('below lg (1000) the box folds to an icon and the pill drops its time', () => {
    setup({ width: 1000 });
    expect(screen.queryByTestId('header-search-input')).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Search' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-keyshortcuts', '/');
    expect(screen.queryByTestId('status-pill-time')).not.toBeInTheDocument();
    const pill = screen.getByRole('button', { name: /^live$/i });
    expect(pill).toHaveAttribute('title', expect.stringMatching(/refreshed \d{1,2}:\d{2}/));
  });

  test('a page with a wide title addon folds below xl: 1100 px is folded, 1280 is not', () => {
    setup({ width: 1100, props: { searchCollapseBelow: 'xl' } });
    expect(screen.getByTestId('header-search-toggle')).toBeInTheDocument();
    cleanup();
    setup({ width: 1280, props: { searchCollapseBelow: 'xl' } });
    expect(screen.queryByTestId('header-search-toggle')).not.toBeInTheDocument();
    expect(screen.getByTestId('header-search-input')).toBeInTheDocument();
  });

  test('a default page at 1100 keeps the full box (lg is its breakpoint)', () => {
    setup({ width: 1100 });
    expect(screen.getByTestId('header-search-input')).toBeInTheDocument();
  });

  test('the icon opens the same search in an overlay with focus; Esc closes it and returns focus', () => {
    setup({ width: 1000 });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const overlay = screen.getByTestId('header-search-overlay');
    const input = screen.getByTestId('header-search-input');
    expect(overlay).toContainElement(input);
    expect(input).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Close search' })).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('header-search-overlay')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search' })).toHaveFocus();
  });

  test('"/" opens the overlay; "/" typed in a field elsewhere does not', () => {
    setup({ width: 1000 });
    const other = document.createElement('input');
    document.body.appendChild(other);
    fireEvent.keyDown(other, { key: '/' });
    expect(screen.queryByTestId('header-search-overlay')).not.toBeInTheDocument();
    other.remove();

    fireEvent.keyDown(document.body, { key: '/' });
    expect(screen.getByTestId('header-search-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('header-search-input')).toHaveFocus();
  });

  test('"/" does nothing while the full box shows (the box has its own "/")', () => {
    setup({ width: 1366 });
    fireEvent.keyDown(document.body, { key: '/' });
    expect(screen.queryByTestId('header-search-overlay')).not.toBeInTheDocument();
  });

  test('a press outside the overlay closes it; the toggle closes it too', () => {
    setup({ width: 1000 });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('header-search-overlay')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Close search' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close search' }));
    expect(screen.queryByTestId('header-search-overlay')).not.toBeInTheDocument();
  });

  test('the status pill and account button never shrink; the version chip hides below xl', () => {
    setup({ width: 1000 });
    const pill = screen.getByRole('button', { name: /^live$/i });
    expect(screen.getByTestId('header-right')).toHaveClass('flex-shrink-0');
    expect(screen.getByTestId('header-right')).toContainElement(pill);
    expect(pill).toHaveClass('whitespace-nowrap');
    expect(screen.getByTestId('header-version')).toHaveClass('hidden', 'xl:inline-flex');
  });
});

/** Classes that would cut an absolutely positioned popup sideways. */
const CLIPS = /(^|\s)(overflow-(hidden|clip|auto|scroll)|overflow-x-(hidden|clip|auto|scroll))(\s|$)/;
/** Every element between `el` and the header row (exclusive) — the row's own clip is checked by width reasoning. */
function ancestorsUpToRow(el) {
  const out = [];
  const row = screen.getByTestId('header-row');
  for (let n = el.parentElement; n && n !== row; n = n.parentElement) out.push(n);
  return out;
}

describe('AppHeader popups are never clipped or squeezed (QA 11-18 #4 review)', () => {
  function setupMultiWorkspace(width) {
    setup({ width });
    mocks.useWorkspace.mockReturnValue({
      currentWorkspace: { id: 1, name: 'IT', slug: 'it' },
      availableWorkspaces: [
        { id: 1, name: 'IT', slug: 'it', role: 'admin' },
        { id: 2, name: 'Facilities and Field Equipment Services', slug: 'ffe', role: 'viewer' },
      ],
      switchWorkspace: vi.fn(),
      switchError: null,
      clearSwitchError: vi.fn(),
      retryWorkspaceSync: vi.fn(),
    });
    cleanup();
    return render(
      <MemoryRouter>
        <AppHeader activePage="workflows" titleAddon={<span>Tabs</span>} searchCollapseBelow="xl" />
      </MemoryRouter>,
    );
  }

  test.each([900, 1100, 1366])('at %i px the workspace menu has no clipping ancestor inside the row', (width) => {
    setupMultiWorkspace(width);
    fireEvent.click(screen.getByRole('button', { name: /IT/ }));
    const menu = screen.getByRole('menu');
    expect(menu).toHaveClass('w-64');
    for (const n of ancestorsUpToRow(menu)) expect(n.className).not.toMatch(CLIPS);
    // Only the title addon clips itself, and it holds no popup.
    expect(screen.getByTestId('header-title-addon')).not.toContainElement(menu);
  });

  test('the status popover and the account menu wrap their text and sit in no clipping box', () => {
    setup({ width: 1000 });
    fireEvent.click(screen.getByRole('button', { name: /^live$/i }));
    const popover = screen.getByTestId('status-popover');
    expect(popover).toHaveClass('whitespace-normal');
    for (const n of ancestorsUpToRow(popover)) {
      expect(n.className).not.toMatch(CLIPS);
      expect(n.className).not.toMatch(/whitespace-nowrap/);
    }

    fireEvent.click(screen.getByRole('button', { name: /Dana Fox|DF/ }));
    const menu = screen.getByRole('menu');
    expect(menu).toHaveClass('whitespace-normal');
    for (const n of ancestorsUpToRow(menu)) {
      expect(n.className).not.toMatch(CLIPS);
      expect(n.className).not.toMatch(/whitespace-nowrap/);
    }
  });

  test('the search box (full and overlay) sits in no clipping box', () => {
    setup({ width: 1366 });
    for (const n of ancestorsUpToRow(screen.getByTestId('header-search-input'))) expect(n.className).not.toMatch(CLIPS);
    cleanup();
    setup({ width: 1000 });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    for (const n of ancestorsUpToRow(screen.getByTestId('header-search-input'))) expect(n.className).not.toMatch(CLIPS);
  });
});
