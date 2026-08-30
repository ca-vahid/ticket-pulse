/** @vitest-environment jsdom */
// Phase DM-A: the account menu carries the three-way theme control above the
// Sign-out divider; choosing a theme applies it and keeps the menu OPEN.
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  useDashboard: vi.fn(),
  useWorkspace: vi.fn(),
  useRealtimeStatus: vi.fn(),
  getWorkspaceId: vi.fn(() => 1),
  prefGet: vi.fn(),
  prefSet: vi.fn(),
}));

vi.mock('../services/api', () => ({
  syncAPI: { trigger: vi.fn(), getStatus: vi.fn().mockResolvedValue({ data: { sync: {} } }) },
  getWorkspaceId: mocks.getWorkspaceId,
  uiPreferencesAPI: { get: mocks.prefGet, set: mocks.prefSet },
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: mocks.useAuth }));
vi.mock('../contexts/DashboardContext', () => ({ useDashboard: mocks.useDashboard }));
vi.mock('../contexts/WorkspaceContext', () => ({ useWorkspace: mocks.useWorkspace }));
vi.mock('../hooks/useRealtimeStatus', () => ({ useRealtimeStatus: mocks.useRealtimeStatus }));
vi.mock('./nav/SideRail', () => ({ default: () => null }));
vi.mock('./ChangelogModal', () => ({ default: () => null }));

import AppHeader from './AppHeader';
import { ThemeProvider } from '../contexts/ThemeContext';

function setup() {
  mocks.useAuth.mockReturnValue({ user: { name: 'Pat', email: 'pat@bgc.ca', role: 'viewer' }, logout: vi.fn() });
  mocks.useRealtimeStatus.mockReturnValue({ active: true, state: 'live-sse', transport: 'sse', retry: vi.fn(), getDiagnostics: () => null, getReconnectChurn: () => 0 });
  mocks.useDashboard.mockReturnValue({
    isRefreshing: false, lastUpdated: null, sseConnectionStatus: 'connected', sseTransportStatus: 'live-sse',
    sseTransport: 'sse', sseRetry: vi.fn(), sseGetReconnectChurn: () => 0, sseGetDiagnostics: () => null,
    sseEnabled: true, syncSkippedEvent: null,
  });
  mocks.useWorkspace.mockReturnValue({
    currentWorkspace: { id: 1, name: 'IT', slug: 'it' },
    availableWorkspaces: [{ id: 1, name: 'IT', slug: 'it', role: 'viewer' }],
    switchWorkspace: vi.fn(), switchError: null, clearSwitchError: vi.fn(), retryWorkspaceSync: vi.fn(),
  });
  return render(
    <ThemeProvider>
      <MemoryRouter>
        <AppHeader activePage="tickets" />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('dark');
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  mocks.prefGet.mockResolvedValue({ data: { key: 'ui.theme', value: null } });
  mocks.prefSet.mockResolvedValue({ data: { key: 'ui.theme', value: 'dark' } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const openMenu = () => {
  fireEvent.click(screen.getByTitle('Pat'));
  return screen.getByRole('menu');
};

describe('AppHeader account menu — theme control', () => {
  test('renders Light / Dark / System as menuitemradio with System checked by default, plus the early-access note', () => {
    setup();
    const menu = openMenu();
    const radios = within(menu).getAllByRole('menuitemradio');
    expect(radios.map((r) => r.textContent.trim())).toEqual(['Light', 'Dark', 'System']);
    expect(radios[2]).toHaveAttribute('aria-checked', 'true');
    expect(radios[0]).toHaveAttribute('aria-checked', 'false');
    expect(within(menu).getByText(/Early access — some screens are still light/)).toBeInTheDocument();
  });

  test('sits above the Sign-out divider (last item stays Sign out)', () => {
    setup();
    const menu = openMenu();
    const control = within(menu).getByTestId('theme-control');
    const signOut = within(menu).getByRole('menuitem', { name: /sign out/i });
    // DOM order: theme control precedes Sign out.
    expect(control.compareDocumentPosition(signOut) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('choosing Dark applies .dark, stores tp_theme, and keeps the menu open', () => {
    setup();
    const menu = openMenu();
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Dark' }));
    expect(document.documentElement).toHaveClass('dark');
    expect(localStorage.getItem('tp_theme')).toBe('dark');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'Light' }));
    expect(document.documentElement).not.toHaveClass('dark');
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  test('navigation items still close the menu (theme is the deliberate exception)', () => {
    setup();
    const menu = openMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /my skills/i }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
