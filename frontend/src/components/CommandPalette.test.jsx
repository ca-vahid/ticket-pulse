/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import CommandPalette from './CommandPalette';

const globalSearch = vi.fn().mockResolvedValue({ data: { sections: {} } });
vi.mock('../services/api', () => ({
  ticketsAPI: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    meta: vi.fn().mockResolvedValue({ data: { technicians: [] } }),
    assign: vi.fn(),
    setStatus: vi.fn(),
    fsUpdate: vi.fn(),
  },
  searchAPI: {
    global: (...a) => globalSearch(...a),
  },
}));

const authState = { isAuthenticated: true, user: { email: 'me@x.com', role: 'coordinator' } };
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => authState }));
vi.mock('../contexts/WorkspaceContext', () => ({ useWorkspace: () => ({ currentWorkspace: { id: 1 } }) }));

afterEach(() => {
  cleanup();
  globalSearch.mockClear();
  globalSearch.mockResolvedValue({ data: { sections: {} } });
  authState.user = { email: 'me@x.com', role: 'coordinator' };
});

const openPalette = () => fireEvent.keyDown(document, { key: 'k', ctrlKey: true });

// Echoes the router location so tests can assert where a result navigated.
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderPalette(path = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <CommandPalette />
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

const FULL_SECTIONS = {
  tickets: [{ id: 7, displayRef: 'TP-7', subject: 'Printer on fire', status: 'Open', requesterName: 'Ana' }],
  tasks: [{ id: 31, title: 'Order toner', status: 'open', dueAt: null, assignedTechName: 'Mehdi', ticket: { id: 7, displayRef: 'TP-7', subject: 'Printer on fire' } }],
  agents: [{ id: 4, name: 'Gaby Printer-Fixer', email: 'gaby@x.com', photoUrl: null, location: 'Vancouver' }],
  requesters: [{ id: 11, name: 'Ana Printers', email: 'ana@x.com', department: 'Geotech', jobTitle: null }],
  departments: [{ name: 'Printing Services' }],
};

const typeQuery = (value = 'printer') =>
  fireEvent.change(screen.getByRole('combobox'), { target: { value } });

describe('CommandPalette', () => {
  test('hidden until Ctrl+K, then shows navigation commands and scope pills', () => {
    renderPalette();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    openPalette();
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Analytics/ })).toBeInTheDocument();
    const pills = screen.getByRole('group', { name: 'Search scope' });
    for (const label of ['All', 'Tickets', 'Tasks', 'Agents', 'Requesters', 'Departments']) {
      expect(pills).toHaveTextContent(label);
    }
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
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

  test('typing triggers a debounced multi-entity search and renders every section', async () => {
    globalSearch.mockResolvedValue({ data: { sections: FULL_SECTIONS } });
    renderPalette();
    openPalette();
    typeQuery();
    await waitFor(() => expect(globalSearch).toHaveBeenCalledWith('printer', undefined));
    // one result per section, each under its own header (the ticket option's
    // accessible name starts with its subject; the task option merely
    // mentions the parent subject in its sub-line)
    expect(await screen.findByRole('option', { name: (n) => n.startsWith('Printer on fire') })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Order toner/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Gaby Printer-Fixer/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Ana Printers/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Printing Services/ })).toBeInTheDocument();
    for (const header of ['Tickets', 'Tasks', 'Agents', 'Requesters', 'Departments']) {
      expect(screen.getByText(header, { selector: 'p' })).toBeInTheDocument();
    }
    // nav items that don't match the query are filtered out
    expect(screen.queryByRole('option', { name: /Dashboard/ })).not.toBeInTheDocument();
  });

  test('a scope pill narrows the request and hides nav/workspace commands', async () => {
    globalSearch.mockResolvedValue({ data: { sections: { tasks: FULL_SECTIONS.tasks } } });
    renderPalette();
    openPalette();
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    expect(screen.getByRole('button', { name: 'Tasks' })).toHaveAttribute('aria-pressed', 'true');
    // scoped + empty query → no nav commands at all
    expect(screen.queryByRole('option', { name: /Analytics/ })).not.toBeInTheDocument();
    typeQuery('toner');
    await waitFor(() => expect(globalSearch).toHaveBeenCalledWith('toner', 'tasks'));
    expect(await screen.findByRole('option', { name: /Order toner/ })).toBeInTheDocument();
    // Back to All restores commands
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(globalSearch).toHaveBeenCalledWith('toner', undefined));
  });

  test('keyboard nav walks across section boundaries and Enter opens the active result', async () => {
    globalSearch.mockResolvedValue({
      data: { sections: { tickets: FULL_SECTIONS.tickets, tasks: FULL_SECTIONS.tasks } },
    });
    renderPalette('/dashboard');
    openPalette();
    fireEvent.click(screen.getByRole('button', { name: 'Tickets' }));
    typeQuery();
    await screen.findByRole('option', { name: (n) => n.startsWith('Printer on fire') });
    const input = screen.getByRole('combobox');
    // scoped mode: items are [ticket, task] — ArrowDown crosses the section line
    expect(screen.getByRole('option', { name: (n) => n.startsWith('Printer on fire') })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Order toner/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Enter' });
    // task → parent ticket's Tasks tab
    expect(screen.getByTestId('location')).toHaveTextContent('/tickets/7?tab=tasks');
  });

  test('requester and department results deep-link into the queue', async () => {
    globalSearch.mockResolvedValue({ data: { sections: { requesters: FULL_SECTIONS.requesters } } });
    renderPalette();
    openPalette();
    typeQuery('ana');
    fireEvent.click(await screen.findByRole('option', { name: /Ana Printers/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/tickets?requesterId=11&requesterName=Ana%20Printers');

    globalSearch.mockResolvedValue({ data: { sections: { departments: FULL_SECTIONS.departments } } });
    openPalette();
    typeQuery('printing');
    fireEvent.click(await screen.findByRole('option', { name: /Printing Services/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/tickets?q=Printing%20Services');
  });

  test('agents only see agent-safe destinations', () => {
    authState.user = { email: 'agent@x.com', role: 'agent' };
    renderPalette();
    openPalette();
    expect(screen.getByRole('option', { name: /My Competencies/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /^Assignment$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Dashboard/ })).not.toBeInTheDocument();
  });

  test('plain typing on the page (no modifier) never opens it', () => {
    renderPalette();
    fireEvent.keyDown(document, { key: 'k' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
