/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const auth = { user: { id: 1, role: 'admin', email: 'v@bgc.ca' } };
const ws = { currentWorkspace: { id: 1 }, availableWorkspaces: [{ id: 1, role: 'admin' }] };
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../../contexts/WorkspaceContext', () => ({ useWorkspace: () => ws }));

const { default: V4Splash, V4_SPLASH_KEY, openV4Splash } = await import('./V4Splash');

const renderAt = (path = '/dashboard') => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/knowledge" element={<p>Knowledge page</p>} />
      <Route path="*" element={<V4Splash />} />
    </Routes>
    <V4Splash />
  </MemoryRouter>,
);

describe('Ticket Pulse 4 splash', () => {
  beforeEach(() => {
    window.localStorage.clear();
    auth.user = { id: 1, role: 'admin', email: 'v@bgc.ca' };
    ws.availableWorkspaces = [{ id: 1, role: 'admin' }];
  });
  afterEach(() => cleanup());

  test('an admin sees it once; "Maybe later" remembers', () => {
    render(<MemoryRouter initialEntries={['/dashboard']}><V4Splash /></MemoryRouter>);
    expect(screen.getByRole('dialog', { name: /Ticket Pulse, now with Knowledge/ })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: 'Maybe later' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(V4_SPLASH_KEY)).toBe('4.0');
    cleanup();
    render(<MemoryRouter initialEntries={['/dashboard']}><V4Splash /></MemoryRouter>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('"Explore Knowledge" goes to /knowledge; Esc closes', () => {
    renderAt('/dashboard');
    fireEvent.click(screen.getAllByRole('button', { name: /Explore Knowledge/ })[0]);
    expect(screen.getByText('Knowledge page')).toBeInTheDocument();
    window.localStorage.clear();
    cleanup();
    render(<MemoryRouter initialEntries={['/dashboard']}><V4Splash /></MemoryRouter>);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('not for non-admins, and never on public or sign-in pages', () => {
    auth.user = { id: 2, role: 'viewer' };
    ws.availableWorkspaces = [{ id: 1, role: 'reviewer' }];
    render(<MemoryRouter initialEntries={['/tickets']}><V4Splash /></MemoryRouter>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    cleanup();
    auth.user = { id: 1, role: 'admin' };
    render(<MemoryRouter initialEntries={['/ticket-status/abc']}><V4Splash /></MemoryRouter>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('the account menu can reopen it after it was seen', () => {
    window.localStorage.setItem(V4_SPLASH_KEY, '4.0');
    render(<MemoryRouter initialEntries={['/dashboard']}><V4Splash /></MemoryRouter>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => openV4Splash());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  test('storage that throws (private window) still renders and closes', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    render(<MemoryRouter initialEntries={['/dashboard']}><V4Splash /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    get.mockRestore();
    set.mockRestore();
  });
});
