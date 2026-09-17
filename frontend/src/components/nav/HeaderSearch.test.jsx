/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

vi.mock('../../services/api', () => ({
  searchAPI: { global: vi.fn(() => new Promise(() => {})) },
  uiPreferencesAPI: { get: vi.fn(() => Promise.resolve({ value: [] })), set: vi.fn(() => Promise.resolve({})) },
  ticketsAPI: { requesterPhoto: vi.fn(() => Promise.resolve({ photoUrl: null })) },
}));
vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspace: { id: 1, name: 'IT' }, availableWorkspaces: [{ id: 1 }], switchWorkspace: vi.fn() }),
}));

import HeaderSearch from './HeaderSearch';

function Probe() {
  const location = useLocation();
  return <output data-testid="loc">{location.pathname}{location.search}</output>;
}

afterEach(cleanup);

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <HeaderSearch />
      <Routes>
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('HeaderSearch (16 Sep 2026)', () => {
  test('Enter from any page lands on the tickets list with the text as the filter', () => {
    renderAt('/dashboard');
    const box = screen.getByRole('combobox', { name: 'Search tickets' });
    fireEvent.change(box, { target: { value: 'vpn' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.getByTestId('loc').textContent).toBe('/tickets?q=vpn');
  });

  test('on the queue it keeps the other filters and mirrors the URL text', () => {
    renderAt('/tickets?status=Open&q=printer');
    const box = screen.getByRole('combobox', { name: 'Search tickets' });
    expect(box).toHaveValue('printer');
    fireEvent.change(box, { target: { value: 'scanner' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.getByTestId('loc').textContent).toBe('/tickets?status=Open&q=scanner');
  });
});
