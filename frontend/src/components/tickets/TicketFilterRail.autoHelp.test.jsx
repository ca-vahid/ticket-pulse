/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

// "Auto-help waiting" canned view (plans/AUTO_HELP_PLAN.md): one click puts
// ?parkKind=auto_help (any status) in the URL; Tickets.jsx forwards it to the
// list API, which filters active auto_help parks.
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

const meta = { workspaceId: 1, technicians: [], groups: [], categoryTree: [], actor: { technicianId: 7 } };

describe('TicketFilterRail — Auto-help waiting view', () => {
  test('the view writes parkKind=auto_help and status=any', () => {
    render(
      <MemoryRouter initialEntries={['/tickets']}>
        <TicketFilterRail meta={meta} />
        <LocationProbe />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Auto-help waiting/ }));
    const search = new URLSearchParams(screen.getByTestId('search').textContent);
    expect(search.get('parkKind')).toBe('auto_help');
    expect(search.get('status')).toBe('any');
  });
});
