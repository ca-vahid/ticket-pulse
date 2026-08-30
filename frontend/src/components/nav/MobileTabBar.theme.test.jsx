/** @vitest-environment jsdom */
// Phase DM-A: the phone "More" sheet carries the theme control; choosing a
// theme applies it and keeps the sheet OPEN (unlike every navigation row).
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({ prefGet: vi.fn(), prefSet: vi.fn() }));

vi.mock('../../services/api', () => ({
  getWorkspaceId: () => 1,
  uiPreferencesAPI: { get: mocks.prefGet, set: mocks.prefSet },
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { email: 'me@x.com', role: 'viewer' }, logout: vi.fn() }) }));
vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspace: { id: 1, name: 'IT' }, availableWorkspaces: [{ id: 1, name: 'IT', role: 'viewer' }], switchWorkspace: vi.fn() }),
}));
vi.mock('../../contexts/DashboardContext', () => ({ useDashboard: () => ({ lastUpdated: null, sseConnectionStatus: 'connected' }) }));
vi.mock('../../utils/demoMode', () => ({ useDemoMode: () => false, scrubFreeText: (s) => s }));
vi.mock('../ChangelogModal', () => ({ default: () => null }));
vi.mock('../../data/changelog', () => ({ APP_VERSION: '0.0.0-test' }));

import MobileTabBar from './MobileTabBar';
import { ThemeProvider } from '../../contexts/ThemeContext';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('dark');
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  mocks.prefGet.mockResolvedValue({ data: { key: 'ui.theme', value: null } });
  mocks.prefSet.mockResolvedValue({ data: { key: 'ui.theme', value: 'dark' } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const openSheet = () => {
  render(
    <ThemeProvider>
      <MemoryRouter initialEntries={['/tickets']}>
        <MobileTabBar />
      </MemoryRouter>
    </ThemeProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  return screen.getByRole('dialog', { name: 'More navigation' });
};

describe('MobileTabBar More sheet — theme control', () => {
  test('renders a radiogroup with Light / Dark / System + the early-access note, before Sign out', () => {
    const sheet = openSheet();
    const group = within(sheet).getByRole('radiogroup', { name: 'Theme' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.textContent.trim())).toEqual(['Light', 'Dark', 'System']);
    expect(radios[2]).toHaveAttribute('aria-checked', 'true');
    expect(within(sheet).getByText(/Early access — some screens are still light/)).toBeInTheDocument();
    const signOut = within(sheet).getByText('Sign out');
    expect(group.compareDocumentPosition(signOut) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('choosing Dark applies .dark, persists, and keeps the sheet open', () => {
    const sheet = openSheet();
    fireEvent.click(within(sheet).getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement).toHaveClass('dark');
    expect(localStorage.getItem('tp_theme')).toBe('dark');
    expect(screen.getByRole('dialog', { name: 'More navigation' })).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
  });

  test('a navigation row still closes the sheet', () => {
    const sheet = openSheet();
    fireEvent.click(within(sheet).getByText('My Skills'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
