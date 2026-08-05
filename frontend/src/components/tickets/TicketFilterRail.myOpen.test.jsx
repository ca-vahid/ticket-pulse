/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

vi.mock('../../services/api', () => ({
  ticketsAPI: new Proxy({}, { get: () => () => new Promise(() => {}) }),
}));
vi.mock('../../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ activeTypes: [], types: [], defaultType: null, typeByName: () => null, loading: false, refresh: vi.fn() }),
}));

import TicketFilterRail from './TicketFilterRail';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="search">{location.search}</output>;
}

afterEach(cleanup);

describe('TicketFilterRail canned views (QA 08-04 #15)', () => {
  test('"My open" pins an explicit Open,Pending status scope next to the assignee filter', () => {
    render(
      <MemoryRouter initialEntries={['/tickets']}>
        <TicketFilterRail meta={{ workspaceId: 1, technicians: [], groups: [], categoryTree: [], actor: { technicianId: 7 } }} />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'My open' }));

    const search = new URLSearchParams(screen.getByTestId('search').textContent);
    expect(search.get('assignee')).toBe('7');
    // Board and list read the same param — closed cards can never sneak in.
    expect(search.get('status')).toBe('Open,Pending');
  });

  test('"All tickets" view stays status=any (the stat card now mirrors this)', () => {
    render(
      <MemoryRouter initialEntries={['/tickets']}>
        <TicketFilterRail meta={{ workspaceId: 1, technicians: [], groups: [], categoryTree: [], actor: {} }} />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /All tickets/ }));

    const search = new URLSearchParams(screen.getByTestId('search').textContent);
    expect(search.get('status')).toBe('any');
  });
});
