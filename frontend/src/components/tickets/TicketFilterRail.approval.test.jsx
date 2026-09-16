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

const meta = {
  workspaceId: 1, technicians: [], groups: [], categoryTree: [], actor: { technicianId: 7 },
  approvalCategories: [{ id: 3, name: 'Laptop purchase' }, { id: 9, name: 'Software licence' }],
};

describe('TicketFilterRail approval facet (16 Sep 2026)', () => {
  test('picking a mode and a category writes approval + approvalCategory to the URL', () => {
    render(
      <MemoryRouter initialEntries={['/tickets']}>
        <TicketFilterRail meta={meta} />
        <LocationProbe />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Approvals/ }));
    fireEvent.click(screen.getByLabelText('Waiting for approval'));
    fireEvent.click(screen.getByLabelText('Laptop purchase'));
    const search = new URLSearchParams(screen.getByTestId('search').textContent);
    expect(search.get('approval')).toBe('pending');
    expect(search.get('approvalCategory')).toBe('3');
  });

  test('the active filter shows as removable chips', () => {
    render(
      <MemoryRouter initialEntries={['/tickets?approval=approved&approvalCategory=9']}>
        <TicketFilterRail meta={meta} />
        <LocationProbe />
      </MemoryRouter>,
    );
    expect(screen.getAllByText('Approved').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Software licence').length).toBeGreaterThan(0);
  });
});
