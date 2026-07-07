/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CommandPalette from './CommandPalette';

const list = vi.fn().mockResolvedValue({ data: { items: [] } });
vi.mock('../services/api', () => ({
  ticketsAPI: {
    list: (...a) => list(...a),
    get: vi.fn().mockResolvedValue({ data: {} }),
    meta: vi.fn().mockResolvedValue({ data: { technicians: [] } }),
    assign: vi.fn(),
    setStatus: vi.fn(),
    fsUpdate: vi.fn(),
  },
}));

const authState = { isAuthenticated: true, user: { email: 'me@x.com', role: 'coordinator' } };
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => authState }));
vi.mock('../contexts/WorkspaceContext', () => ({ useWorkspace: () => ({ currentWorkspace: { id: 1 } }) }));

afterEach(() => { cleanup(); list.mockClear(); authState.user = { email: 'me@x.com', role: 'coordinator' }; });

const openPalette = () => fireEvent.keyDown(document, { key: 'k', ctrlKey: true });

function renderPalette(path = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <CommandPalette />
    </MemoryRouter>,
  );
}

describe('CommandPalette', () => {
  test('hidden until Ctrl+K, then shows navigation commands', () => {
    renderPalette();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    openPalette();
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Analytics & Insights/ })).toBeInTheDocument();
  });

  test('Ctrl+K toggles closed again and Escape closes', () => {
    renderPalette();
    openPalette();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    openPalette();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    openPalette();
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('typing filters navigation and triggers a debounced ticket search', async () => {
    list.mockResolvedValue({
      data: { items: [{ id: 7, displayRef: 'TP-7', subject: 'Printer on fire', status: 'Open', requester: { name: 'Ana' } }] },
    });
    renderPalette();
    openPalette();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'printer' } });
    await waitFor(() => expect(list).toHaveBeenCalledWith({ q: 'printer', pageSize: 7 }));
    expect(await screen.findByRole('option', { name: /Printer on fire/ })).toBeInTheDocument();
    // nav items that don't match the query are filtered out
    expect(screen.queryByRole('option', { name: /Dashboard/ })).not.toBeInTheDocument();
  });

  test('agents only see agent-safe destinations', () => {
    authState.user = { email: 'agent@x.com', role: 'agent' };
    renderPalette();
    openPalette();
    expect(screen.getByRole('option', { name: /My Competencies/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Assignment Review/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Dashboard/ })).not.toBeInTheDocument();
  });

  test('plain typing on the page (no modifier) never opens it', () => {
    renderPalette();
    fireEvent.keyDown(document, { key: 'k' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
